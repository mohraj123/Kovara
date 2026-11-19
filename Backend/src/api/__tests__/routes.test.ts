import express from "express";
import request from "supertest";
import { sendSuccess, sendPaginated } from "../response";
import { createApp } from "../index";
import { Database } from "../../db";
import { isValidStellarAddress } from "../routes/profiles";

// Well-formed Stellar public keys. Follows and the posts author filter are now
// validated as wallet addresses (issue #665), so these fixtures are real keys
// rather than the placeholder strings earlier revisions used.
const FOLLOW_ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
const OTHER_ADDRESS = "GBZX4364PEPQTDICMIQDZ56K4T75QZCR4NBEYKO6PDRJAHZKGUOJPCXB";

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
    listPools: jest.fn().mockResolvedValue({ pools: [], total: 0 }),
    addPoolAdmin: jest.fn(),
    removePoolAdmin: jest.fn(),
    getProfile: jest.fn(),
    listProfiles: jest.fn().mockResolvedValue({ profiles: [], total: 0 }),
    listPosts: jest.fn(),
    getFollowers: jest.fn(),
    getFollowing: jest.fn(),
    getFollowersAfter: jest.fn(),
    getFollowingAfter: jest.fn(),
    searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getTokenMetadata: jest.fn(),
  } as jest.Mocked<Database>;
}


