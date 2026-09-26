/**
 * Like and tip activity endpoint tests (#675).
 *
 * Covers persistence (the store is called with validated values), the
 * downstream balance effect (the post's like_count / tip_total is updated), and
 * the rejection rules: invalid addresses, non-positive or unbounded amounts,
 * malformed transaction hashes, missing posts, and duplicate activity.
 */

import request from "supertest";
import { createApp } from "../index";
import { Database, Post } from "../../db";

const USER = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
const OTHER = "GBZX4364PEPQTDICMIQDZ56K4T75QZCR4NBEYKO6PDRJAHZKGUOJPCXB";
const INVALID = "GABC123";
const TX_HASH = "a".repeat(64);

const POST: Post = {
  id: 5n,
  author: "GBPOSTAUTHORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  content: "hello",
  deleted: false,
  tip_total: 100n,
  like_count: 2n,
  created_ledger: 10,
  deleted_ledger: null,
};

/**
 * The activity-read methods are optional on `Database`, so jest's mock typing
 * leaves them possibly-undefined. This type pins them as present mocks.
 */
type MockDb = jest.Mocked<Database> & {
  hasTip: jest.Mock;
  listLikes: jest.Mock;
  listTips: jest.Mock;
};

function makeMockDb(): MockDb {
  return {
    upsertProfile: jest.fn().mockResolvedValue(undefined),
    getFollow: jest.fn().mockResolvedValue(null),
    insertFollow: jest.fn(),
    deleteFollow: jest.fn(),
    insertPost: jest.fn(),
    markPostDeleted: jest.fn(),
    incrementPostLikeCount: jest.fn().mockResolvedValue(undefined),
    addPostTipTotal: jest.fn().mockResolvedValue(undefined),
    getPost: jest.fn(),
    upsertLike: jest.fn().mockResolvedValue(true),
    insertTip: jest.fn().mockResolvedValue(undefined),
    hasTip: jest.fn().mockResolvedValue(false),
    listLikes: jest.fn().mockResolvedValue({ likes: [], total: 0 }),
    listTips: jest.fn().mockResolvedValue({ tips: [], total: 0 }),
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
  } as unknown as MockDb;
}

describe("Like and tip activity endpoints (#675)", () => {
  let db: MockDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    db.getPost.mockResolvedValue(POST);
    app = createApp(db);
  });

  describe("POST /api/posts/:id/like", () => {
    it("persists a like and increments the post's like count", async () => {
      const res = await request(app).post("/api/posts/5/like").send({ user: USER });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ post_id: "5", user: USER, liked: true, like_count: "3" });
      expect(db.upsertLike).toHaveBeenCalledWith({ post_id: 5n, user: USER, ledger: 0 });
      expect(db.incrementPostLikeCount).toHaveBeenCalledWith(5n);
    });

    it("accepts the address from the x-stellar-address header", async () => {
      const res = await request(app)
        .post("/api/posts/5/like")
        .set("x-stellar-address", USER)
        .send({});

      expect(res.status).toBe(201);
      expect(db.upsertLike).toHaveBeenCalledWith({ post_id: 5n, user: USER, ledger: 0 });
    });

    it("rejects a duplicate like with 409 ALREADY_LIKED and does not double count", async () => {
      db.upsertLike.mockResolvedValueOnce(false);

      const res = await request(app).post("/api/posts/5/like").send({ user: USER });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "ALREADY_LIKED" });
      expect(db.incrementPostLikeCount).not.toHaveBeenCalled();
    });

    it("rejects an invalid user address before any read or write", async () => {
      const res = await request(app).post("/api/posts/5/like").send({ user: INVALID });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.getPost).not.toHaveBeenCalled();
      expect(db.upsertLike).not.toHaveBeenCalled();
    });

    it("returns 404 for a post that does not exist", async () => {
      db.getPost.mockResolvedValueOnce(null);

      const res = await request(app).post("/api/posts/999/like").send({ user: USER });

      expect(res.status).toBe(404);
      expect(db.upsertLike).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/posts/:id/tip", () => {
    it("persists a tip and adds it to the post's tip total", async () => {
      const res = await request(app)
        .post("/api/posts/5/tip")
        .send({ tipper: USER, amount: "250", fee: "10", tx_hash: TX_HASH });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        post_id: "5",
        tipper: USER,
        amount: "250",
        fee: "10",
        tip_total: "350",
      });
      expect(db.insertTip).toHaveBeenCalledWith({
        tipper: USER,
        post_id: 5n,
        amount: 250n,
        fee: 10n,
        ledger: 0,
        tx_hash: TX_HASH,
      });
      expect(db.addPostTipTotal).toHaveBeenCalledWith(5n, 250n);
    });

    it("rejects a non-positive amount before touching the database", async () => {
      const res = await request(app)
        .post("/api/posts/5/tip")
        .send({ tipper: USER, amount: "0", tx_hash: TX_HASH });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_AMOUNT" });
      expect(db.insertTip).not.toHaveBeenCalled();
    });

    it("rejects a malformed transaction hash", async () => {
      const res = await request(app)
        .post("/api/posts/5/tip")
        .send({ tipper: USER, amount: "100", tx_hash: "not-a-hash" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_TRANSACTION_HASH" });
      expect(db.insertTip).not.toHaveBeenCalled();
    });

    it("rejects a replayed transaction with 409 DUPLICATE_TIP", async () => {
      db.hasTip.mockResolvedValueOnce(true);

      const res = await request(app)
        .post("/api/posts/5/tip")
        .send({ tipper: USER, amount: "100", tx_hash: TX_HASH });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "DUPLICATE_TIP" });
      expect(db.insertTip).not.toHaveBeenCalled();
      expect(db.addPostTipTotal).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/posts/:id/activity", () => {
    it("lists persisted likes and tips alongside the totals", async () => {
      db.getPost.mockResolvedValueOnce({ ...POST, like_count: 1n, tip_total: 50n });
      db.listLikes.mockResolvedValueOnce({ likes: [{ user: USER, ledger: 3 }], total: 1 });
      db.listTips.mockResolvedValueOnce({
        tips: [
          {
            id: 1,
            tipper: OTHER,
            post_id: 5n,
            amount: 50n,
            fee: 0n,
            ledger: 3,
            tx_hash: TX_HASH,
          },
        ],
        total: 1,
      });

      const res = await request(app).get("/api/posts/5/activity");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        post_id: "5",
        like_count: "1",
        tip_total: "50",
        likes_total: 1,
        tips_total: 1,
      });
      expect(res.body.likes).toEqual([{ user: USER, ledger: 3 }]);
      expect(res.body.tips[0]).toMatchObject({ tipper: OTHER, amount: "50" });
    });

    it("rejects a malformed post id", async () => {
      const res = await request(app).get("/api/posts/abc/activity");

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ID" });
      expect(db.getPost).not.toHaveBeenCalled();
    });

    it("returns 404 when the post does not exist", async () => {
      db.getPost.mockResolvedValueOnce(null);

      const res = await request(app).get("/api/posts/404/activity");

      expect(res.status).toBe(404);
    });
  });
});
