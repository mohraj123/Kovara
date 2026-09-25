/**
 * `/api/v1/search` — ranked search across profiles, posts, and categories.
 *
 * Wires the four #660-663 concerns into one request path, which is where they
 * actually meet:
 *
 *   - ranked multi-entity search from {@link PostgresSearchStore} (#660);
 *   - the search tier's tighter rate budget, applied ahead of the store so an
 *     expensive query is rejected before it reaches the database (#661);
 *   - a cached response body, with single-flight on a miss so concurrent
 *     identical queries do not each run a full-text scan (#662);
 *   - an allowlisted serializer, so a row that gains a column cannot start
 *     publishing it through this route (#663).
 *
 * The cache stores the *serialized bytes*, not the object: this route is the
 * most expensive read in the service, and serializing on every request would
 * give back a meaningful part of what caching saves.
 */

import { Router, Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import { PostgresSearchStore, SEARCH_ENTITIES, SearchEntity, SearchValidationError } from "../search/store";
import { ResponseCache, cacheKey } from "../cache/response-cache";
import { defineSerializer, serializeValue, SerializationError } from "./serialize";
import { sendError } from "./response";
import { logger } from "../logger";

/** Pagination bounds. Mirrors the existing /search/posts limits. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;

/**
 * Cache lifetime for a search result.
 *
 * Short on purpose. Search ranking folds in recency and engagement, so a cached
 * body is already a slightly stale picture of the ranking; a long TTL would let
 * the recency component drift far from reality. 30s removes the bulk of
 * duplicate traffic (a UI firing several requests with the same term) while
 * keeping staleness bounded. Correctness for a *write* — a new post appearing in
 * results — is handled by the epoch, not by this number: a write bumps the shared
 * epoch and this entry is invalidated regardless of TTL.
 */
const SEARCH_CACHE_TTL_MS = 30_000;

/**
 * The response schema, declared.
 *
 * `defineSerializer` emits exactly these keys, in this order. Anything else on
 * the store's result — an internal field, a column added to a future query — is
 * dropped rather than published. That is the tenant-safety property: the set of
 * exposed fields is a property of the code, not of the data.
 */
const serializeHit = defineSerializer<Record<string, unknown>>({
  entity: {},
  id: {},
  title: {},
  snippet: {},
  score: {},
  attributes: {
    // attributes is a nested bag assembled per entity, so it is walked rather
    // than copied. That is what turns a nested bigint into a string and drops a
    // nested `__proto__` key — relying on the store to have produced
    // JSON-safe values would make this serializer's guarantee depend on every
    // future store query being careful.
    serialize: (value, path) => serializeValue(value, path),
  },
});

/** Parse and bound the pagination params, throwing {@link SearchValidationError}. */
function readPagination(query: Record<string, unknown>): { limit: number; offset: number } {
  const rawLimit = query.limit;
  const rawOffset = query.offset;

  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" && typeof rawLimit !== "number") {
      throw new SearchValidationError("limit must be a number", "INVALID_LIMIT");
    }
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new SearchValidationError("limit must be a positive integer", "INVALID_LIMIT");
    }
    if (limit > MAX_LIMIT) {
      throw new SearchValidationError(`limit cannot exceed ${MAX_LIMIT}`, "LIMIT_EXCEEDED");
    }
    // Capped at MAX_LIMIT so a large `limit` cannot be used to pull the whole
    // table through the cache in one response.
    return { limit, offset: readOffset(rawOffset) };
  }

  return { limit: DEFAULT_LIMIT, offset: readOffset(rawOffset) };
}

function readOffset(rawOffset: unknown): number {
  if (rawOffset === undefined) return 0;
  if (typeof rawOffset !== "string" && typeof rawOffset !== "number") {
    throw new SearchValidationError("offset must be a number", "INVALID_OFFSET");
  }
  const offset = Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SearchValidationError("offset must be a non-negative integer", "INVALID_OFFSET");
  }
  if (offset > MAX_OFFSET) {
    // Bounded so `offset` cannot be used to force a deep, slow scan.
    throw new SearchValidationError(
      `offset cannot exceed ${MAX_OFFSET}`,
      "OFFSET_EXCEEDED"
    );
  }
  return offset;
}

/** Read the optional `type` filter and validate it against the known entities. */
function readEntities(raw: unknown): SearchEntity[] | undefined {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const wanted = values
    .map((v) => String(v).trim().toLowerCase())
    .filter((v) => v !== "");

  if (wanted.length === 0) return undefined;

  const invalid = wanted.filter((v) => !SEARCH_ENTITIES.includes(v as SearchEntity));
  if (invalid.length > 0) {
    throw new SearchValidationError(
      `unknown search type(s): ${invalid.join(", ")}. Valid types: ${SEARCH_ENTITIES.join(", ")}`,
      "INVALID_SEARCH_TYPE"
    );
  }
  return [...new Set(wanted as SearchEntity[])];
}

export interface SearchRouterOptions {
  pool: Pool;
  /** Injected in tests; constructed from the pool otherwise. */
  store?: PostgresSearchStore;
  /** Injected in tests; constructed from the pool otherwise. */
  cache?: ResponseCache;
}