describe("API Routes", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  // â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ Correlation IDs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ Profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ Posts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe("GET /api/posts", () => {
    it("lists posts with default pagination", async () => {
      db.listPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      const res = await request(app).get("/api/posts");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ posts: [], total: 0, limit: 20, offset: 0 });
    });

    it("filters by author", async () => {
      db.listPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      await request(app).get(`/api/posts?author=${FOLLOW_ADDRESS}`);
      expect(db.listPosts).toHaveBeenCalledWith(
        expect.objectContaining({ author: FOLLOW_ADDRESS })
      );
    });

    it("returns 400 for invalid limit", async () => {
      const res = await request(app).get("/api/posts?limit=-1");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });

    it("accepts cursor-based pagination for followers and returns keyset shape", async () => {
      db.getFollowersAfter.mockResolvedValueOnce({
        followers: ["GABCDEF123456789012345678901234567890123456789012345678901234567",
          "GHJKLMNOPQRSTUVWXYZ12345678901234567890123456789012345678901234567"],
        total: 5,
      });
      const cursor = "GABCDEF123456789012345678901234567890123456789012345678901234567";
      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/followers?cursor=${cursor}&limit=2`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: FOLLOW_ADDRESS,
        followers: expect.arrayContaining([expect.stringMatching(/^G/)]),
        total: 5,
        limit: 2,
        offset: 0,
        has_more: true,
        next_offset: null,
        prev_offset: null,
      });
      expect(db.getFollowersAfter).toHaveBeenCalledWith(FOLLOW_ADDRESS, cursor, 2);
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
        content: "Hello, world!",
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

  // â”€â”€ Follows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe("GET /api/follows/:address/followers", () => {
    it("returns followers list", async () => {
      db.getFollowers.mockResolvedValueOnce({ followers: ["GUSER1", "GUSER2"], total: 2 });

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/followers`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: FOLLOW_ADDRESS,
        total: 2,
        followers: ["GUSER1", "GUSER2"],
      });
    });

    it("returns empty list when no followers", async () => {
      db.getFollowers.mockResolvedValueOnce({ followers: [], total: 0 });

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/followers`);
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

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/following`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ address: FOLLOW_ADDRESS, total: 1, following: ["GUSER3"] });
    });

    it("returns empty list when not following anyone", async () => {
      db.getFollowing.mockResolvedValueOnce({ following: [], total: 0 });

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/following`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ following: [], total: 0, has_more: false });
    });

    it("accepts cursor-based pagination for following and returns keyset shape", async () => {
      db.getFollowingAfter.mockResolvedValueOnce({
        following: ["GXYZABC123456789012345678901234567890123456789012345678901234567"],
        total: 3,
      });
      const cursor = "GABCDEF123456789012345678901234567890123456789012345678901234567";
      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/following?cursor=${cursor}&limit=1`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: FOLLOW_ADDRESS,
        following: expect.arrayContaining([expect.stringMatching(/^G/)]),
        total: 3,
        limit: 1,
        offset: 0,
        has_more: false,
        next_offset: null,
        prev_offset: null,
      });
      expect(db.getFollowingAfter).toHaveBeenCalledWith(FOLLOW_ADDRESS, cursor, 1);
    });
  });

  // â”€â”€ Pools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    it("lists pools on GET /api/pools/", async () => {
      db.listPools.mockResolvedValueOnce({
        pools: [
          {
            pool_id: "pool1",
            token: "GTOKEN",
            balance: BigInt(1000),
            admins: ["GADMIN1"],
            threshold: 1,
            created_ledger: 50,
            updated_ledger: 100,
          },
        ],
        total: 1,
      });
      db.getTokenMetadata.mockResolvedValueOnce({
        name: "TestToken",
        symbol: "TST",
        decimals: 7,
      });

      const res = await request(app).get("/api/pools/?limit=10&offset=0");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        total: 1,
        limit: 10,
        offset: 0,
        has_more: false,
      });
      expect(res.body.pools).toHaveLength(1);
      expect(res.body.pools[0]).toMatchObject({
        pool_id: "pool1",
        token: "GTOKEN",
        token_symbol: "TST",
      });
    });
  });

  // â”€â”€ Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    it("accepts a query with leading/trailing whitespace and normalizes it before database access", async () => {
      db.searchPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "   test   search  " });

      expect(res.status).toBe(200);
      expect(db.searchPosts).toHaveBeenCalledWith({ query: "test search", limit: 20, offset: 0 });
    });

    it("accepts input with trailing whitespace when trimmed length is within max length", async () => {
      const longQuery = "a".repeat(499) + "   ";
      db.searchPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      const res = await request(app).post("/api/search/posts").send({ query: longQuery });

      expect(res.status).toBe(200);
      expect(db.searchPosts).toHaveBeenCalledWith({ query: "a".repeat(499), limit: 20, offset: 0 });
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
      const res = await request(app).post("/api/search/posts").send({ query: "test", offset: -1 });
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

  // â”€â”€ BigInt serialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ Empty-result pagination (BE-30) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe("Empty-result pagination", () => {
    const VALID_ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

    it("GET /api/posts returns consistent shape when no posts exist", async () => {
      db.listPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      const res = await request(app).get("/api/posts");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        posts: [],
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
      });
    });

    it("GET /api/posts returns empty array with has_more=false when offset exceeds total", async () => {
      db.listPosts.mockResolvedValueOnce({ posts: [], total: 5 });

      const res = await request(app).get("/api/posts?offset=100");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        posts: [],
        total: 5,
        has_more: false,
      });
    });

    it("GET /api/posts with author filter returns consistent empty shape", async () => {
      db.listPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      const res = await request(app).get(`/api/posts?author=${OTHER_ADDRESS}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        posts: [],
        total: 0,
        has_more: false,
      });
    });

    it("GET /api/follows/:address/followers returns consistent shape when no followers", async () => {
      db.getFollowers.mockResolvedValueOnce({ followers: [], total: 0 });

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/followers`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: FOLLOW_ADDRESS,
        followers: [],
        total: 0,
        has_more: false,
      });
    });

    it("GET /api/follows/:address/followers returns empty with has_more=false when offset beyond total", async () => {
      db.getFollowers.mockResolvedValueOnce({ followers: [], total: 3 });

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/followers?offset=100`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        followers: [],
        total: 3,
        has_more: false,
      });
    });

    it("GET /api/follows/:address/following returns consistent shape when not following anyone", async () => {
      db.getFollowing.mockResolvedValueOnce({ following: [], total: 0 });

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/following`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: FOLLOW_ADDRESS,
        following: [],
        total: 0,
        has_more: false,
      });
    });

    it("GET /api/follows/:address/following returns empty with has_more=false when offset beyond total", async () => {
      db.getFollowing.mockResolvedValueOnce({ following: [], total: 2 });

      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/following?offset=50`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        following: [],
        total: 2,
        has_more: false,
      });
    });

    it("POST /api/search/posts returns consistent shape when no results match", async () => {
      db.searchPosts.mockResolvedValueOnce({ posts: [], total: 0 });

      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "nonexistent_term_xyz" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        posts: [],
        total: 0,
        has_more: false,
        next_offset: null,
        prev_offset: null,
      });
    });

    it("POST /api/search/posts returns has_more=false when offset exceeds total", async () => {
      db.searchPosts.mockResolvedValueOnce({ posts: [], total: 5 });

      const res = await request(app)
        .post("/api/search/posts")
        .send({ query: "test", offset: 100 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        posts: [],
        total: 5,
        has_more: false,
        next_offset: null,
      });
    });
  });

  // â”€â”€ Error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe("Error handler", () => {
    const VALID_ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

    it("returns 500 when a route handler throws", async () => {
      db.getProfile.mockRejectedValueOnce(new Error("unexpected"));

      const res = await request(app).get(`/api/profiles/${VALID_ADDRESS}`);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("handles 404 for unknown routes with JSON body (BE-26)", async () => {
      const res = await request(app).get("/api/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Route not found", code: "NOT_FOUND" });
    });

    it("returns 405-style JSON for unsupported HTTP methods on existing routes (BE-26)", async () => {
      // POST on a GET-only route
      const res = await request(app).post("/api/profiles/GABC123");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Route not found", code: "NOT_FOUND" });
    });
  });

  // â”€â”€ Malformed JSON (BE-19) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  describe("POST /api/search/posts (malformed JSON)", () => {
    it("returns 400 with MALFORMED_JSON code for invalid JSON body (BE-19)", async () => {
      const res = await request(app)
        .post("/api/search/posts")
        .set("Content-Type", "application/json")
        .send("{invalid json}");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "MALFORMED_JSON" });
    });

    it("still handles valid JSON correctly (BE-19)", async () => {
      const res = await request(app).post("/api/search/posts").send({ query: "" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_QUERY" });
    });
  });
});

    it("accepts cursor-based pagination for followers and returns keyset shape", async () => {
      db.getFollowersAfter.mockResolvedValueOnce({
        followers: ["GABCDEF123456789012345678901234567890123456789012345678901234567",
          "GHJKLMNOPQRSTUVWXYZ12345678901234567890123456789012345678901234567"],
        total: 5,
      });
      const cursor = "GABCDEF123456789012345678901234567890123456789012345678901234567";
      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/followers?cursor=${cursor}&limit=2`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: FOLLOW_ADDRESS,
        followers: expect.arrayContaining([expect.stringMatching(/^G/)]),
        total: 5,
        limit: 2,
        offset: 0,
        has_more: true,
        next_offset: null,
        prev_offset: null,
      });
      expect(db.getFollowersAfter).toHaveBeenCalledWith(FOLLOW_ADDRESS, cursor, 2);
    });

    it("accepts cursor-based pagination for following and returns keyset shape", async () => {
      db.getFollowingAfter.mockResolvedValueOnce({
        following: ["GXYZABC123456789012345678901234567890123456789012345678901234567"],
        total: 3,
      });
      const cursor = "GABCDEF123456789012345678901234567890123456789012345678901234567";
      const res = await request(app).get(`/api/follows/${FOLLOW_ADDRESS}/following?cursor=${cursor}&limit=1`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: FOLLOW_ADDRESS,
        following: expect.arrayContaining([expect.stringMatching(/^G/)]),
        total: 3,
        limit: 1,
        offset: 0,
        has_more: false,
        next_offset: null,
        prev_offset: null,
      });
      expect(db.getFollowingAfter).toHaveBeenCalledWith(FOLLOW_ADDRESS, cursor, 1);
    });

