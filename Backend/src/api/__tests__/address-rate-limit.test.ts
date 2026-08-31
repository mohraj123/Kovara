/**
 * Tests for per-address rate limiting (Issue #616).
 *
 * These tests use the same supertest + createApp() pattern as rate-limit.test.ts,
 * but focus on the address-keyed limiter introduced in address-rate-limit.ts.
 */

import request from "supertest";
import { createApp, setRateLimit, setAddressRateLimit } from "../index";
import {
  isStellarAddress,
  extractAddress,
} from "../../middleware/address-rate-limit";
import { Database } from "../../db";
import { Request } from "express";

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_ADDRESS_A = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
const VALID_ADDRESS_B = "GBZX4364PEPQTDICMIQDZ56K4T75QZCR4NBEYKO6PDRJAHZKGUOJPCXB";
const INVALID_ADDRESS_SHORT = "GABC123";
const INVALID_ADDRESS_LOWERCASE = "gazj2eqv2es6r5blunxmnfr5vn3hqf4kxj2gm5q7gqht5xbc2crx3gk3";
const INVALID_ADDRESS_WRONG_PREFIX = "BAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Build a minimal mock Express Request for unit tests. */
function makeReq(overrides: {
  path?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Request {
  return {
    path: overrides.path ?? "/",
    params: {},
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
  } as unknown as Request;
}

// ── Unit tests: isStellarAddress() ───────────────────────────────────────────

describe("isStellarAddress()", () => {
  it("accepts a valid Stellar address (starts with G, 56 chars)", () => {
    expect(isStellarAddress(VALID_ADDRESS_A)).toBe(true);
    expect(isStellarAddress(VALID_ADDRESS_B)).toBe(true);
  });

  it("rejects an address that is too short", () => {
    expect(isStellarAddress(INVALID_ADDRESS_SHORT)).toBe(false);
  });

  it("rejects an address with lowercase characters", () => {
    expect(isStellarAddress(INVALID_ADDRESS_LOWERCASE)).toBe(false);
  });

  it("rejects an address that does not start with G", () => {
    expect(isStellarAddress(INVALID_ADDRESS_WRONG_PREFIX)).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isStellarAddress(null)).toBe(false);
    expect(isStellarAddress(undefined)).toBe(false);
    expect(isStellarAddress(42)).toBe(false);
    expect(isStellarAddress({})).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isStellarAddress("")).toBe(false);
  });
});

// ── Unit tests: extractAddress() ─────────────────────────────────────────────

describe("extractAddress()", () => {
  it("extracts address from URL path", () => {
    const req = makeReq({ path: `/api/profiles/${VALID_ADDRESS_A}` });
    expect(extractAddress(req)).toBe(VALID_ADDRESS_A);
  });

  it("extracts address from a deeper URL path segment", () => {
    const req = makeReq({ path: `/api/follows/${VALID_ADDRESS_A}/followers` });
    expect(extractAddress(req)).toBe(VALID_ADDRESS_A);
  });

  it("extracts address from request body", () => {
    const req = makeReq({ body: { address: VALID_ADDRESS_A } });
    expect(extractAddress(req)).toBe(VALID_ADDRESS_A);
  });

  it("extracts address from x-stellar-address header", () => {
    const req = makeReq({ headers: { "x-stellar-address": VALID_ADDRESS_A } });
    expect(extractAddress(req)).toBe(VALID_ADDRESS_A);
  });

  it("prefers URL path over body", () => {
    const req = makeReq({
      path: `/api/profiles/${VALID_ADDRESS_A}`,
      body: { address: VALID_ADDRESS_B },
    });
    expect(extractAddress(req)).toBe(VALID_ADDRESS_A);
  });

  it("prefers body over header", () => {
    const req = makeReq({
      body: { address: VALID_ADDRESS_A },
      headers: { "x-stellar-address": VALID_ADDRESS_B },
    });
    expect(extractAddress(req)).toBe(VALID_ADDRESS_A);
  });

  it("falls back to sentinel when no address is present", () => {
    const req = makeReq({});
    expect(extractAddress(req)).toBe("__no_address__");
  });

  it("ignores an invalid address in URL path and falls back", () => {
    const req = makeReq({ path: `/api/profiles/${INVALID_ADDRESS_SHORT}` });
    expect(extractAddress(req)).toBe("__no_address__");
  });

  it("ignores an invalid address in the body and falls back", () => {
    const req = makeReq({ body: { address: INVALID_ADDRESS_LOWERCASE } });
    expect(extractAddress(req)).toBe("__no_address__");
  });
});

