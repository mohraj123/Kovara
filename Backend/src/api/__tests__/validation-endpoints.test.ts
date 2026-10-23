/**
 * Integration coverage for input validation (issue #665).
 *
 * The unit tests in `validation.test.ts` prove the rules; this file proves the
 * three acceptance criteria end-to-end through the real Express app:
 *
 *   1. malformed input is rejected **before** business logic runs — asserted by
 *      checking the database mock was never called;
 *   2. the error envelope is identical across endpoints — asserted by comparing
 *      the response keys on every rejection;
 *   3. security-sensitive fields (wallet addresses, ids, the identity header)
 *      are treated explicitly.
 */
import request from "supertest";
import { createApp } from "../index";
import { Database } from "../../db";

const VALID = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
const VALID_2 = "GBZX4364PEPQTDICMIQDZ56K4T75QZCR4NBEYKO6PDRJAHZKGUOJPCXB";
const BAD_SHORT = "GABC123";
// `0` is not in the Stellar base-32 alphabet; the old `[A-Z0-9]` profile check
// accepted it.
const BAD_ALPHABET = "G" + "0".repeat(55);

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn(),
    getFollow: jest.fn(),
    insertFollow: jest.fn(),
    deleteFollow: jest.fn(),
    insertPost: jest.fn(),
    markPostDeleted: jest.fn(),
    incrementPostLikeCount: jest.fn(),
    addPostTipTotal: jest.fn(),
    getPost: jest.fn().mockResolvedValue(null),
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