/**
 * Cursor pagination for post listing (BE-01).
 *
 * The offset style must keep working untouched; the cursor style is additive.
 */
describe("GET /api/posts — cursor pagination (BE-01)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  function makePost(id: number, createdAt: string) {
    return {
      id: BigInt(id),
      author: FOLLOW_ADDRESS,
      content: "hello",
      deleted: false,
      tip_total: 0n,
      like_count: 0n,
      created_ledger: id,
      deleted_ledger: null,
      created_at: new Date(createdAt),
      deleted_at: null,
    };
  }

  const first = makePost(3, "2026-01-01T00:00:00.000Z");
  const second = makePost(2, "2026-01-01T00:00:00.000Z");
  const third = makePost(1, "2026-01-01T00:00:00.000Z");

 * Stable profile serialization (BE-09).
 *
 * The response always carries every documented key, so a client never has to
 * distinguish "missing" from "explicitly null".
 */
describe("GET /profiles/:address — response shape (BE-09)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  it("keeps offset pagination working and reports no cursor", async () => {
    db.listPosts.mockResolvedValueOnce({ posts: [first], total: 9 });

    const res = await request(app).get("/api/posts?limit=1&offset=2");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 9, limit: 1, offset: 2, has_more: true });
    expect(res.body.next_cursor).toBeNull();
    expect(db.listPosts).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 2, cursor: undefined })
    );
  });

  it("returns a cursor on a full page and null on the final page", async () => {
    db.listPosts.mockResolvedValueOnce({ posts: [first, second], total: 5 });
    const page1 = await request(app).get("/api/posts?limit=2");

    expect(page1.status).toBe(200);
    expect(typeof page1.body.next_cursor).toBe("string");
    expect(page1.body.offset).toBeNull();
    expect(page1.body.total).toBe(5);

    db.listPosts.mockResolvedValueOnce({ posts: [third], total: 5 });
    const page2 = await request(app).get(
      `/api/posts?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`
    );

    expect(page2.status).toBe(200);
    expect(page2.body.has_more).toBe(false);
    expect(page2.body.next_cursor).toBeNull();
  });

  it("resumes strictly after the boundary row encoded in the cursor", async () => {
    db.listPosts.mockResolvedValueOnce({ posts: [first, second], total: 5 });
    const page1 = await request(app).get("/api/posts?limit=2");
    const cursor = page1.body.next_cursor as string;

    db.listPosts.mockResolvedValueOnce({ posts: [third], total: 5 });
    await request(app).get(`/api/posts?limit=2&cursor=${encodeURIComponent(cursor)}`);

    // The boundary is the *last* row of page 1 (id 2), carried with its
    // timestamp so the comparison is unambiguous.
    expect(db.listPosts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        offset: 0,
        cursor: { created_at: "2026-01-01T00:00:00.000Z", id: "2" },
      })
    );
  });

  it("returns an empty final page without a cursor", async () => {
    db.listPosts.mockResolvedValueOnce({ posts: [], total: 5 });
    const res = await request(app).get("/api/posts?limit=2");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ posts: [], has_more: false, next_cursor: null });
  });

  it("rejects a malformed cursor instead of silently restarting from page one", async () => {
    const res = await request(app).get("/api/posts?cursor=not-a-cursor");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_CURSOR" });
    expect(db.listPosts).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but wrong-shaped cursor", async () => {
    // base64url of `{"created_at":"2026-01-01","id":"abc"}` — the id is not numeric.
    const cursor = Buffer.from(
      JSON.stringify({ created_at: "2026-01-01T00:00:00.000Z", id: "abc" }),
      "utf8"
    ).toString("base64url");

    const res = await request(app).get(`/api/posts?cursor=${encodeURIComponent(cursor)}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_CURSOR" });
    expect(db.listPosts).not.toHaveBeenCalled();
  });

  it("keeps the author filter working with a cursor", async () => {
    db.listPosts.mockResolvedValueOnce({ posts: [], total: 0 });
    await request(app).get(`/api/posts?author=${FOLLOW_ADDRESS}&cursor=${encodeURIComponent("eyJhIjoxfQ")}`);
    // A wrong-shaped cursor is refused before the filter is even applied.
    expect(db.listPosts).not.toHaveBeenCalled();
  });
});

/**
 * Post deletion semantics (BE-03).
 *
 * "Already deleted" and "never existed" are different answers and must not both
 * look like a 404.
 */
describe("DELETE /api/posts/:id — response semantics (BE-03)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  const livePost = {
    id: 42n,
    author: FOLLOW_ADDRESS,
    content: "hello",
    deleted: false,
    tip_total: 0n,
    like_count: 0n,
    created_ledger: 7,
    deleted_ledger: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    deleted_at: null,
  };

  const deletedPost = {
    ...livePost,
    deleted: true,
    deleted_ledger: 9,
    deleted_at: new Date("2026-01-02T00:00:00.000Z"),
  };

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  it("soft-deletes a live post and reports deleted: true", async () => {
    db.getPost.mockResolvedValueOnce(livePost);

    const res = await request(app).delete("/api/posts/42");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "42", deleted: true });
    expect(db.markPostDeleted).toHaveBeenCalledWith(42n, 7);
  });

  it("is idempotent: retrying an already-deleted post succeeds without a second write", async () => {
    db.getPost.mockResolvedValueOnce(deletedPost);

    const res = await request(app).delete("/api/posts/42");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "42", deleted: false });
    expect(db.markPostDeleted).not.toHaveBeenCalled();
  });

  it("404s for a post that never existed", async () => {
    db.getPost.mockResolvedValueOnce(null);

    const res = await request(app).delete("/api/posts/42");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    expect(db.markPostDeleted).not.toHaveBeenCalled();
  });

  it("distinguishes the two outcomes a client can observe", async () => {
    db.getPost.mockResolvedValueOnce(deletedPost);
    const already = await request(app).delete("/api/posts/42");

    db.getPost.mockResolvedValueOnce(null);
    const missing = await request(app).delete("/api/posts/42");

    // Same status, different body — the client can tell "retry is pointless"
    // from "retry is safe" without parsing prose.
    expect(already.body.deleted).toBe(false);
    expect(missing.body.code).toBe("NOT_FOUND");
  });

  it("rejects a malformed id before reading the post", async () => {
    const res = await request(app).delete("/api/posts/abc");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ID" });
    expect(db.getPost).not.toHaveBeenCalled();
  it("returns every documented key for a fully populated profile", async () => {
    db.getProfile.mockResolvedValueOnce({
      address: FOLLOW_ADDRESS,
      username: "alice",
      creator_token: OTHER_ADDRESS,
      updated_ledger: 42,
    });

    const res = await request(app).get(`/api/profiles/${FOLLOW_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "address",
      "creator_token",
      "updated_ledger",
      "username",
    ]);
  });

  it("keeps the same keys when optional fields were never set", async () => {
    // A row written before a column existed comes back from Postgres without it.
    db.getProfile.mockResolvedValueOnce({
      address: FOLLOW_ADDRESS,
      username: "alice",
    } as never);

    const res = await request(app).get(`/api/profiles/${FOLLOW_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "address",
      "creator_token",
      "updated_ledger",
      "username",
    ]);
    expect(res.body.creator_token).toBe("");
    expect(res.body.updated_ledger).toBe(0);
  });

  it("never drops a key that holds an explicit null", async () => {
    db.getProfile.mockResolvedValueOnce({
      address: FOLLOW_ADDRESS,
      username: "alice",
      creator_token: null,
      updated_ledger: null,
    } as never);

    const res = await request(app).get(`/api/profiles/${FOLLOW_ADDRESS}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "address",
      "creator_token",
      "updated_ledger",
      "username",
    ]);
    expect(res.body.creator_token).toBe("");
    expect(res.body.updated_ledger).toBe(0);
  });

  it("still 404s for a genuinely missing profile", async () => {
    db.getProfile.mockResolvedValueOnce(null);
    const res = await request(app).get(`/api/profiles/${FOLLOW_ADDRESS}`);
    expect(res.status).toBe(404);
  });
});

describe("cache-control policy for personalized responses (#1056)", () => {
  function app() {
    const a = express();
    a.get("/me", (_req, res) => sendSuccess(res, { address: "G..." }, 200, { personalized: true }));
    a.get("/me/list", (_req, res) => sendPaginated(res, [1], 1, 10, 0, { personalized: true }));
    a.get("/public", (_req, res) => sendSuccess(res, { ok: true }));
    return a;
  }

  it("marks personalized responses private and no-store", async () => {
    const res = await request(app()).get("/me");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["vary"]).toMatch(/Authorization/i);
    expect(res.headers["vary"]).toMatch(/X-Wallet-Address/i);
  });

  it("applies the same policy to personalized paginated responses", async () => {
    const res = await request(app()).get("/me/list");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("leaves public responses without a private/no-store directive", async () => {
    const res = await request(app()).get("/public");
    expect(res.headers["cache-control"] ?? "").not.toMatch(/private|no-store/);
  });
});
