import request from "supertest";
import { createApp, setRateLimit } from "../index";
import { Database } from "../../db";

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn(),
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
    addPoolAdmin: jest.fn(),
    removePoolAdmin: jest.fn(),
    getProfile: jest.fn().mockResolvedValue(null),
    listPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getFollowers: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowing: jest.fn().mockResolvedValue({ following: [], total: 0 }),
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

    const route = "/api/profiles/test";

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

    const route = "/api/profiles/test";

    await request(app).get(route);
    const res = await request(app).get(route);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("includes standard RateLimit headers", async () => {
    setRateLimit(60_000, 100);
    const app = createApp(db);

    const res = await request(app).get("/api/profiles/test");

    expect(res.status).toBe(404);
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
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

    const route = "/api/profiles/test";

    const res1 = await request(app).get(route);
    const match1 = (res1.headers["ratelimit"] as string)?.match(/remaining=(\d+)/);
    expect(match1).toBeTruthy();
    expect(Number(match1![1])).toBe(4);

    const res2 = await request(app).get(route);
    const match2 = (res2.headers["ratelimit"] as string)?.match(/remaining=(\d+)/);
    expect(match2).toBeTruthy();
    expect(Number(match2![1])).toBe(3);
  });
});