// ── Integration tests: per-address limiting ───────────────────────────────────

describe("Address Rate Limiting (integration)", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
    // Keep the IP limiter generous so it doesn't interfere.
    setRateLimit(60_000, 1000);
  });

  it("returns 429 after an address exceeds its per-address limit", async () => {
    setAddressRateLimit(60_000, 3);
    const app = createApp(db);

    const route = `/api/profiles/${VALID_ADDRESS_A}`;

    // First 3 requests succeed (profile not found = 404).
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get(route);
      expect(res.status).toBe(404);
    }

    // 4th request from the same address should be rate-limited.
    const res = await request(app).get(route);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "ADDRESS_RATE_LIMIT_EXCEEDED" });
  });

  it("includes a Retry-After header in the 429 response", async () => {
    setAddressRateLimit(10_000, 1);
    const app = createApp(db);

    const route = `/api/profiles/${VALID_ADDRESS_A}`;
    await request(app).get(route); // exhaust limit
    const res = await request(app).get(route);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("tracks counters independently per address", async () => {
    setAddressRateLimit(60_000, 2);
    const app = createApp(db);

    // Exhaust limit for address A.
    for (let i = 0; i < 2; i++) {
      await request(app).get(`/api/profiles/${VALID_ADDRESS_A}`);
    }

    // Address A is now blocked.
    const resA = await request(app).get(`/api/profiles/${VALID_ADDRESS_A}`);
    expect(resA.status).toBe(429);

    // Address B still has its own quota — should not be blocked.
    const resB = await request(app).get(`/api/profiles/${VALID_ADDRESS_B}`);
    expect(resB.status).not.toBe(429);
  });

  it("does not block requests with no Stellar address", async () => {
    setAddressRateLimit(60_000, 1);
    const app = createApp(db);

    // /api/search/posts has no address in the URL; the address limiter skips it.
    const body = { query: "hello" };
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post("/api/search/posts").send(body);
      // Should not be blocked by the address limiter (may get 200 or 400 but not 429).
      expect(res.status).not.toBe(429);
    }
  });

  it("applies address limiting to requests that supply the x-stellar-address header", async () => {
    setAddressRateLimit(60_000, 2);
    const app = createApp(db);

    // Use /api/search/posts (no address in URL) but supply the header.
    const body = { query: "test" };
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post("/api/search/posts")
        .set("x-stellar-address", VALID_ADDRESS_A)
        .send(body);
    }

    const res = await request(app)
      .post("/api/search/posts")
      .set("x-stellar-address", VALID_ADDRESS_A)
      .send(body);

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "ADDRESS_RATE_LIMIT_EXCEEDED" });
  });

  it("includes standard RateLimit headers on non-limited responses", async () => {
    setAddressRateLimit(60_000, 100);
    const app = createApp(db);

    const res = await request(app).get(`/api/profiles/${VALID_ADDRESS_A}`);

    // Should be a 404 (profile not found), not a rate-limit error.
    expect(res.status).toBe(404);
    // Standard RateLimit headers should be present (draft-6 or legacy).
    const hasHeader =
      res.headers["ratelimit-limit"] !== undefined ||
      res.headers["x-ratelimit-limit"] !== undefined ||
      res.headers["ratelimit"] !== undefined;
    expect(hasHeader).toBe(true);
  });

  it("returns the correct error body structure on 429", async () => {
    setAddressRateLimit(60_000, 1);
    const app = createApp(db);

    const route = `/api/profiles/${VALID_ADDRESS_A}`;
    await request(app).get(route); // exhaust limit
    const res = await request(app).get(route);

    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty("error");
    expect(res.body).toHaveProperty("code", "ADDRESS_RATE_LIMIT_EXCEEDED");
  });
});