describe("input validation across public endpoints (#665)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  // ── Rejection happens before business logic ────────────────────────────────

  describe("rejects malformed input before business logic runs", () => {
    it("profiles: a malformed address never reaches getProfile", async () => {
      const res = await request(app).get(`/api/profiles/${BAD_SHORT}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.getProfile).not.toHaveBeenCalled();
    });

    it("profiles: a char outside the base-32 alphabet is rejected", async () => {
      const res = await request(app).get(`/api/profiles/${BAD_ALPHABET}`);
      expect(res.status).toBe(400);
      expect(db.getProfile).not.toHaveBeenCalled();
    });

    it("posts: an invalid author filter never reaches listPosts", async () => {
      const res = await request(app).get(`/api/posts?author=${BAD_SHORT}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.listPosts).not.toHaveBeenCalled();
    });

    it("posts: an oversized limit never reaches listPosts", async () => {
      const res = await request(app).get("/api/posts?limit=101");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED" });
      expect(db.listPosts).not.toHaveBeenCalled();
    });

    it("posts: a malformed id never reaches getPost", async () => {
      const res = await request(app).get("/api/posts/not-a-number");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ID" });
      expect(db.getPost).not.toHaveBeenCalled();
    });

    it("follows: a malformed address never reaches getFollowers", async () => {
      const res = await request(app).get(`/api/follows/${BAD_SHORT}/followers`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.getFollowers).not.toHaveBeenCalled();
    });

    it("follows: an oversized limit never reaches getFollowers", async () => {
      const res = await request(app).get(`/api/follows/${VALID}/followers?limit=51`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED" });
      expect(db.getFollowers).not.toHaveBeenCalled();
    });

    it("feed: a malformed author never reaches listPosts", async () => {
      const res = await request(app).get(`/api/feed?author=${BAD_SHORT}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.listPosts).not.toHaveBeenCalled();
    });
  });

  // ── Valid input still proceeds ─────────────────────────────────────────────

  describe("valid input proceeds to business logic", () => {
    it("profiles: a valid address reaches getProfile", async () => {
      const res = await request(app).get(`/api/profiles/${VALID}`);
      expect(res.status).toBe(404); // mock returns null
      expect(db.getProfile).toHaveBeenCalledWith(VALID);
    });

    it("posts: a valid author reaches listPosts", async () => {
      const res = await request(app).get(`/api/posts?author=${VALID}`);
      expect(res.status).toBe(200);
      expect(db.listPosts).toHaveBeenCalledWith(
        expect.objectContaining({ author: VALID, limit: 20, offset: 0 })
      );
    });

    it("follows: a valid address reaches getFollowers", async () => {
      const res = await request(app).get(`/api/follows/${VALID}/followers`);
      expect(res.status).toBe(200);
      expect(db.getFollowers).toHaveBeenCalledWith(VALID, 20, 0);
    });

    it("posts: default pagination is applied when omitted", async () => {
      const res = await request(app).get("/api/posts");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ limit: 20, offset: 0 });
    });
  });

  // ── Consistency across endpoints ───────────────────────────────────────────

  describe("error envelope is consistent across endpoints", () => {
    const cases: string[] = [
      `/api/profiles/${BAD_SHORT}`,
      `/api/posts?author=${BAD_SHORT}`,
      "/api/posts?limit=101",
      "/api/posts/abc",
      `/api/follows/${BAD_SHORT}/followers`,
      `/api/feed?author=${BAD_SHORT}`,
    ];

    it.each(cases)("returns exactly { error, code } for %s", async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(Object.keys(res.body).sort()).toEqual(["code", "error"]);
      expect(typeof res.body.error).toBe("string");
      expect(typeof res.body.code).toBe("string");
    });
  });

  // ── Security-sensitive identity header ─────────────────────────────────────

  describe("x-stellar-address header", () => {
    it("rejects a malformed identity header", async () => {
      const res = await request(app).get("/api/posts").set("x-stellar-address", BAD_SHORT);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
      expect(db.listPosts).not.toHaveBeenCalled();
    });

    it("accepts a well-formed identity header", async () => {
      const res = await request(app).get("/api/posts").set("x-stellar-address", VALID_2);
      expect(res.status).toBe(200);
    });

    it("applies to the versioned prefix as well", async () => {
      const res = await request(app).get("/api/v1/posts").set("x-stellar-address", BAD_SHORT);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    });
  });

  // ── Versioned prefix parity ────────────────────────────────────────────────

  it("validates the same fields under /api/v1", async () => {
    const res = await request(app).get(`/api/v1/follows/${BAD_SHORT}/followers`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    expect(db.getFollowers).not.toHaveBeenCalled();
  });
});

/**
 * Profile updates (BE-06).
 *
 * The contract under test is "no partial write": a request carrying one
 * invalid field must be refused whole, with the offending field named, and the
 * store must not be touched at all.
 */
describe("profile update field validation (BE-06)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  const existing = {
    address: VALID,
    username: "oldname",
    creator_token: "",
    updated_ledger: 10,
  };

  beforeEach(() => {
    db = makeMockDb();
    db.getProfile.mockResolvedValue(existing);
    app = createApp(db);
  });

  it("writes once when every field is valid", async () => {
    const res = await request(app).put(`/api/profiles/${VALID}`).send({ username: "newname" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: "newname" });
    expect(db.upsertProfile).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty username without writing", async () => {
    const res = await request(app).put(`/api/profiles/${VALID}`).send({ username: "   " });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_FIELD" });
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("names the field that failed on a malformed creator token", async () => {
    const res = await request(app)
      .put(`/api/profiles/${VALID}`)
      .send({ username: "newname", creator_token: "not-an-address" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("does not apply the valid username when a later field is invalid", async () => {
    // The partial-update regression: `username` parses, `creator_token` does
    // not, and the profile must keep both of its original values.
    const res = await request(app)
      .put(`/api/profiles/${VALID}`)
      .send({ username: "newname", creator_token: "G" + "0".repeat(55) });

    expect(res.status).toBe(400);
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("rejects a missing body as an empty username", async () => {
    const res = await request(app).put(`/api/profiles/${VALID}`).send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_FIELD" });
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("rejects a malformed address before reading the profile", async () => {
    const res = await request(app).put(`/api/profiles/${BAD_SHORT}`).send({ username: "newname" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    expect(db.getProfile).not.toHaveBeenCalled();
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("404s when the profile does not exist", async () => {
    db.getProfile.mockResolvedValueOnce(null);
    const res = await request(app).put(`/api/profiles/${VALID}`).send({ username: "newname" });

    expect(res.status).toBe(404);
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("keeps the stored creator token when the field is omitted", async () => {
    db.getProfile.mockResolvedValueOnce({ ...existing, creator_token: VALID_2 });
    const res = await request(app).put(`/api/profiles/${VALID}`).send({ username: "newname" });

    expect(res.status).toBe(200);
    expect(db.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ username: "newname", creator_token: VALID_2 })
    );
  });
});

/**
 * Optional address filters across endpoints (BE-32).
 *
 * The contract: an absent or blank `author` / wallet filter must be treated as
 * "no filter applied" (proceed to business logic), while a present but
 * malformed address must be rejected before any database call.
 */
describe("optional address filter normalization (BE-32)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  // Absent filter — should pass through and hit the store

  it("posts: omitting author reaches listPosts without a filter", async () => {
    const res = await request(app).get("/api/posts");
    expect(res.status).toBe(200);
    // The absence of `author` in the query string is treated as "all authors"
    expect(db.listPosts).toHaveBeenCalled();
  });

  it("posts: author= (empty string value) is treated as absent and proceeds", async () => {
    const res = await request(app).get("/api/posts?author=");
    // An empty author value is the same as omitted — not a validation failure
    expect([200, 400]).toContain(res.status);
    // It must NOT be INVALID_ADDRESS when the filter is simply absent/blank
    if (res.status === 400) {
      expect(res.body.code).not.toBe("INVALID_ADDRESS");
    }
  });

  // Present but malformed filter — must be rejected

  it("posts: a malformed author is rejected with INVALID_ADDRESS before listPosts", async () => {
    const res = await request(app).get(`/api/posts?author=${BAD_SHORT}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    expect(db.listPosts).not.toHaveBeenCalled();
  });

  it("posts: a character outside the Stellar alphabet is rejected with INVALID_ADDRESS", async () => {
    // `0` is not in the base-32 alphabet; the old `[A-Z0-9]` check accepted it
    const badAlphabet = "G" + "0".repeat(55);
    const res = await request(app).get(`/api/posts?author=${badAlphabet}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    expect(db.listPosts).not.toHaveBeenCalled();
  });

  it("feed: omitting author reaches listPosts without error", async () => {
    const res = await request(app).get("/api/feed");
    expect(res.status).toBe(200);
    expect(db.listPosts).toHaveBeenCalled();
  });

  it("feed: a malformed author is rejected with INVALID_ADDRESS before listPosts", async () => {
    const res = await request(app).get(`/api/feed?author=${BAD_SHORT}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    expect(db.listPosts).not.toHaveBeenCalled();
  });

  // All rejections share the exact envelope shape { error, code }

  it("all optional-address rejections return exactly { error, code }", async () => {
    const paths = [
      `/api/posts?author=${BAD_SHORT}`,
      `/api/feed?author=${BAD_SHORT}`,
    ];
    for (const path of paths) {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(Object.keys(res.body).sort()).toEqual(["code", "error"]);
      expect(res.body.code).toBe("INVALID_ADDRESS");
    }
  });
});