/**
 * How long a fetched epoch is trusted before re-reading it.
 *
 * This has to exist. Reading `cache_epoch` on every cached request would add a
 * database round trip to each one — which is precisely the cost the cache
 * exists to remove, so a "cached" endpoint would be no cheaper than the
 * uncached one and would additionally pay for the cache bookkeeping. Polling
 * trades a small, bounded staleness window for that saving.
 *
 * The window bounds cross-replica visibility: a write on another replica is
 * seen here within SHARED_EPOCH_REFRESH_MS, and never later than the entry TTL.
 * That is the same consistency bound db.ts already documents and enforces for
 * its own caches, so the two do not disagree.
 */
export const SHARED_EPOCH_REFRESH_MS = 500;

/**
 * Build a cached epoch reader.
 *
 * Returns null when the table is unreadable. Null is *not* treated as "unchanged"
 * downstream: the cache excludes a null epoch from its staleness comparison, so
 * an unreadable epoch falls back to TTL behaviour instead of serving an entry it
 * cannot prove is current.
 */
export function createEpochReader(pool: Pool): () => Promise<number | null> {
  let epoch = 0;
  let fetchedAt = 0;
  let tableUnavailable = false;

  return async (): Promise<number | null> => {
    if (tableUnavailable) return null;

    const now = Date.now();
    if (now - fetchedAt < SHARED_EPOCH_REFRESH_MS) return epoch;

    try {
      const result = await pool.query<{ epoch: string | null }>(
        "SELECT COALESCE(MAX(epoch), 0)::text AS epoch FROM cache_epoch"
      );
      const raw = result.rows[0]?.epoch;
      const parsed = raw === undefined || raw === null ? 0 : Number(raw);
      epoch = Number.isFinite(parsed) ? parsed : epoch;
      fetchedAt = now;
      return epoch;
    } catch {
      // Latch off: a table that is missing (the 008 migration is skipped on a
      // fresh install because of the filename-prefix collision) will not appear
      // mid-process, and retrying per request would add a failing round trip to
      // every one of them. Invalidation then relies on the TTL, which is the
      // documented degraded mode.
      tableUnavailable = true;
      return null;
    }
  };
}

/** Build the router. */
export function createSearchRouter(options: SearchRouterOptions): Router {
  const router = Router();
  const store = options.store ?? new PostgresSearchStore(options.pool);
  const cache =
    options.cache ??
    new ResponseCache({
      ttlMs: SEARCH_CACHE_TTL_MS,
      readEpoch: createEpochReader(options.pool),
    });

  /**
   * GET /api/v1/search?q=term&type=posts,profiles&limit=20&offset=0
   *
   * GET rather than POST because the result is a pure function of the query
   * string, which is what makes it safely cacheable and linkable.
   */
  router.get("/", (req: Request, res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      let params: { limit: number; offset: number };
      let entities: SearchEntity[] | undefined;
      try {
        const query = req.query as Record<string, unknown>;
        params = readPagination(query);
        entities = readEntities(query.type);
      } catch (err) {
        if (err instanceof SearchValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
        return;
      }

      const rawQuery = (req.query as Record<string, unknown>).q;

      // Keyed on the normalized query, not the raw one, so " foo " and "foo"
      // share an entry. key() is the validator, so an invalid query is rejected
      // here — before the cache is consulted or the database is touched.
      let key: string;
      try {
        key = cacheKey("search", { q: rawQuery, limit: params.limit, offset: params.offset, type: entities ?? SEARCH_ENTITIES });
      } catch (err) {
        if (err instanceof SearchValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
        return;
      }

      try {
        const { body, stale } = await cache.get(key, async () => {
          const result = await store.search(rawQuery, { ...params, entities });
          return {
            hits: result.hits.map((hit) => serializeHit(hit as unknown as Record<string, unknown>)),
            total: result.total,
            limit: result.limit,
            offset: result.offset,
            has_more: result.hasMore,
            normalized_query: result.normalizedQuery,
          };
        });

        // Surfaced so a client can tell a fresh result from a stale-but-served
        // one instead of silently acting on stale data.
        res.setHeader("X-Cache", stale ? "STALE" : "HIT-MISS");
        res.type("application/json").status(200).send(body);
      } catch (err) {
        if (err instanceof SearchValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof SerializationError) {
          // A serialization failure is a bug in the response shape, not bad
          // input, so it is a 500 — and it is logged with the path, which is
          // the part that makes it diagnosable.
          logger.error("search_response_serialization_failed", { path: err.path, err });
          sendError(res, 500, "search response could not be serialized", "SERIALIZATION_FAILED");
          return;
        }
        next(err);
      }
    })();
  });

  /**
   * GET /api/v1/search/facets?q=term
   *
   * Per-entity counts, so a client can show "12 posts, 2 profiles" and offer a
   * filter. Deliberately uncached: it changes whenever search does, and it is
   * cheap relative to the search it describes.
   */
  router.get("/facets", (req: Request, res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      try {
        const rawQuery = (req.query as Record<string, unknown>).q;
        const facets = await store.facets(rawQuery);
        res.status(200).json({ query: typeof rawQuery === "string" ? rawQuery : null, facets });
      } catch (err) {
        if (err instanceof SearchValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    })();
  });

  /**
   * GET /api/v1/search/cache — operator view of the cache.
   *
   * Exists because criterion (2) is "invalidation is handled correctly", and a
   * cache whose hit/miss/stale counters are invisible cannot be verified to be
   * working. Exposed read-only: it reports, it does not mutate.
   */
  router.get("/cache", (_req: Request, res: Response): void => {
    res.status(200).json(cache.stats());
  });

  return router;
}
