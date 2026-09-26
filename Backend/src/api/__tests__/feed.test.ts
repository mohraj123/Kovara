import express from "express";
import request from "supertest";
import { Database, Post } from "../../db";
import { createFeedRouter } from "../../feed/routes";

const NOW = Date.now();

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 1n,
    author: "GAUTHOR",
    content: "hello",
    deleted: false,
    tip_total: 0n,
    like_count: 0n,
    created_ledger: 100,
    deleted_ledger: null,
    created_at: new Date(NOW),
    deleted_at: null,
    ...overrides,
  };
}

function makeApp(posts: Post[]) {
  const db = {
    listPosts: jest.fn(async () => ({ posts, total: posts.length })),
  } as unknown as Database;
  const app = express();
  app.use(express.json());
  app.use("/feed", createFeedRouter(db));
  return app;
}

describe("GET /feed (#676)", () => {
  it("returns a ranked feed with explainable rules", async () => {
    const app = makeApp([
      post({ id: 1n, like_count: 10n, created_at: new Date(NOW - 3_600_000) }),
      post({ id: 2n, like_count: 500n, created_at: new Date(NOW - 86_400_000) }),
    ]);

    const res = await request(app).get("/feed?mode=ranked&limit=10");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("ranked");
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.ranking).toHaveProperty("weights");
    expect(res.body.entries[0]).toHaveProperty("signals");
    // Decimal-string fields, never numbers.
    expect(typeof res.body.entries[0].like_count).toBe("string");
  });

  it("supports explicit trending requests", async () => {
    const res = await request(makeApp([post()])).get("/feed?mode=trending");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("trending");
    expect(res.body.ranking.trending_window_days).toBe(7);
  });

  it("returns 400 for an unknown mode", async () => {
    const res = await request(makeApp([])).get("/feed?mode=hot");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_MODE" });
  });

  it("returns 400 when the limit exceeds the cap", async () => {
    const res = await request(makeApp([])).get("/feed?limit=1000");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("returns an empty page rather than a 404 for a feed with no posts", async () => {
    const res = await request(makeApp([])).get("/feed");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: [], total: 0, has_more: false });
  });
});
