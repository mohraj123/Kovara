/**
 * Input-validation tests (#665).
 *
 * Two layers:
 *   - unit tests for each validator, covering the malformed and boundary
 *     inputs a public endpoint can receive;
 *   - integration tests proving a malformed request is rejected at the HTTP
 *     boundary *before* the business layer (the database) is invoked, and that
 *     the error body is consistent across endpoints.
 */

import request from "supertest";
import { createApp } from "../index";
import { Database } from "../../db";
import {
  isFailure,
  isStellarAddress,
  validateEnum,
  validateId,
  validateInteger,
  validatePagination,
  validatePositiveInteger,
  validateSearchQuery,
  validateStellarAddress,
  validateTransactionHash,
} from "../validation";

const ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

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

describe("validation helpers (#665)", () => {
  describe("isStellarAddress / validateStellarAddress", () => {
    it("accepts a well-formed address", () => {
      expect(isStellarAddress(ADDRESS)).toBe(true);
    });

    it("rejects short, lowercase, wrong-prefix and non-string values", () => {
      expect(isStellarAddress("GABC123")).toBe(false);
      expect(isStellarAddress(ADDRESS.toLowerCase())).toBe(false);
      expect(isStellarAddress("B" + ADDRESS.slice(1))).toBe(false);
      expect(isStellarAddress(42)).toBe(false);
      expect(isStellarAddress(null)).toBe(false);
    });

    it("trims a valid address and rejects blank input", () => {
      const ok = validateStellarAddress(`  ${ADDRESS}  `);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.value).toBe(ADDRESS);

      const blank = validateStellarAddress("   ");
      expect(blank.ok).toBe(false);
      if (isFailure(blank)) expect(blank.failure.code).toBe("INVALID_ADDRESS");
    });
  });

  describe("validateId", () => {
    it("parses a non-negative integer", () => {
      const result = validateId("42");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(42n);
    });

    it.each(["", "-1", "abc", "1.5", "1e3"])("rejects %p as INVALID_ID", (input) => {
      const result = validateId(input as unknown);
      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) expect(result.failure.code).toBe("INVALID_ID");
    });
  });

  describe("validateInteger / validatePositiveInteger", () => {
    it("accepts bigint, integer number and numeric string", () => {
      expect(validateInteger(7n, "amount").ok).toBe(true);
      expect(validateInteger(7, "amount").ok).toBe(true);
      expect(validateInteger("7", "amount").ok).toBe(true);
    });

    it("rejects floats, booleans and out-of-range values", () => {
      expect(isFailure(validateInteger(1.5, "amount"))).toBe(true);
      expect(isFailure(validateInteger(true, "amount"))).toBe(true);
      expect(isFailure(validateInteger("abc", "amount"))).toBe(true);
      expect(isFailure(validateInteger(11n, "amount", { max: 10n }))).toBe(true);
    });

    it("requires a strictly positive value", () => {
      expect(isFailure(validatePositiveInteger(0, "amount"))).toBe(true);
      expect(isFailure(validatePositiveInteger(-1, "amount"))).toBe(true);
      expect(validatePositiveInteger(1, "amount").ok).toBe(true);
    });
  });

  describe("validatePagination", () => {
    it("applies defaults when params are absent", () => {
      const result = validatePagination({});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({ limit: 20, offset: 0 });
    });

    it("accepts numeric strings", () => {
      const result = validatePagination({ limit: "10", offset: "5" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({ limit: 10, offset: 5 });
    });

    it.each([true, [], {}, "abc", "0", -1])(
      "rejects %p as an invalid limit",
      (value) => {
        expect(isFailure(validatePagination({ limit: value as unknown }))).toBe(true);
      }
    );

    it("caps the page size with LIMIT_EXCEEDED", () => {
      const result = validatePagination({ limit: 101 }, { maxLimit: 100 });
      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) expect(result.failure.code).toBe("LIMIT_EXCEEDED");
    });

    it("rejects a negative offset", () => {
      const result = validatePagination({ offset: -1 });
      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) expect(result.failure.code).toBe("INVALID_QUERY");
    });
  });

  describe("validateSearchQuery", () => {
    it("collapses whitespace and trims", () => {
      const result = validateSearchQuery("  test   search  ");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("test search");
    });

    it("rejects empty, non-string and oversized queries", () => {
      expect(isFailure(validateSearchQuery("   "))).toBe(true);
      expect(isFailure(validateSearchQuery(123))).toBe(true);
      const long = validateSearchQuery("a".repeat(501), { maxLength: 500 });
      expect(isFailure(long)).toBe(true);
      if (isFailure(long)) expect(long.failure.code).toBe("QUERY_TOO_LONG");
    });
  });

  describe("validateEnum / validateTransactionHash", () => {
    it("accepts allowed values and rejects others", () => {
      const ok = validateEnum("approve", ["approve", "reject"] as const, "choice");
      expect(ok.ok).toBe(true);
      expect(isFailure(validateEnum("maybe", ["approve", "reject"] as const, "choice"))).toBe(true);
    });

    it("accepts a 64-char hex hash with or without 0x", () => {
      expect(validateTransactionHash("a".repeat(64)).ok).toBe(true);
      expect(validateTransactionHash("0x" + "b".repeat(64)).ok).toBe(true);
      expect(isFailure(validateTransactionHash("0x123"))).toBe(true);
      expect(isFailure(validateTransactionHash(undefined))).toBe(true);
    });
  });
});

describe("validation at the HTTP boundary (#665)", () => {
  let db: jest.Mocked<Database>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = makeMockDb();
    app = createApp(db);
  });

  it.each(["abc", "true", "-1", "1.5"])(
    "rejects ?limit=%s before the database is queried",
    async (limit) => {
      const res = await request(app).get(`/api/posts?limit=${limit}`);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("code");
      expect(res.body).toHaveProperty("error");
      expect(db.listPosts).not.toHaveBeenCalled();
    }
  );

  it("returns LIMIT_EXCEEDED for an oversized page", async () => {
    const res = await request(app).get("/api/posts?limit=101");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(db.listPosts).not.toHaveBeenCalled();
  });

  it("rejects a malformed address before the database is queried", async () => {
    const res = await request(app).get("/api/profiles/GABC123");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
    expect(db.getProfile).not.toHaveBeenCalled();
  });
});
