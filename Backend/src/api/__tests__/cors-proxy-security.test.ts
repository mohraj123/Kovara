import request from "supertest";
import {
  createApp,
  parseAllowedOrigins,
  parseTrustProxy,
} from "../index";
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

/** Saved env so CORS_ORIGIN / TRUST_PROXY tests restore process.env cleanly. */
const ENV_KEYS = ["CORS_ORIGIN", "TRUST_PROXY"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.CORS_ORIGIN;
  delete process.env.TRUST_PROXY;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("parseTrustProxy (Issue #680)", () => {
  it.each([undefined, "", "0", "false"])("trusts nothing for %p", (raw) => {
    expect(parseTrustProxy(raw)).toBe(false);
  });

  it("trusts the immediate peer for \"true\"", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  it.each(["1", "2", "10"])("accepts hop count %s", (raw) => {
    expect(parseTrustProxy(raw)).toBe(Number(raw));
  });

  it.each(["-1", "no", "yes", "1.5", " 2 ", "TRUE"])(
    "coerces or rejects %p instead of passing it to Express",
    (raw) => {
      if (raw === " 2 ") {
        // Whitespace is trimmed; a clean hop count is accepted.
        expect(parseTrustProxy(raw)).toBe(2);
      } else if (raw === "TRUE") {
        // Case-insensitive, matching operator expectations.
        expect(parseTrustProxy(raw)).toBe(true);
      } else {
        expect(() => parseTrustProxy(raw)).toThrow(/TRUST_PROXY/);
      }
    }
  );

  it("rejects negative hop counts", () => {
    expect(() => parseTrustProxy("-3")).toThrow(/TRUST_PROXY/);
  });
});

describe("parseAllowedOrigins (Issue #680)", () => {
  it("allows all origins when unset or empty", () => {
    expect(parseAllowedOrigins(undefined)).toEqual(["*"]);
    expect(parseAllowedOrigins("")).toEqual(["*"]);
  });

  it("allows all origins when set to *", () => {
    expect(parseAllowedOrigins("*")).toEqual(["*"]);
  });

  it("parses a single origin", () => {
    expect(parseAllowedOrigins("https://app.example.com")).toEqual([
      "https://app.example.com",
    ]);
  });

  it("parses comma-separated origins and normalizes them", () => {
    expect(
      parseAllowedOrigins("https://app.example.com, http://localhost:5173")
    ).toEqual(["https://app.example.com", "http://localhost:5173"]);
  });

  it("deduplicates origins", () => {
    expect(
      parseAllowedOrigins("https://a.com,https://a.com,https://a.com")
    ).toEqual(["https://a.com"]);
  });

  it("normalizes default ports away (origin equality is by URL origin)", () => {
    expect(parseAllowedOrigins("https://a.com:443")).toEqual(["https://a.com"]);
  });

  it.each([
    "https://*.example.com", // wildcard subdomain
    "https://app.example.com/path", // path
    "https://app.example.com?q=1", // query
    "https://app.example.com#frag", // fragment
    "https://user:pass@app.example.com", // credentials
    "app.example.com", // bare hostname
    "ftp://app.example.com", // unsupported scheme
    "null", // sandboxed-iframe "origin"
  ])("rejects unsafe origin entry %p", (raw) => {
    expect(() => parseAllowedOrigins(raw)).toThrow(/CORS_ORIGIN/);
  });

  it("rejects * mixed with explicit origins", () => {
    expect(() =>
      parseAllowedOrigins("https://a.com,*")
    ).toThrow(/cannot be mixed/);
  });

  it("rejects a value with no valid origins", () => {
    expect(() => parseAllowedOrigins(" , ,")).toThrow(/no valid origins/);
  });
});

describe("CORS behavior with an allow-list configured (Issue #680)", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
    process.env.CORS_ORIGIN = "https://app.example.com";
  });

  it("reflects an allow-listed origin", async () => {
    const app = createApp(db);
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://app.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    );
  });

  it("does not reflect an unlisted origin", async () => {
    const app = createApp(db);
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example.net");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles requests with no Origin header (curl, server-to-server)", async () => {
    const app = createApp(db);
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflights only for allow-listed origins", async () => {
    const app = createApp(db);

    const allowed = await request(app)
      .options("/api/profiles/test")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "GET");
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    );

    const denied = await request(app)
      .options("/api/profiles/test")
      .set("Origin", "https://evil.example.net")
      .set("Access-Control-Request-Method", "GET");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends Access-Control-Allow-Origin: * when CORS_ORIGIN is unset (dev default)", async () => {
    delete process.env.CORS_ORIGIN;
    const app = createApp(db);
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://anything.example.net");
    // Matches the pre-existing cors() default: a literal "*" for all requests.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("Client-supplied header sanitization (Issue #680)", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it("honors a well-formed correlation id", async () => {
    const app = createApp(db);
    const res = await request(app)
      .get("/api/profiles/GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3")
      .set("x-correlation-id", "test-abc_123");
    expect(res.headers["x-correlation-id"]).toBe("test-abc_123");
  });

  it.each([
    "id with spaces",
    "id;drop table",
    "a".repeat(129), // over the 128-char bound
  ])("replaces an unsafe correlation id %p with a generated UUID", async (bad) => {
    const app = createApp(db);
    const res = await request(app)
      .get("/api/profiles/GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3")
      .set("x-correlation-id", bad);
    expect(res.headers["x-correlation-id"]).toBeDefined();
    expect(res.headers["x-correlation-id"]).not.toBe(bad);
    expect(res.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("accepts a well-formed x-stellar-address header", async () => {
    const app = createApp(db);
    const res = await request(app)
      .get("/api/profiles/GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3")
      .set("x-stellar-address", "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3");
    // The route itself 404s (profile not found) but the header passes validation.
    expect(res.status).toBe(404);
  });

  it.each([
    "not-an-address",
    "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK", // 55 chars
    "gazj2eqv2es6r5blunxmnfr5vn3hqf4kxj2gm5q7gqht5xbc2crx3gk3", // lowercase
    "<script>alert(1)</script>",
  ])("rejects a malformed x-stellar-address header with 400", async (bad) => {
    const app = createApp(db);
    const res = await request(app)
      .get("/health")
      .set("x-stellar-address", bad);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS_HEADER" });
  });
});
