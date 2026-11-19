import http from "http";
import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { createSearchRouter, readCategory } from "../search-router";
import { ResponseCache } from "../../cache/response-cache";
import type { PostgresSearchStore } from "../../search/store";
import { AddressInfo } from "net";
import { createApp } from "../index";
import { Database } from "../../db";

describe("POST /api/search/posts", () => {
  const db = {
    upsertProfile: jest.fn(),
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
    getFollowersAfter: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowingAfter: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    getFollow: jest.fn(),
    searchPosts: jest.fn().mockResolvedValue({
      posts: [
        {
          id: 42n,
          author: "GABC...XYZ",
          content: "Building on Stellar with Soroban is great!",
          tip_total: 1000000000n,
          like_count: 7n,
          created_at: new Date("2024-01-01T00:00:00.000Z"),
          deleted_at: null,
        },
      ],
      total: 1,
    }),
  } as unknown as Database;

  it("returns search results from the database", async () => {
    const app = createApp(db);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/search/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "stellar soroban", limit: 10, offset: 0 }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        posts: [
          {
            id: "42",
            author: "GABC...XYZ",
            content: "Building on Stellar with Soroban is great!",
            tip_total: "1000000000",
            like_count: "7",
            created_at: "2024-01-01T00:00:00.000Z",
            deleted: false,
          },
        ],
        total: 1,
        has_more: false,
        next_offset: null,
        prev_offset: null,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("preserves large like counts exactly in search responses (BA-027)", async () => {
    (db.searchPosts as jest.Mock).mockResolvedValueOnce({
      posts: [
        {
          id: 43n,
          author: "GABC...XYZ",
          content: "massively popular",
          // Above Number.MAX_SAFE_INTEGER (2^53-1 = 9007199254740991), so a
          // Number() coercion would silently lose precision.
          tip_total: 9999999999999999n,
          like_count: 9007199254740993n,
          created_at: new Date("2024-01-01T00:00:00.000Z"),
          deleted_at: null,
        },
      ],
      total: 1,
    });

    const app = createApp(db);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/search/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "popular", limit: 10, offset: 0 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.posts[0].like_count).toBe("9007199254740993");
      expect(body.posts[0].tip_total).toBe("9999999999999999");
      expect(typeof body.posts[0].like_count).toBe("string");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe("stable search pagination ordering (BE-032)", () => {
  /** Posts that all share one relevance, so only the tie-breaker orders them. */
  function storeWithPosts(ids: number[]) {
    const rows = ids.map((id) => ({
      id: String(id),
      author: "GAUTHOR",
      content: "stellar",
      like_count: 0,
      tip_total: 0,
      created_ledger: 1,
      created_at: null,
      relevance: 0.5,
    }));
    const pool = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("information_schema.columns")) return { rows: [] };
        if (sql.includes("COUNT(*)")) return { rows: [{ total: rows.length }] };
        // Emulate `ORDER BY relevance DESC, id DESC LIMIT $3`.
        const sorted = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
        return { rows: sorted.slice(0, Number(params[2])) };
      }),
    };
    return new PostgresSearchStore(pool as unknown as Pool);
  }

  async function pages(store: PostgresSearchStore, pageSize: number, count: number) {
    const out: string[][] = [];
    for (let offset = 0; offset < count; offset += pageSize) {
      const result = await store.search("stellar", { entities: ["posts"], limit: pageSize, offset });
      out.push(result.hits.map((h) => h.id));
    }
    return out;
  }

  it("pages equally ranked rows without skipping or repeating any", async () => {
    const ids = [1, 2, 3, 4, 5, 9, 10, 11];
    const result = await pages(storeWithPosts(ids), 3, ids.length);
    const flat = result.flat();
    expect(new Set(flat).size).toBe(ids.length); // no duplicates
    expect([...flat].sort((a, b) => Number(a) - Number(b))).toEqual(ids.map(String)); // none skipped
    expect(flat).toEqual(["11", "10", "9", "5", "4", "3", "2", "1"]); // numeric id DESC
  });

  it("returns the same page on repeated requests", async () => {
    const store = storeWithPosts([1, 2, 3, 4, 5, 6]);
    const first = await store.search("stellar", { entities: ["posts"], limit: 2, offset: 2 });
    const again = await store.search("stellar", { entities: ["posts"], limit: 2, offset: 2 });
    expect(again.hits.map((h) => h.id)).toEqual(first.hits.map((h) => h.id));
  });

  it("compareHits orders by score, then entity, then the per-entity tie-breaker", () => {
    const hit = (entity: "posts" | "profiles" | "categories", id: string, title = id, score = 1) =>
      ({ entity, id, title, snippet: null, score, attributes: {} }) as never;
    expect(compareHits(hit("posts", "10"), hit("posts", "9"))).toBeLessThan(0); // numeric, DESC
    expect(compareHits(hit("profiles", "G2", "alice"), hit("profiles", "G1", "bob"))).toBeLessThan(0);
    expect(compareHits(hit("profiles", "G1", "same"), hit("profiles", "G2", "same"))).toBeLessThan(0);
    expect(compareHits(hit("posts", "1", "x", 2), hit("profiles", "G1", "x", 1))).toBeLessThan(0); // score first
    expect(compareHits(hit("categories", "a"), hit("posts", "1"))).toBeLessThan(0); // entity name order
describe("GET /api/v1/search category filter", () => {
  function makeApp() {
    const search = jest.fn().mockResolvedValue({
      hits: [
        { entity: "categories", id: "news", title: "news", snippet: "", score: 1, attributes: { category: "news" } },
        { entity: "categories", id: "tips", title: "tips", snippet: "", score: 0.9, attributes: { category: "tips" } },
        { entity: "posts", id: "1", title: "Post", snippet: "", score: 0.8, attributes: { id: "1" } },
      ],
      total: 3,
      limit: 20,
      offset: 0,
      hasMore: false,
      normalizedQuery: "stellar",
    });
    const router = createSearchRouter({
      pool: {} as Pool,
      store: { search } as unknown as PostgresSearchStore,
      cache: new ResponseCache({ ttlMs: 1_000, readEpoch: async () => 0 }),
    });
    const app = express();
    app.use("/api/v1/search", router);
    return { app, search };
  }

  it("keeps the unfiltered behaviour when category is omitted", async () => {
    const { app, search } = makeApp();
    const res = await request(app).get("/api/v1/search?q=stellar");
    expect(res.status).toBe(200);
    expect(res.body.hits).toHaveLength(3);
    expect(search.mock.calls[0][1].category).toBeUndefined();
  });

  it("passes a supported category to the store and narrows category hits", async () => {
    const { app, search } = makeApp();
    const res = await request(app).get("/api/v1/search?q=stellar&category=News");
    expect(res.status).toBe(200);
    expect(search.mock.calls[0][1].category).toBe("news");
    const ids = res.body.hits.map((h: { id: string }) => h.id);
    expect(ids).toEqual(["news", "1"]);
  });

  it("rejects an unsupported category with INVALID_CATEGORY", async () => {
    const { app, search } = makeApp();
    for (const bad of ["bad%20category!", "a".repeat(33), "-leading"]) {
      const res = await request(app).get(`/api/v1/search?q=stellar&category=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CATEGORY");
    }
    expect(search).not.toHaveBeenCalled();
  });

  it("does not share cache entries between different categories", async () => {
    const { app, search } = makeApp();
    await request(app).get("/api/v1/search?q=stellar&category=news");
    await request(app).get("/api/v1/search?q=stellar&category=tips");
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("readCategory treats blank as no filter and arrays as invalid", () => {
    expect(readCategory(undefined)).toBeUndefined();
    expect(readCategory("  ")).toBeUndefined();
    expect(() => readCategory(["a", "b"])).toThrow();
  });
});
