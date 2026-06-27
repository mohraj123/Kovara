import request from "supertest";
import { createApp } from "../index";
import { Database } from "../../db";

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn().mockResolvedValue(undefined),
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
    it("returns 200 with status ok", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok" });
    });

    it("returns uptime in seconds", async () => {
      const res = await request(app).get("/health");
      expect(res.body).toHaveProperty("uptime");
      expect(typeof res.body.uptime).toBe("number");
    });
  });

  // ── Profiles ──────────────────────────────────────────────────────────────

  describe("GET /api/profiles/:address", () => {
    it("returns a profile when found", async () => {
      db.getProfile.mockResolvedValueOnce({
        address: "GABC123",
        username: "alice",
        creator_token: "GTOKEN",
        updated_ledger: 100,
      });

      const res = await request(app).get("/api/profiles/GABC123");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        address: "GABC123",
        username: "alice",
        creator_token: "GTOKEN",
        updated_ledger: 100,
      });
    });

    it("returns 404 when profile not found", async () => {
      db.getProfile.mockResolvedValueOnce(null);

      const res = await request(app).get("/api/profiles/GMISSING");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns 404 for empty address (no route match)", async () => {
      const res = await request(app).get("/api/profiles/");
      expect(res.status).toBe(404);
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

      const res = await request(app).get("/api/pools/pool1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ pool_id: "pool1", token: "GTOKEN" });
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
  });

  // ── Error handler ─────────────────────────────────────────────────────────

  describe("Error handler", () => {
    it("returns 500 when a route handler throws", async () => {
      db.getProfile.mockRejectedValueOnce(new Error("unexpected"));

      const res = await request(app).get("/api/profiles/GABC123");
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("handles 404 for unknown routes", async () => {
      const res = await request(app).get("/api/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});
