import express from "express";
import request from "supertest";
import { tieredRateLimits, setTierConfig, DEFAULT_TIER_CONFIG } from "../../middleware/rate-limit-tiers";
import { createApp, setRateLimit } from "../index";
import { Database } from "../../db";

const VALID_ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn(),
    getFollow: jest.fn().mockResolvedValue(null),
    insertFollow: jest.fn(),
    deleteFollow: jest.fn(),
    insertPost: jest.fn(),
    markPostDeleted: jest.fn(),
    incrementPostLikeCount: jest.fn(),
    addPostTipTotal: jest.fn(),
    getPost: jest.fn(),
    upsertLike: jest.fn(),
    insertTip: jest.fn(),
    upsertPool: jest.fn(),
    adjustPoolBalance: jest.fn(),
    insertPool: jest.fn(),
    getPool: jest.fn(),
    listPools: jest.fn().mockResolvedValue({ pools: [], total: 0 }),
    addPoolAdmin: jest.fn(),
    removePoolAdmin: jest.fn(),
    getProfile: jest.fn().mockResolvedValue(null),
    listProfiles: jest.fn().mockResolvedValue({ profiles: [], total: 0 }),
    listPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getFollowers: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowing: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    getFollowersAfter: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowingAfter: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getTokenMetadata: jest.fn().mockResolvedValue(null),
  } as jest.Mocked<Database>;
}

describe("Rate Limiting", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it("returns 429 after exceeding the rate limit", async () => {
    setRateLimit(60_000, 3);
    const app = createApp(db);

    const route = `/api/profiles/${VALID_ADDRESS}`;

    // First 3 requests should succeed (profile not found = 404).
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get(route);
      expect(res.status).toBe(404);
    }

    // 4th request should be rate-limited.
    const res = await request(app).get(route);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
  });

  it("includes Retry-After header on rate limit response", async () => {
    setRateLimit(10_000, 1);
    const app = createApp(db);

    const route = `/api/profiles/${VALID_ADDRESS}`;

    await request(app).get(route);
    const res = await request(app).get(route);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("includes standard RateLimit headers", async () => {
    setRateLimit(60_000, 100);
    const app = createApp(db);

    const res = await request(app).get(`/api/profiles/${VALID_ADDRESS}`);

    expect(res.status).toBe(404);
    const hasRateLimitHeader =
      res.headers["ratelimit"] !== undefined ||
      res.headers["x-ratelimit-limit"] !== undefined ||
      res.headers["ratelimit-limit"] !== undefined;
    expect(hasRateLimitHeader).toBe(true);
  });

  it("does not rate limit non-API routes like /health", async () => {
    setRateLimit(60_000, 1);
    const app = createApp(db);

    // Hit a non-API route many times (bypasses the /api rate limiter).
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    }
  });

  it("tracks remaining count correctly", async () => {
    setRateLimit(20_000, 5);
    const app = createApp(db);

    const route = `/api/profiles/${VALID_ADDRESS}`;

    const res1 = await request(app).get(route);
    const remaining1 =
      res1.headers["x-ratelimit-remaining"] ??
      res1.headers["ratelimit-remaining"];
    expect(remaining1).toBeDefined();
    expect(Number(remaining1)).toBe(4);

    const res2 = await request(app).get(route);
    const remaining2 =
      res2.headers["x-ratelimit-remaining"] ??
      res2.headers["ratelimit-remaining"];
    expect(remaining2).toBeDefined();
    expect(Number(remaining2)).toBe(3);
  });
});

describe("per-tier rate-limit headers (BE-038)", () => {
  afterAll(() => setTierConfig(DEFAULT_TIER_CONFIG));

  function tieredApp() {
    const app = express();
    app.use(
      tieredRateLimits({
        config: { search: { windowMs: 60_000, max: 2 }, write: { windowMs: 60_000, max: 1 } },
      })
    );
    app.get("/api/v1/search", (_req, res) => void res.json({ ok: true }));
    app.post("/api/v1/tips", (_req, res) => void res.json({ ok: true }));
    app.get("/api/v1/health", (_req, res) => void res.json({ ok: true }));
    return app;
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  it("reports tier, limit, remaining and reset on allowed search requests", async () => {
    const app = tieredApp();
    const first = await request(app).get("/api/v1/search");
    expect(first.status).toBe(200);
    expect(first.headers["x-ratelimit-tier"]).toBe("search");
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");
    const reset = Number(first.headers["x-ratelimit-reset"]);
    expect(reset).toBeGreaterThan(nowSeconds());
    expect(reset).toBeLessThanOrEqual(nowSeconds() + 61);

    const second = await request(app).get("/api/v1/search");
    expect(second.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("reports the same headers plus Retry-After when the search tier throttles", async () => {
    const app = tieredApp();
    await request(app).get("/api/v1/search");
    await request(app).get("/api/v1/search");
    const throttled = await request(app).get("/api/v1/search");
    expect(throttled.status).toBe(429);
    expect(throttled.headers["x-ratelimit-tier"]).toBe("search");
    expect(throttled.headers["x-ratelimit-limit"]).toBe("2");
    expect(throttled.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(throttled.headers["x-ratelimit-reset"])).toBeGreaterThan(nowSeconds());
    const retryAfter = Number(throttled.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(throttled.body).toMatchObject({ code: "RATE_LIMIT_TIER_EXCEEDED", tier: "search", retry_after: retryAfter });
  });

  it("reports headers for the write tier, allowed then throttled", async () => {
    const app = tieredApp();
    const allowed = await request(app).post("/api/v1/tips");
    expect(allowed.status).toBe(200);
    expect(allowed.headers["x-ratelimit-tier"]).toBe("write");
    expect(allowed.headers["x-ratelimit-limit"]).toBe("1");
    expect(allowed.headers["x-ratelimit-remaining"]).toBe("0");

    const throttled = await request(app).post("/api/v1/tips");
    expect(throttled.status).toBe(429);
    expect(throttled.headers["x-ratelimit-tier"]).toBe("write");
    expect(throttled.headers["x-ratelimit-remaining"]).toBe("0");
    expect(throttled.headers["retry-after"]).toBeDefined();
  });

  it("keeps the tiers' budgets separate", async () => {
    const app = tieredApp();
    await request(app).post("/api/v1/tips");
    const search = await request(app).get("/api/v1/search");
    expect(search.status).toBe(200);
    expect(search.headers["x-ratelimit-remaining"]).toBe("1");
  });

  it("adds no tier headers to requests outside every tier", async () => {
    const res = await request(tieredApp()).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-tier"]).toBeUndefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
  });
});
