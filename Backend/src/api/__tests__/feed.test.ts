import express from "express";
import request from "supertest";
import { Database, Post } from "../../db";
import { createFeedRouter } from "../../feed/routes";
import { createActivityRouter } from "../routes/activity";
import { PostgresActivityFeed } from "../../submissions/activity";
import type { ActivityItem, ActivityPage } from "../../submissions/activity";
import { decodeCursor, encodeCursor } from "../../utils/cursor-pagination.utils";

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

describe("activity pagination cursors (#1043)", () => {
  const ADDRESS = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
  const item: ActivityItem = {
    id: "submission:1",
    kind: "submission",
    occurredAt: "2026-01-01T00:00:00.000Z",
    submissionId: "1",
    details: {},
  };

  function makeActivityApp(page: ActivityPage) {
    const list = jest.fn(async () => page);
    const app = express();
    app.use("/activity", createActivityRouter({ list } as unknown as PostgresActivityFeed));
    return { app, list };
  }

  function page(overrides: Partial<ActivityPage> = {}): ActivityPage {
    return {
      address: ADDRESS,
      activities: [item],
      limit: 10,
      offset: 0,
      total: 20,
      hasMore: true,
      ...overrides,
    };
  }

  it("returns a next cursor only while more activity exists", async () => {
    const first = makeActivityApp(page());
    const firstRes = await request(first.app).get(`/activity/${ADDRESS}?limit=10`);
    expect(firstRes.status).toBe(200);
    expect(typeof firstRes.body.nextCursor).toBe("string");
    expect(decodeCursor(firstRes.body.nextCursor)).toBe("10");

    const last = makeActivityApp(page({ offset: 10, hasMore: false }));
    const lastRes = await request(last.app).get(`/activity/${ADDRESS}?limit=10&offset=10`);
    expect(lastRes.status).toBe(200);
    expect(lastRes.body).not.toHaveProperty("nextCursor");
  });

  it("decodes a validated cursor into the query offset", async () => {
    const { app, list } = makeActivityApp(page({ offset: 10 }));

    const res = await request(app)
      .get(`/activity/${ADDRESS}`)
      .query({ cursor: encodeCursor("10"), limit: "10" });

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(ADDRESS, 10, 10);
  });

  it("rejects a malformed or tampered cursor before querying", async () => {
    const { app, list } = makeActivityApp(page());

    const res = await request(app).get(`/activity/${ADDRESS}?cursor=tampered-cursor`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_CURSOR" });
    expect(list).not.toHaveBeenCalled();
  });
});
