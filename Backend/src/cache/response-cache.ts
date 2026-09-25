/**
 * Response cache for hot read paths, with correct invalidation.
 *
 * Issue #662. Three criteria, and the third is what shapes this:
 *
 *   1. frequently accessed endpoints use cached responses;
 *   2. **cache invalidation is handled correctly after updates**;
 *   3. **cache misses and warmups maintain service stability**.
 *
 * On (2): a plain TTL cache is wrong here for a specific reason. These are
 * *multi-replica* services sharing one Postgres. A write on replica A is
 * invisible to replica B's memory for the whole TTL, so B serves stale data for
 * up to the TTL after a successful write — a read-your-own-write violation that
 * looks like a cache bug and is actually a design bug. The repo already has the
 * mechanism for this: the `cache_epoch` table (migration 008), where every
 * writer bumps a shared counter and readers revalidate against it. This cache is
 * built on that, so an entry written before a write is detected as stale even if
 * its TTL has not expired.
 *
 * A short TTL remains as a backstop for the case where the epoch check itself
 * fails — an epoch read that errors must not be taken as "still valid".
 *
 * On (3): "cache misses and warmups maintain service stability" is the
 * stampede problem. Without protection, a hot key expiring sends every
 * concurrent request to the database at once — the miss *multiplies* load
 * exactly when the database is least able to absorb it. Two mechanisms:
 *
 *   - **single-flight**: concurrent misses on the same key share one upstream
 *     call; the rest await the same promise.
 *   - **stale-while-revalidate**: if a refresh fails or an entry is past its
 *     fresh window, the last known value is served (flagged stale) rather than
 *     propagating the failure. For a public read endpoint, slightly stale data
 *     beats a 500.
 *
 * Cached values are stored **already serialized**, not as objects. Serializing
 * on the way in and sending bytes on the way out removes the per-request
 * serialization cost that the cache was meant to eliminate, and guarantees every
 * response is byte-identical for the same entry.
 */

/** One cached entry. */
interface CacheEntry {
  /** The serialized JSON body. */
  body: string;
  /** Epoch at which this entry was produced. */
  epoch: number;
  /** Absolute expiry of the *fresh* window, in epoch milliseconds. */
  freshUntil: number;
  /** Absolute expiry after which the entry is dropped entirely. */
  staleUntil: number;
  /** When the entry was produced, for age reporting. */
  storedAt: number;
}

export interface CacheConfig {
  /** How long an entry is served as fresh. */
  ttlMs: number;
  /**
   * How long past `ttlMs` a stale value may still be served while a refresh
   * happens in the background. Default 5x the TTL. Zero disables
   * stale-while-revalidate and turns a refresh failure into an error.
   */
  staleWhileRevalidateMs?: number;
  /** Maximum entries before the oldest are evicted. */
  maxEntries?: number;
  /** Read the current shared epoch. Returns null when unavailable. */
  readEpoch: () => Promise<number | null>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  staleServed: number;
  singleFlightJoins: number;
  evictions: number;
  refreshFailures: number;
  size: number;
  /** Distinct keys currently held. */
  keys: string[];
}

