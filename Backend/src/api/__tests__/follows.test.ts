/**
 * Follow-relationship API tests (#674).
 *
 * Covers the write path (follow / unfollow), the read path (relationship and
 * counts), and the rejection rules the issue calls out explicitly: invalid
 * addresses, self-follows, duplicates, and unfollowing a non-existent edge.
 */

import request from "supertest";
import { createApp } from "../index";
import { Database } from "../../db";

const A = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
const B = "GBZX4364PEPQTDICMIQDZ56K4T75QZCR4NBEYKO6PDRJAHZKGUOJPCXB";
const INVALID = "GABC123";

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn().mockResolvedValue(undefined),
    getFollow: jest.fn().mockResolvedValue(null),
    insertFollow: jest.fn().mockResolvedValue(undefined),
    deleteFollow: jest.fn().mockResolvedValue(undefined),
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
    getFollowers: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowing: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    getFollowersAfter: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowingAfter: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getTokenMetadata: jest.fn(),
  } as jest.Mocked<Database>;
}

describe("Follow relationship APIs (#674)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  describe("POST /api/follows", () => {
    it("creates a follow edge and returns 201", async () => {
      const res = await request(app).post("/api/follows").send({ follower: A, followee: B });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ follower: A, followee: B, following: true });
      expect(db.insertFollow).toHaveBeenCalledWith({ follower: A, followee: B, ledger: 0 });
    });

    it("passes a supplied ledger through to the store", async () => {
      await request(app).post("/api/follows").send({ follower: A, followee: B, ledger: 42 });

      expect(db.insertFollow).toHaveBeenCalledWith({ follower: A, followee: B, ledger: 42 });
    });

    it("rejects a self-follow with 400 CANNOT_FOLLOW_SELF", async () => {
      const res = await request(app).post("/api/follows").send({ follower: A, followee: A });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "CANNOT_FOLLOW_SELF" });
      expect(db.insertFollow).not.toHaveBeenCalled();
    });

    it("rejects a duplicate follow with 409 ALREADY_FOLLOWING", async () => {
      db.getFollow.mockResolvedValueOnce({ follower: A, followee: B, ledger: 1 });

      const res = await request(app).post("/api/follows").send({ follower: A, followee: B });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "ALREADY_FOLLOWING" });
      expect(db.insertFollow).not.toHaveBeenCalled();
    });

    it("rejects an invalid follower address before touching the database", async () => {
      const res = await request(app).post("/api/follows").send({ follower: INVALID, followee: B });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.getFollow).not.toHaveBeenCalled();
      expect(db.insertFollow).not.toHaveBeenCalled();
    });

    it("rejects a missing followee", async () => {
      const res = await request(app).post("/api/follows").send({ follower: A });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.insertFollow).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/follows/:follower/:followee", () => {
    it("removes an existing edge and returns 200", async () => {
      db.getFollow.mockResolvedValueOnce({ follower: A, followee: B, ledger: 1 });

      const res = await request(app).delete(`/api/follows/${A}/${B}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ follower: A, followee: B, following: false });
      expect(db.deleteFollow).toHaveBeenCalledWith(A, B);
    });

    it("returns 404 NOT_FOLLOWING when the edge does not exist", async () => {
      const res = await request(app).delete(`/api/follows/${A}/${B}`);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "NOT_FOLLOWING" });
      expect(db.deleteFollow).not.toHaveBeenCalled();
    });

    it("rejects an invalid address before touching the database", async () => {
      const res = await request(app).delete(`/api/follows/${INVALID}/${B}`);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.getFollow).not.toHaveBeenCalled();
      expect(db.deleteFollow).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/follows/:address/relationship/:target", () => {
    it("reports a one-way follow", async () => {
      db.getFollow
        .mockResolvedValueOnce({ follower: A, followee: B, ledger: 1 }) // A -> B
        .mockResolvedValueOnce(null); // B -> A

      const res = await request(app).get(`/api/follows/${A}/relationship/${B}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        address: A,
        target: B,
        following: true,
        followed_by: false,
        mutual: false,
      });
    });

    it("reports a mutual (follow-back) relationship", async () => {
      db.getFollow
        .mockResolvedValueOnce({ follower: A, followee: B, ledger: 1 })
        .mockResolvedValueOnce({ follower: B, followee: A, ledger: 2 });

      const res = await request(app).get(`/api/follows/${A}/relationship/${B}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ following: true, followed_by: true, mutual: true });
    });

    it("reports no relationship when neither edge exists", async () => {
      const res = await request(app).get(`/api/follows/${A}/relationship/${B}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ following: false, followed_by: false, mutual: false });
    });

    it("validates both addresses", async () => {
      const res = await request(app).get(`/api/follows/${A}/relationship/${INVALID}`);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.getFollow).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/follows/:address/counts", () => {
    it("returns follower and following totals", async () => {
      db.getFollowers.mockResolvedValueOnce({ followers: [], total: 7 });
      db.getFollowing.mockResolvedValueOnce({ following: [], total: 3 });

      const res = await request(app).get(`/api/follows/${A}/counts`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ address: A, followers: 7, following: 3 });
    });

    it("rejects an invalid address", async () => {
      const res = await request(app).get(`/api/follows/${INVALID}/counts`);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.getFollowers).not.toHaveBeenCalled();
    });
  });
});
