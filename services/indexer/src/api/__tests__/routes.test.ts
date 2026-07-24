import request from "supertest";
import { createApp } from "../index";
import { Database } from "../../db";
import { isValidStellarAddress } from "../routes/profiles";

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn().mockResolvedValue(undefined),
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
    addPoolAdmin: jest.fn(),
    removePoolAdmin: jest.fn(),
    getProfile: jest.fn(),
    listPosts: jest.fn(),
    getFollowers: jest.fn(),
    getFollowing: jest.fn(),
    searchPosts: jest.fn(),
    getTokenMetadata: jest.fn(),
    searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
  } as jest.Mocked<Database>;
}

describe("API Routes", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  // ── Health ────────────────────────────────────────────────────────────────

  describe("GET /health", () => {
    it("returns 200 with status ok when DB is reachable", async () => {
      db.getProfile.mockResolvedValueOnce(null);

      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok", db: "ok" });
    });

    it("returns uptime in seconds", async () => {
      db.getProfile.mockResolvedValueOnce(null);

      const res = await request(app).get("/health");
      expect(res.body).toHaveProperty("uptime");
      expect(typeof res.body.uptime).toBe("number");
    });

    it("returns degraded status when DB is unreachable", async () => {
      db.getProfile.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "degraded", db: "unavailable" });
    });
  });

  // ── Correlation IDs ─────────────────────────────────────────────────────

  describe("Correlation IDs", () => {
    const VALID_ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

    it("generates a correlation ID when none is provided", async () => {
      db.getProfile.mockResolvedValueOnce(null);

      const res = await request(app).get(`/api/profiles/${VALID_ADDRESS}`);
      expect(res.headers["x-correlation-id"]).toBeDefined();
      expect(typeof res.headers["x-correlation-id"]).toBe("string");
    });

    it("echoes back the provided correlation ID", async () => {
      db.getProfile.mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/api/profiles/${VALID_ADDRESS}`)
        .set("x-correlation-id", "test-abc-123");
      expect(res.headers["x-correlation-id"]).toBe("test-abc-123");
    });

    it("includes correlation ID in error responses", async () => {
      db.getProfile.mockRejectedValueOnce(new Error("unexpected"));

      const res = await request(app)
        .get(`/api/profiles/${VALID_ADDRESS}`)
        .set("x-correlation-id", "err-id-456");
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: "INTERNAL_ERROR" });
    });
  });

  // ── Profiles ──────────────────────────────────────────────────────────────

  describe("GET /api/profiles/:address", () => {
    const VALID_ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

    it("returns a profile when found", async () => {
      db.getProfile.mockResolvedValueOnce({
        address: VALID_ADDRESS,
        username: "alice",
        creator_token: "GTOKEN",
        updated_ledger: 100,
      });

      const res = await request(app).get(`/api/profiles/${VALID_ADDRESS}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        address: VALID_ADDRESS,
        username: "alice",
        creator_token: "GTOKEN",
        updated_ledger: 100,
      });
    });

    it("returns 404 when profile not found", async () => {
      db.getProfile.mockResolvedValueOnce(null);

      const res = await request(app).get(`/api/profiles/${VALID_ADDRESS}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns 404 for empty address (no route match)", async () => {
      const res = await request(app).get("/api/profiles/");
      expect(res.status).toBe(404);
    });

    it("returns 400 for empty address string", async () => {
      const res = await request(app).get("/api/profiles/%20");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    });

    it("returns 400 for whitespace-only address", async () => {
      const res = await request(app).get("/api/profiles/" + encodeURIComponent("   "));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    });

    it("returns 400 for address too short", async () => {
      const res = await request(app).get("/api/profiles/GABC123");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    });

    it("returns 400 for address not starting with G", async () => {
      const addr = "A" + "B".repeat(55);
      const res = await request(app).get(`/api/profiles/${addr}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    });

    it("returns 400 for address with invalid characters", async () => {
      const addr = "G" + "#".repeat(55);
      const res = await request(app).get(`/api/profiles/${addr}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    });
  });

  describe("isValidStellarAddress", () => {
    it("returns true for a valid 56-char G-prefixed address", () => {
      const addr = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
      expect(isValidStellarAddress(addr)).toBe(true);
    });

    it("returns false for empty string", () => {
      expect(isValidStellarAddress("")).toBe(false);
    });

    it("returns false for address not starting with G", () => {
      expect(isValidStellarAddress("A" + "B".repeat(55))).toBe(false);
    });

    it("returns false for address too short", () => {
      expect(isValidStellarAddress("GABC123")).toBe(false);
    });

    it("returns false for address with invalid characters", () => {
      expect(isValidStellarAddress("G" + "#".repeat(55))).toBe(false);
    });

    it("returns false for non-string input", () => {
      expect(isValidStellarAddress(123 as unknown as string)).toBe(false);
    });
  });

  // ── Posts ─────────────────────────────────────────────────────────────────

  describe("GET /api/posts", () => {
    it("lists posts with default pagination", async () => {
      db.listPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      const res = await request(app).get("/api/posts");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ posts: [], total: 0, limit: 20, offset: 0 });
    });

    it("filters by author", async () => {
      db.listPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      await request(app).get("/api/posts?author=GABC123");
      expect(db.listPosts).toHaveBeenCalledWith(
        expect.objectContaining({ author: "GABC123" })
      );
    });

    it("returns 400 for invalid limit", async () => {
      const res = await request(app).get("/api/posts?limit=-1");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });

    it("returns 400 for limit exceeding max", async () => {
      const res = await request(app).get("/api/posts?limit=101");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED" });
    });

    it("returns 400 for negative offset", async () => {
      const res = await request(app).get("/api/posts?offset=-5");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });
  });

  describe("GET /api/posts/:id", () => {
    it("returns a post by id", async () => {
      db.getPost.mockResolvedValueOnce({
        id: BigInt(42),
        author: "GABC123",
        content: "Hello world",
        content: "Test post content",
        deleted: false,
        tip_total: BigInt(100),
        like_count: BigInt(5),
        created_ledger: 200,
        deleted_ledger: null,
      });

      const res = await request(app).get("/api/posts/42");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "42" });
    });

    it("returns 404 for missing post", async () => {
      db.getPost.mockResolvedValueOnce(null);

      const res = await request(app).get("/api/posts/999");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns 400 for negative id", async () => {
      const res = await request(app).get("/api/posts/-1");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ID" });
    });

    it("returns 400 for non-numeric id", async () => {
      const res = await request(app).get("/api/posts/abc");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ID" });
    });
  });

  // ── Follows ───────────────────────────────────────────────────────────────

  describe("GET /api/follows/:address/followers", () => {
    it("returns followers list", async () => {
      db.getFollowers.mockResolvedValueOnce({ followers: ["GUSER1", "GUSER2"], total: 2 });

      const res = await request(app).get("/api/follows/GABC123/followers");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ address: "GABC123", total: 2, followers: ["GUSER1", "GUSER2"] });
    });

    it("returns empty list when no followers", async () => {
      db.getFollowers.mockResolvedValueOnce({ followers: [], total: 0 });

      const res = await request(app).get("/api/follows/GALONE/followers");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ followers: [], total: 0, has_more: false });
    });

    it("returns 400 for invalid limit", async () => {
      const res = await request(app).get("/api/follows/GABC123/followers?limit=0");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/follows/:address/following", () => {
    it("returns following list", async () => {
      db.getFollowing.mockResolvedValueOnce({ following: ["GUSER3"], total: 1 });

      const res = await request(app).get("/api/follows/GABC123/following");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ address: "GABC123", total: 1, following: ["GUSER3"] });
    });

    it("returns empty list when not following anyone", async () => {
      db.getFollowing.mockResolvedValueOnce({ following: [], total: 0 });

      const res = await request(app).get("/api/follows/GALONE/following");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ following: [], total: 0, has_more: false });
    });
  });

  // ── Pools ─────────────────────────────────────────────────────────────────

  describe("GET /api/pools/:id", () => {
    it("returns a pool when found", async () => {
      db.getPool.mockResolvedValueOnce({
        pool_id: "pool1",
        token: "GTOKEN",
        balance: BigInt(1000),
        admins: ["GADMIN1"],
        threshold: 1,
        created_ledger: 50,
        updated_ledger: 100,
      });
      db.getTokenMetadata.mockResolvedValueOnce({
        name: "TestToken",
        symbol: "TST",
        decimals: 7,
      });

      const res = await request(app).get("/api/pools/pool1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        pool_id: "pool1",
        token: "GTOKEN",
        token_name: "TestToken",
        token_symbol: "TST",
        token_decimals: 7,
      });
    });

    it("returns safe defaults when token metadata is not found", async () => {
      db.getPool.mockResolvedValueOnce({
        pool_id: "pool1",
        token: "GTOKEN",
        balance: BigInt(1000),
        admins: ["GADMIN1"],
        threshold: 1,
        created_ledger: 50,
        updated_ledger: 100,
      });
      db.getTokenMetadata.mockResolvedValueOnce(null);

      const res = await request(app).get("/api/pools/pool1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        pool_id: "pool1",
        token: "GTOKEN",
      });
      expect((res.body as any).token_name).toBeUndefined();
      expect((res.body as any).token_symbol).toBeUndefined();
      expect((res.body as any).token_decimals).toBeUndefined();
    });

    it("returns safe defaults when token metadata lookup throws", async () => {
      db.getPool.mockResolvedValueOnce({
        pool_id: "pool1",
        token: "GTOKEN",
        balance: BigInt(1000),
        admins: ["GADMIN1"],
        threshold: 1,
        created_ledger: 50,
        updated_ledger: 100,
      });
      db.getTokenMetadata.mockRejectedValueOnce(new Error("DB connection lost"));

      const res = await request(app).get("/api/pools/pool1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        pool_id: "pool1",
        token_name: "unknown",
        token_symbol: "UNK",
        token_decimals: 7,
      });
    });

    it("returns 404 for missing pool", async () => {
      db.getPool.mockResolvedValueOnce(null);

      const res = await request(app).get("/api/pools/pool_missing");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns 404 for empty pool id (no route match)", async () => {
      const res = await request(app).get("/api/pools/");
      expect(res.status).toBe(404);
    });
  });

  // ── Search ─────────────────────────────────────────────────────────────────

  describe("POST /api/search/posts", () => {
    it("returns 400 when query is missing", async () => {
      const res = await request(app).post("/api/search/posts").send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });

    it("returns 400 when query is empty string", async () => {
      const res = await request(app).post("/api/search/posts").send({ query: "" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when query is whitespace-only", async () => {
      const res = await request(app).post("/api/search/posts").send({ query: "   " });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });

    it("returns 400 when query exceeds max length", async () => {
      const longQuery = "a".repeat(501);
      const res = await request(app).post("/api/search/posts").send({ query: longQuery });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "QUERY_TOO_LONG" });
    });

    it("returns 400 when limit is non-numeric string", async () => {
      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "test", limit: "abc" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });

    it("returns 400 when offset is non-numeric string", async () => {
      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "test", offset: "abc" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });

    it("returns 400 when limit exceeds maximum", async () => {
      const res = await request(app).post("/api/search/posts").send({ query: "test", limit: 101 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED" });
    });

    it("returns 400 for negative offset", async () => {
      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "test", offset: -1 });
      expect(res.status).toBe(400);
    });

    it("returns 400 when query is a number instead of string", async () => {
      const res = await request(app).post("/api/search/posts").send({ query: 123 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });

    it("returns next_offset and prev_offset in pagination metadata", async () => {
      db.searchPosts.mockResolvedValueOnce({
        posts: [
          { id: 1n, author: "GA", content: "hi", tip_total: 0n, like_count: 0n, created_ledger: 1 },
          { id: 2n, author: "GB", content: "yo", tip_total: 0n, like_count: 0n, created_ledger: 2 },
        ],
        total: 5,
      });

      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "test", limit: 2, offset: 0 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        has_more: true,
        next_offset: 2,
        prev_offset: null,
      });
    });

    it("returns prev_offset when offset > 0", async () => {
      db.searchPosts.mockResolvedValueOnce({
        posts: [
          { id: 3n, author: "GC", content: "hey", tip_total: 0n, like_count: 0n, created_ledger: 3 },
        ],
        total: 5,
      });

      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "test", limit: 2, offset: 2 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        has_more: true,
        next_offset: 3,
        prev_offset: 0,
      });
    });

    it("returns null next_offset and prev_offset on last page", async () => {
      db.searchPosts.mockResolvedValueOnce({
        posts: [
          { id: 5n, author: "GE", content: "last", tip_total: 0n, like_count: 0n, created_ledger: 5 },
        ],
        total: 1,
      });

      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "test", limit: 10, offset: 0 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        has_more: false,
        next_offset: null,
        prev_offset: null,
      });
    });
  });

  // ── BigInt serialization ─────────────────────────────────────────────

  describe("BigInt serialization", () => {
    it("serializes tip_total and like_count as strings in posts list", async () => {
      db.listPosts.mockResolvedValueOnce({
        posts: [
          {
            id: BigInt(1),
            author: "GA",
            content: "hello",
            deleted: false,
            tip_total: BigInt(5000),
            like_count: BigInt(3),
            created_ledger: 100,
            deleted_ledger: null,
          },
        ],
        total: 1,
      });

      const res = await request(app).get("/api/posts");
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.posts[0].tip_total).toBe("5000");
      expect(body.posts[0].like_count).toBe("3");
      expect(typeof body.posts[0].tip_total).toBe("string");
      expect(typeof body.posts[0].like_count).toBe("string");
    });
  });

  // ── Error handler ─────────────────────────────────────────────────────────

  describe("Error handler", () => {
    const VALID_ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

    it("returns 500 when a route handler throws", async () => {
      db.getProfile.mockRejectedValueOnce(new Error("unexpected"));

      const res = await request(app).get(`/api/profiles/${VALID_ADDRESS}`);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("returns 503 DATABASE_UNAVAILABLE for DB connection errors", async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      (err as any).code = "ECONNREFUSED";
      db.getProfile.mockRejectedValueOnce(err);

      const res = await request(app).get(`/api/profiles/${VALID_ADDRESS}`);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    });

    it("handles 404 for unknown routes", async () => {
      const res = await request(app).get("/api/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});
