/**
 * Authentication / authorization integration tests (#666).
 *
 * The API is anonymous by default (a no-op middleware), so these tests install
 * an explicit policy and assert the three outcomes a client can observe:
 *
 *   200 — authenticated and permitted
 *   401 — no valid credential (unauthenticated)
 *   403 — identified, but the role required by the route is missing
 *
 * Health and version are asserted to stay public, because a load balancer has
 * to be able to probe liveness while auth is enabled.
 */

import request from "supertest";
import { createApp } from "../index";
import { Database } from "../../db";
import {
  AuthenticatedRequest,
  AuthMiddleware,
  createTokenAuthMiddleware,
  requireRole,
} from "../../middleware/auth";

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
    getProfile: jest.fn().mockResolvedValue(null),
    listProfiles: jest.fn().mockResolvedValue({ profiles: [], total: 0 }),
    listPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getFollowers: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowing: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    getFollowersAfter: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowingAfter: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getTokenMetadata: jest.fn(),
  } as jest.Mocked<Database>;
}

describe("Authentication and authorization (#666)", () => {
  const SECRET = "test-secret";

  it("allows anonymous access when no auth middleware is configured", async () => {
    const app = createApp(makeMockDb());
    const res = await request(app).get("/api/posts");
    expect(res.status).toBe(200);
  });

  describe("bearer-token authentication", () => {
    it("returns 401 when no credential is presented", async () => {
      const app = createApp(makeMockDb(), { authMiddleware: createTokenAuthMiddleware(SECRET) });

      const res = await request(app).get("/api/posts");

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("returns 401 when the credential is wrong", async () => {
      const app = createApp(makeMockDb(), { authMiddleware: createTokenAuthMiddleware(SECRET) });

      const res = await request(app).get("/api/posts").set("Authorization", "Bearer nope");

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("returns 200 when the credential is valid", async () => {
      const app = createApp(makeMockDb(), { authMiddleware: createTokenAuthMiddleware(SECRET) });

      const res = await request(app).get("/api/posts").set("Authorization", `Bearer ${SECRET}`);

      expect(res.status).toBe(200);
    });

    it("fails closed when the configured secret is empty", async () => {
      const app = createApp(makeMockDb(), { authMiddleware: createTokenAuthMiddleware(undefined) });

      const res = await request(app).get("/api/posts");

      expect(res.status).toBe(401);
    });

    it("keeps health and version public", async () => {
      const app = createApp(makeMockDb(), { authMiddleware: createTokenAuthMiddleware(SECRET) });

      const health = await request(app).get("/health");
      const version = await request(app).get("/version");

      expect(health.status).toBe(200);
      expect(version.status).toBe(200);
    });
  });

  describe("role-based authorization boundaries", () => {
    /** Authenticate a caller with the given roles, then require `admin`. */
    function withRoles(roles: string[]): AuthMiddleware {
      const setIdentity: AuthMiddleware = (req, _res, next) => {
        (req as AuthenticatedRequest).auth = { subject: "user-1", roles };
        next();
      };
      return (req, res, next) => setIdentity(req, res, () => requireRole("admin")(req, res, next));
    }

    it("returns 401 when no identity is established before an authorization gate", async () => {
      // The gate runs but nothing authenticated the caller, so "you may not" is
      // unknowable — the correct answer is 401, not 403.
      const gate: AuthMiddleware = (req, res, next) => requireRole("admin")(req, res, next);
      const app = createApp(makeMockDb(), { authMiddleware: gate });

      const res = await request(app).get("/api/posts");

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("returns 403 when the caller is known but lacks the required role", async () => {
      const app = createApp(makeMockDb(), { authMiddleware: withRoles(["user"]) });

      const res = await request(app).get("/api/posts");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    });

    it("returns 200 when the caller holds the required role", async () => {
      const app = createApp(makeMockDb(), { authMiddleware: withRoles(["admin"]) });

      const res = await request(app).get("/api/posts");

      expect(res.status).toBe(200);
    });
  });
});
