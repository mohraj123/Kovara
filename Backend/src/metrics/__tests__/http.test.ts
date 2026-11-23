import { EventEmitter } from "events";
import type { NextFunction, Request, Response } from "express";
import { createMetricsMiddleware, HTTP_METRIC_DEFINITIONS, normalizeRoute } from "../http";
import { MetricsRegistry } from "../registry";

describe("normalizeRoute", () => {
  it("prefers the matched route pattern", () => {
    expect(
      normalizeRoute({
        route: { path: "/:address" },
        baseUrl: "/api/v1/profiles",
        path: "/api/v1/profiles/GAB",
      })
    ).toBe("/api/v1/profiles/:address");
  });

  it("collapses a Stellar address to :id when no route matched", () => {
    const path = "/api/v1/profiles/GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
    expect(normalizeRoute({ route: undefined, baseUrl: "", path })).toBe("/api/v1/profiles/:id");
  });

  it("collapses numeric segments", () => {
    expect(normalizeRoute({ route: undefined, baseUrl: "", path: "/api/v1/posts/12345" })).toBe(
      "/api/v1/posts/:id"
    );
  });

  it("collapses the tail past the concrete-segment budget", () => {
    expect(normalizeRoute({ route: undefined, baseUrl: "", path: "/a/b/c/d/e/f" })).toBe(
      "/a/b/c/d/*"
    );
  });

  it("returns / for an empty path", () => {
    expect(normalizeRoute({ route: undefined, baseUrl: "", path: "/" })).toBe("/");
  });
});

interface Fake {
  req: Request;
  res: Response;
  next: NextFunction;
}

function fake(statusCode = 200, path = "/posts"): Fake {
  const res = new EventEmitter() as unknown as Response;
  (res as unknown as { statusCode: number }).statusCode = statusCode;
  const req = {
    method: "GET",
    path,
    baseUrl: "/api/v1",
    route: { path: "/" },
    headers: {},
  } as unknown as Request;
  return { req, res, next: jest.fn() };
}

describe("createMetricsMiddleware", () => {
  function make() {
    const registry = new MetricsRegistry(HTTP_METRIC_DEFINITIONS);
    const middleware = createMetricsMiddleware({
      registry,
      now: (() => {
        let t = 100;
        return () => (t += 25);
      })(),
    });
    return { registry, middleware };
  }

  it("records throughput, latency and in-flight on finish", () => {
    const { registry, middleware } = make();
    const { req, res, next } = fake(200);
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    // While the request is open the gauge is 1.
    expect(
      registry.snapshot().gauges.find((g) => g.name === "http_requests_in_flight")?.value
    ).toBe(1);

    (res as unknown as EventEmitter).emit("finish");

    const snap = registry.snapshot();
    expect(snap.counters.find((c) => c.name === "http_requests_total")?.value).toBe(1);
    expect(snap.histograms.find((h) => h.name === "http_request_duration_ms")?.count).toBe(1);
    expect(snap.gauges.find((g) => g.name === "http_requests_in_flight")?.value).toBe(0);
    // No error counter for a 2xx response.
    expect(snap.counters.find((c) => c.name === "http_errors_total")).toBeUndefined();
  });

  it("counts 4xx/5xx responses as errors", () => {
    const { registry, middleware } = make();
    const { req, res } = fake(500);
    middleware(req, res, jest.fn());
    (res as unknown as EventEmitter).emit("finish");

    const errors = registry.snapshot().counters.find((c) => c.name === "http_errors_total");
    expect(errors).toMatchObject({ value: 1, labels: { status: "500" } });
  });

  it("records once even when both finish and close fire", () => {
    const { registry, middleware } = make();
    const { req, res } = fake(200);
    middleware(req, res, jest.fn());
    const emitter = res as unknown as EventEmitter;
    emitter.emit("finish");
    emitter.emit("close");

    const total = registry.snapshot().counters.find((c) => c.name === "http_requests_total");
    expect(total?.value).toBe(1);
  });

  it("records a client disconnect via close", () => {
    const { registry, middleware } = make();
    const { req, res } = fake(200);
    middleware(req, res, jest.fn());
    (res as unknown as EventEmitter).emit("close");
    expect(registry.snapshot().counters.find((c) => c.name === "http_requests_total")?.value).toBe(
      1
    );
  });

  it("skips scrape and health paths so they do not inflate the numbers", () => {
    const { registry, middleware } = make();
    for (const path of ["/metrics", "/api/v1/metrics", "/health", "/version"]) {
      const { req, res, next } = fake(200, path);
      middleware(req, res, next);
      (res as unknown as EventEmitter).emit("finish");
      expect(next).toHaveBeenCalled();
    }
    expect(
      registry.snapshot().counters.find((c) => c.name === "http_requests_total")
    ).toBeUndefined();
  });
});
