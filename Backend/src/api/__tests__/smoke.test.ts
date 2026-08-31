import request from "supertest";
import { createApp } from "../index";
import { Database } from "../../db";

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

describe("Smoke Tests", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  describe("GET /version", () => {
    it("returns 200 with version metadata", async () => {
      const res = await request(app).get("/version");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        version: expect.any(String),
        git_commit: expect.any(String),
        build_time: expect.any(String),
        node_version: expect.any(String),
      });
    });

    it("returns semver for the version field", async () => {
      const res = await request(app).get("/version");
      expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("defaults git_commit to unknown", async () => {
      const res = await request(app).get("/version");
      expect(res.body.git_commit).toBe("unknown");
    });
  });

  describe("CORS headers", () => {
    it("includes Access-Control-Allow-Origin on API routes", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["access-control-allow-origin"]).toBeDefined();
    });

    it("includes Access-Control-Allow-Origin on /version", async () => {
      const res = await request(app).get("/version");
      expect(res.headers["access-control-allow-origin"]).toBeDefined();
    });

    it("responds to OPTIONS preflight on API routes", async () => {
      const res = await request(app).options("/api/profiles/test");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBeDefined();
      expect(res.headers["access-control-allow-methods"]).toBeDefined();
    });
  });

  describe("API versioning", () => {
    it("serves version 1 routes under /api/v1", async () => {
      const res = await request(app).get("/api/v1/profiles/test");

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    });

    it("keeps unversioned routes compatible and marks them deprecated", async () => {
      const res = await request(app).get("/api/profiles/test");

      expect(res.status).toBe(400);
      expect(res.headers.deprecation).toBe("true");
      expect(res.headers.link).toContain("/api/v1/profiles/test");
      expect(res.headers.link).toContain('rel="successor-version"');
    });
  });

  describe("Server startup", () => {
    it("creates an app without throwing", () => {
      expect(() => createApp(db)).not.toThrow();
    });

    it("listens on a port and accepts connections", async () => {
      const http = await import("http");
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));

      const address = server.address() as { port: number };
      expect(address.port).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(res.status).toBe(200);

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  describe("Content-Type", () => {
    it("returns application/json for all API routes", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("returns application/json for error responses", async () => {
      const res = await request(app).get("/api/nonexistent");
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });
  });
});
