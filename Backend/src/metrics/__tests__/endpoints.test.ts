import request from "supertest";
import { createApp } from "../../api";
import { Database } from "../../db";
import { HTTP_METRIC_DEFINITIONS } from "../http";
import { MetricsRegistry } from "../registry";

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

describe("metrics endpoints (#679)", () => {
  let registry: MetricsRegistry;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    registry = new MetricsRegistry(HTTP_METRIC_DEFINITIONS);
    app = createApp(makeMockDb(), { metricsRegistry: registry });
  });

  it("serves Prometheus text at GET /metrics", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("# TYPE http_requests_total counter");
    expect(res.text).toContain("# TYPE http_request_duration_ms histogram");
    expect(res.text).toContain("# TYPE http_errors_total counter");
  });

  it("serves a JSON snapshot at GET /api/v1/metrics", async () => {
    const res = await request(app).get("/api/v1/metrics");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("generated_at");
    expect(Array.isArray(res.body.counters)).toBe(true);
    expect(Array.isArray(res.body.gauges)).toBe(true);
    expect(Array.isArray(res.body.histograms)).toBe(true);
  });

  it("records latency and throughput for real traffic", async () => {
    await request(app).get("/api/posts");
    await request(app).get("/api/posts");

    const snap = registry.snapshot();
    const total = snap.counters.find(
      (c) => c.name === "http_requests_total" && c.labels.route.includes("/posts")
    );
    expect(total?.value).toBe(2);

    const latency = snap.histograms.find((h) => h.name === "http_request_duration_ms");
    expect(latency?.count).toBeGreaterThanOrEqual(2);
  });

  it("records error status codes", async () => {
    await request(app).get("/api/posts/not-a-number");

    const errors = registry.snapshot().counters.find((c) => c.name === "http_errors_total");
    expect(errors).toBeDefined();
    expect(Number(errors?.labels.status)).toBeGreaterThanOrEqual(400);
  });

  it("does not count scrapes as traffic", async () => {
    await request(app).get("/metrics");
    await request(app).get("/api/v1/metrics");
    expect(
      registry.snapshot().counters.find((c) => c.name === "http_requests_total")
    ).toBeUndefined();
  });

  it("instruments the health probe and reports service_up", async () => {
    await request(app).get("/health");
    const snap = registry.snapshot();
    expect(snap.histograms.find((h) => h.name === "db_probe_duration_ms")?.count).toBe(1);
    expect(snap.gauges.find((g) => g.name === "service_up")?.value).toBe(1);
  });

  it("exposes process gauges on scrape", async () => {
    await request(app).get("/metrics");
    const text = (await request(app).get("/metrics")).text;
    expect(text).toContain("process_uptime_seconds");
    expect(text).toContain("process_resident_memory_bytes");
  });
});

describe("metrics token guard (#679)", () => {
  const ORIGINAL = process.env.METRICS_TOKEN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = ORIGINAL;
  });

  it("stays open when METRICS_TOKEN is unset", async () => {
    delete process.env.METRICS_TOKEN;
    const app = createApp(makeMockDb(), {
      metricsRegistry: new MetricsRegistry(HTTP_METRIC_DEFINITIONS),
    });
    expect((await request(app).get("/metrics")).status).toBe(200);
  });

  it("requires the token when METRICS_TOKEN is set", async () => {
    process.env.METRICS_TOKEN = "s3cret";
    const app = createApp(makeMockDb(), {
      metricsRegistry: new MetricsRegistry(HTTP_METRIC_DEFINITIONS),
    });

    expect((await request(app).get("/metrics")).status).toBe(401);
    expect((await request(app).get("/metrics").set("x-metrics-token", "s3cret")).status).toBe(200);
    expect(
      (await request(app).get("/api/v1/metrics").set("authorization", "Bearer s3cret")).status
    ).toBe(200);
  });
});
