import { ResponseCache, cacheKey } from "../cache/response-cache";

/** A producer that counts calls, so single-flight can be observed. */
function countingProducer<T>(value: T, delayMs = 0) {
  let calls = 0;
  const produce = async (): Promise<T> => {
    calls += 1;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return value;
  };
  return { produce, calls: () => calls };
}

describe("ResponseCache (#662)", () => {
  describe("hits and misses", () => {
    it("produces on a miss and serves from cache on the next hit", async () => {
      const cache = new ResponseCache({ ttlMs: 1_000, readEpoch: async () => 0 });
      const { produce, calls } = countingProducer({ v: 1 });

      const first = await cache.get("k", produce);
      const second = await cache.get("k", produce);

      expect(calls()).toBe(1);
      expect(second.body).toBe(first.body);
      expect(cache.stats().hits).toBe(1);
      expect(cache.stats().misses).toBe(1);
    });

    it("stores serialized bytes, so a hit costs no serialization", async () => {
      const cache = new ResponseCache({ ttlMs: 1_000, readEpoch: async () => 0 });
      const { body } = await cache.get("k", async () => ({ big: 1n }));
      // A bigint would throw in JSON.stringify; storing bytes means the
      // conversion happens exactly once, at populate time.
      expect(JSON.parse(body)).toEqual({ big: "1" });
    });
  });

  describe("cross-replica invalidation via the shared epoch", () => {
    it("treats an entry as stale once the shared epoch advances", async () => {
      // This is the read-your-own-write guarantee. A write on another replica
      // bumps the epoch, and a TTL alone would keep serving the old value for
      // the rest of its life.
      let epoch = 0;
      const cache = new ResponseCache({
        ttlMs: 60_000,
        readEpoch: async () => epoch,
      });

      const stale = countingProducer("old");
      await cache.get("k", stale.produce);
      expect(JSON.parse((await cache.get("k", stale.produce)).body)).toBe("old");

      // A writer on another replica commits.
      epoch = 1;

      const fresh = countingProducer("new");
      const { body } = await cache.get("k", fresh.produce);
      expect(fresh.calls()).toBe(1);
      expect(JSON.parse(body)).toBe("new");
    });

    it("falls back to TTL behaviour when the epoch cannot be read", async () => {
      // An unreadable epoch must not be read as "still valid", but it also must
      // not take the cache down.
      const cache = new ResponseCache({
        ttlMs: 40,
        readEpoch: async () => {
          throw new Error("table missing");
        },
      });
      const { produce, calls } = countingProducer("v");
      await cache.get("k", produce);
      await cache.get("k", produce);
      expect(calls()).toBe(1);

      await new Promise((r) => setTimeout(r, 60));
      await cache.get("k", produce);
      expect(calls()).toBe(2);
    });
  });

  describe("single-flight", () => {
    it("collapses concurrent misses on one key into a single produce", async () => {
      // The stampede case: without this, a hot key expiring sends every
      // concurrent request to the database at once, multiplying load exactly
      // when the database can least absorb it.
      const cache = new ResponseCache({ ttlMs: 1_000, readEpoch: async () => 0 });
      const { produce, calls } = countingProducer({ v: 1 }, 10);

      const results = await Promise.all([
        cache.get("hot", produce),
        cache.get("hot", produce),
        cache.get("hot", produce),
        cache.get("hot", produce),
      ]);

      expect(calls()).toBe(1);
      expect(results.every((r) => r.body === results[0].body)).toBe(true);
      expect(cache.stats().singleFlightJoins).toBeGreaterThan(0);
    });

    it("does not collapse different keys", async () => {
      const cache = new ResponseCache({ ttlMs: 1_000, readEpoch: async () => 0 });
      const a = countingProducer("a", 5);
      const b = countingProducer("b", 5);
      await Promise.all([cache.get("ka", a.produce), cache.get("kb", b.produce)]);
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
    });
  });

  describe("stale-while-revalidate", () => {
    it("serves the stale value and refreshes in the background", async () => {
      const cache = new ResponseCache({
        ttlMs: 20,
        staleWhileRevalidateMs: 10_000,
        readEpoch: async () => 0,
      });

      const first = countingProducer("v1");
      await cache.get("k", first.produce);

      await new Promise((r) => setTimeout(r, 40));

      const second = countingProducer("v2");
      const { body, stale } = await cache.get("k", second.produce);

      // Served immediately, flagged stale, and the refresh happens off the
      // request path.
      expect(JSON.parse(body)).toBe("v1");
      expect(stale).toBe(true);

      await new Promise((r) => setTimeout(r, 10));
      expect(JSON.parse((await cache.get("k", second.produce)).body)).toBe("v2");
    });

    it("serves the last good value when a refresh fails", async () => {
      const cache = new ResponseCache({
        ttlMs: 20,
        staleWhileRevalidateMs: 10_000,
        readEpoch: async () => 0,
      });

      await cache.get("k", async () => "good");
      await new Promise((r) => setTimeout(r, 40));

      // A blip must not empty the cache and turn every key into a cold miss.
      const failing = countingProducer("never", 1);
      const { body } = await cache.get("k", async () => {
        failing.produce();
        throw new Error("upstream down");
      });
      expect(JSON.parse(body)).toBe("good");
      expect(cache.stats().refreshFailures).toBeGreaterThan(0);
    });

    it("propagates the failure when there is no stale value to fall back to", async () => {
      const cache = new ResponseCache({
        ttlMs: 20,
        staleWhileRevalidateMs: 0,
        readEpoch: async () => 0,
      });
      await expect(
        cache.get("k", async () => {
          throw new Error("upstream down");
        })
      ).rejects.toThrow(/cache populate failed/);
    });

    it("marks a failed-refresh fallback as stale rather than serving it as fresh", async () => {
      // Past the stale window with a refresh that fails: the old bytes are the
      // only thing left to send, but they must be labelled stale. Returning
      // them unflagged would tell the client they are current, which is the
      // exact failure the epoch check exists to prevent.
      const cache = new ResponseCache({
        ttlMs: 10,
        staleWhileRevalidateMs: 5,
        readEpoch: async () => 0,
      });

      await cache.get("k", async () => "old");
      await new Promise((r) => setTimeout(r, 40));

      const { body, stale } = await cache.get("k", async () => {
        throw new Error("upstream down");
      });
      expect(JSON.parse(body)).toBe("old");
      expect(stale).toBe(true);
    });
  });

  describe("capacity", () => {
    it("evicts the oldest entry past maxEntries", async () => {
      const cache = new ResponseCache({ ttlMs: 10_000, maxEntries: 2, readEpoch: async () => 0 });
      await cache.get("a", async () => 1);
      await cache.get("b", async () => 2);
      await cache.get("c", async () => 3);

      expect(cache.stats().size).toBe(2);
      expect(cache.stats().evictions).toBe(1);
      expect(cache.stats().keys.sort()).toEqual(["b", "c"]);
    });
  });

  describe("invalidation", () => {
    it("drops a single key", async () => {
      const cache = new ResponseCache({ ttlMs: 10_000, readEpoch: async () => 0 });
      await cache.get("k", async () => 1);
      expect(cache.invalidate("k")).toBe(true);
      expect(cache.invalidate("k")).toBe(false);
    });

    it("drops every entry at or before an epoch", async () => {
      const cache = new ResponseCache({ ttlMs: 10_000, readEpoch: async () => 0 });
      await cache.get("old", async () => 1);
      expect(cache.invalidateBefore(0)).toBe(1);
      expect(cache.stats().size).toBe(0);
    });

    it("drops keys matching a fragment", async () => {
      const cache = new ResponseCache({ ttlMs: 10_000, readEpoch: async () => 0 });
      await cache.get("search:a=1", async () => 1);
      await cache.get("search:a=2", async () => 2);
      await cache.get("leaderboard:x", async () => 3);
      expect(cache.invalidateMatching("search:")).toBe(2);
      expect(cache.stats().keys).toEqual(["leaderboard:x"]);
    });
  });
});

describe("cacheKey", () => {
  it("is independent of parameter order", () => {
    // {a:1,b:2} and {b:2,a:1} are the same logical request; letting them hash
    // differently would halve the hit rate for no reason.
    expect(cacheKey("search", { a: 1, b: 2 })).toBe(cacheKey("search", { b: 2, a: 1 }));
  });

  it("distinguishes different values", () => {
    expect(cacheKey("search", { q: "a" })).not.toBe(cacheKey("search", { q: "b" }));
  });

  it("renders a bigint param without throwing", () => {
    // A template literal would throw on implicit bigint stringification, and
    // these endpoints are reached with bigint filters.
    expect(cacheKey("posts", { id: 9007199254740993n })).toBe("posts:id=9007199254740993");
  });

  it("omits the separator when there are no params", () => {
    expect(cacheKey("leaderboard", {})).toBe("leaderboard");
  });
});
