import { tierFor, tierForRequest, effectivePath, setTierConfig, getTierConfig, DEFAULT_TIER_CONFIG } from "../middleware/rate-limit-tiers";

describe("rate limit tiers (#661)", () => {
  afterEach(() => {
    setTierConfig(DEFAULT_TIER_CONFIG);
  });

  describe("tierFor", () => {
    it("routes search reads to the search tier", () => {
      expect(tierFor("GET", "/api/v1/search")).toBe("search");
      expect(tierFor("GET", "/api/v1/leaderboard")).toBe("search");
      expect(tierFor("GET", "/api/v1/analytics/index")).toBe("search");
    });

    it("routes mutations to the write tier", () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(tierFor(method, "/api/v1/posts")).toBe("write");
      }
    });

    it("treats a write to a search-shaped path as a write", () => {
      // Cost follows the operation, not the path: a POST is a transaction
      // whatever it is addressed to.
      expect(tierFor("POST", "/api/v1/search")).toBe("write");
    });

    it("is case-insensitive on the path and method", () => {
      expect(tierFor("get", "/API/V1/SEARCH")).toBe("search");
    });

    it("returns null for a cheap read so the default budget applies", () => {
      expect(tierFor("GET", "/api/v1/profiles/GABC")).toBeNull();
      expect(tierFor("GET", "/health")).toBeNull();
    });
  });

  describe("effectivePath", () => {
    // Inside `app.use("/search", limiter)`, Express strips the mount point, so
    // req.path is "/" rather than "/api/v1/search". Classifying on it would mean
    // the search tier silently never matches — the limiter would be mounted,
    // look correct, and do nothing.
    it("prefers originalUrl over the mount-relative path", () => {
      const req = { originalUrl: "/api/v1/search?q=stellar", path: "/", method: "GET" } as never;
      expect(effectivePath(req)).toBe("/api/v1/search");
      expect(tierForRequest(req)).toBe("search");
    });

    it("strips the query string", () => {
      // Attacker-controlled and irrelevant to routing.
      const req = { originalUrl: "/api/v1/search?q=a&evil=%20b", path: "/", method: "GET" } as never;
      expect(effectivePath(req)).toBe("/api/v1/search");
    });

    it("falls back to url then path when originalUrl is absent", () => {
      expect(effectivePath({ url: "/api/v1/posts", method: "GET" } as never)).toBe("/api/v1/posts");
      expect(effectivePath({ path: "/api/v1/posts", method: "GET" } as never)).toBe("/api/v1/posts");
    });

    it("still classifies correctly at the app level", () => {
      const req = { originalUrl: "/api/v1/leaderboard", path: "/v1/leaderboard", method: "GET" } as never;
      expect(tierForRequest(req)).toBe("search");
    });
  });

  describe("budgets", () => {
    it("gives the search tier a tighter budget than the general limit", () => {
      // The point of tiering: a full-text query is the most expensive read in
      // the service, so it cannot share a budget with /health.
      expect(DEFAULT_TIER_CONFIG.search.max).toBeLessThan(100);
      expect(DEFAULT_TIER_CONFIG.write.max).toBeLessThan(100);
    });

    it("merges a partial override without resetting the other tier", () => {
      setTierConfig({ search: { windowMs: 1_000, max: 5 } });
      const config = getTierConfig();
      expect(config.search).toEqual({ windowMs: 1_000, max: 5 });
      expect(config.write).toEqual(DEFAULT_TIER_CONFIG.write);
    });
  });
});