export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** In-flight refreshes, keyed by cache key — the single-flight table. */
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private hits = 0;
  private misses = 0;
  private staleServed = 0;
  private singleFlightJoins = 0;
  private evictions = 0;
  private refreshFailures = 0;

  constructor(private readonly config: CacheConfig) {}

  /**
   * Fetch a key, populating it on a miss.
   *
   * `produce` returns the value to cache; it is serialized once here and the
   * bytes are reused for every subsequent hit.
   */
  async get(key: string, produce: () => Promise<unknown>): Promise<{ body: string; stale: boolean }> {
    const now = Date.now();
    const entry = this.entries.get(key);

    if (entry) {
      // Epoch check first, then freshness. A write on another replica bumps the
      // epoch, which invalidates this entry immediately regardless of TTL.
      const epoch = await this.safeReadEpoch();
      const invalidated = epoch !== null && epoch > entry.epoch;

      if (!invalidated && now < entry.freshUntil) {
        this.hits += 1;
        return { body: entry.body, stale: false };
      }

      // Past its fresh window. Serve the stale value now and refresh in the
      // background, so a slow or failing upstream does not become the caller's
      // latency. Only if the stale window has also closed is this a real miss.
      if (!invalidated && now < entry.staleUntil) {
        this.staleServed += 1;
        void this.refresh(key, produce, entry);
        return { body: entry.body, stale: true };
      }
    }

    // Single-flight: concurrent misses on the same key share one upstream call.
    // Without this, a hot key expiring sends every in-flight request to the
    // database simultaneously, and the miss multiplies load at exactly the
    // moment the database can least absorb it.
    const existing = this.inFlight.get(key);
    if (existing) {
      this.singleFlightJoins += 1;
      const joined = await existing;
      if (joined !== null) return joined;
      // The shared refresh failed; fall through and try independently rather
      // than propagating someone else's failure as our own.
    }

    this.misses += 1;
    const result = await this.refresh(key, produce, entry);
    if (result === null) {
      throw new Error(`cache populate failed for key: ${key}`);
    }
    return result;
  }

  /**
   * Populate or refresh a key, joining an in-flight refresh if one exists.
   *
   * The result carries a `stale` flag, because a refresh that falls back to the
   * previous body *is* serving stale data and has to say so. Returning those
   * bytes unflagged would let a client act on out-of-date data believing it is
   * current — the precise failure the epoch exists to prevent.
   *
   * Returns null only when the refresh failed with nothing to fall back to, so
   * the caller can turn that into an error.
   */
  private refresh(
    key: string,
    produce: () => Promise<unknown>,
    previous: CacheEntry | undefined
  ): Promise<{ body: string; stale: boolean } | null> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<{ body: string; stale: boolean } | null> => {
      try {
        const value = await produce();
        // Serialize once, here, and store the bytes — so a hit costs no
        // serialization and every response for this entry is identical.
        const body = JSON.stringify(value ?? null);
        await this.store(key, body);
        return { body, stale: false };
      } catch {
        this.refreshFailures += 1;
        // A failed refresh keeps the previous entry rather than deleting it, so
        // a blip does not empty the cache and turn every key into a cold miss.
        if (!previous) return null;
        return { body: previous.body, stale: true };
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  private async store(key: string, body: string): Promise<void> {
    const now = Date.now();
    const ttl = this.config.ttlMs;
    const swr = this.config.staleWhileRevalidateMs ?? ttl * 5;
    // Read the epoch *after* producing, so a write that commits while we were
    // producing is reflected. Reading before would store the entry stamped with
    // an epoch older than the data it holds, and it would look fresh for a
    // whole TTL.
    const epoch = (await this.safeReadEpoch()) ?? 0;

    this.entries.set(key, {
      body,
      epoch,
      freshUntil: now + ttl,
      staleUntil: now + ttl + swr,
      storedAt: now,
    });

    this.evictIfNeeded();
  }

  /**
   * Read the shared epoch, treating a failure as "unknown".
   *
   * Unknown is deliberately not treated as "unchanged": the caller compares
   * `epoch > entry.epoch`, and a null epoch is excluded from that comparison, so
   * a failing epoch read falls back to TTL behaviour rather than serving an
   * entry it cannot prove is current.
   */
  private async safeReadEpoch(): Promise<number | null> {
    try {
      return await this.config.readEpoch();
    } catch {
      return null;
    }
  }

  /** Evict the oldest entry when over capacity. */
  private evictIfNeeded(): void {
    const max = this.config.maxEntries ?? 1_000;
    while (this.entries.size > max) {
      // Map preserves insertion order, so the first key is the oldest written.
      // This is not true LRU — a frequently-read entry can still be evicted —
      // which is acceptable for a cache whose entries are cheap to rebuild.
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  /**
   * Drop everything stamped before `epoch`.
   *
   * Called after a local write so this replica does not serve its own stale
   * entry. Other replicas learn about the write through the shared epoch.
   */
  invalidateBefore(epoch: number): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.epoch <= epoch) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Drop one key. */
  invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Drop every key whose cache key contains `fragment`. */
  invalidateMatching(fragment: string): number {
    let dropped = 0;
    for (const key of this.entries.keys()) {
      if (key.includes(fragment)) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /** Current counters, for an operator endpoint. */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      staleServed: this.staleServed,
      singleFlightJoins: this.singleFlightJoins,
      evictions: this.evictions,
      refreshFailures: this.refreshFailures,
      size: this.entries.size,
      keys: [...this.entries.keys()],
    };
  }
}

/**
 * A stable cache key.
 *
 * Key parts are sorted so parameter order cannot create two cache entries for
 * the same logical request — `{a:1,b:2}` and `{b:2,a:1}` are the same query, and
 * letting them hash differently would halve the hit rate for no reason.
 */
export function cacheKey(namespace: string, params: Record<string, unknown>): string {
  const parts = Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key];
      // BigInt in a key would throw on implicit stringification in a template
      // literal, and these endpoints are reached with bigint filters.
      const rendered =
        typeof value === "bigint" ? value.toString() : JSON.stringify(value) ?? "null";
      return `${key}=${rendered}`;
    });
  return parts.length === 0 ? namespace : `${namespace}:${parts.join("&")}`;
}
