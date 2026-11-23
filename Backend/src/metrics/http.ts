/**
 * HTTP and process metric definitions plus the recording middleware (#679).
 *
 * The three acceptance criteria map onto the definitions declared here:
 *
 *   - **latency** -> `http_request_duration_ms` (histogram, so percentiles are
 *     computable from the buckets);
 *   - **throughput** -> `http_requests_total` (+ `http_requests_in_flight` for
 *     the instantaneous concurrency);
 *   - **errors** -> `http_errors_total`, labelled by status.
 *
 * ## Why the route label is normalized
 *
 * A metric label may only take a bounded set of values. Labelled by the raw
 * path, every distinct address or id would create a new time series and the
 * registry would grow until the process died — a self-inflicted denial of
 * service that looks like a memory leak. `normalizeRoute` therefore reduces a
 * path to its matched route pattern (`/api/v1/profiles/:address`) or, when no
 * route matched, replaces dynamic-looking segments with `:id`. Cardinality is
 * then bounded by the number of routes, not by the size of the database.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { DEFAULT_LATENCY_BUCKETS_MS, MetricDefinition, MetricsRegistry } from "./registry";

/** Stellar public keys are collapsed out of the route label. */
const ADDRESS_SEGMENT = /^G[A-Z2-7]{55}$/;
/** Pure digits are ids/cursors; collapse them too. */
const NUMERIC_SEGMENT = /^\d+$/;
/** How many concrete path segments to keep before collapsing the tail. */
const MAX_CONCRETE_SEGMENTS = 4;

export const HTTP_METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    name: "http_requests_total",
    type: "counter",
    help: "Total HTTP requests handled, by method, route and status.",
    labelNames: ["method", "route", "status"],
  },
  {
    name: "http_request_duration_ms",
    type: "histogram",
    help: "HTTP request latency in milliseconds, by method and route.",
    labelNames: ["method", "route"],
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  },
  {
    name: "http_errors_total",
    type: "counter",
    help: "HTTP requests that produced a 4xx or 5xx status, by method, route and status.",
    labelNames: ["method", "route", "status"],
  },
  {
    name: "http_requests_in_flight",
    type: "gauge",
    help: "HTTP requests currently being handled.",
    labelNames: [],
  },
  {
    name: "db_probe_duration_ms",
    type: "histogram",
    help: "Latency of the database probe performed by the health check.",
    labelNames: [],
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  },
  {
    name: "service_up",
    type: "gauge",
    help: "1 when the last health check reached the database, 0 otherwise.",
    labelNames: [],
  },
  {
    name: "process_uptime_seconds",
    type: "gauge",
    help: "Process uptime in seconds.",
    labelNames: [],
  },
  {
    name: "process_resident_memory_bytes",
    type: "gauge",
    help: "Resident memory size in bytes.",
    labelNames: [],
  },
];

/**
 * Reduce a request to a bounded route label.
 *
 * A matched route is preferred (`req.route.path`), because Express already knows
 * the pattern and it cannot drift from the router. For an unmatched request the
 * raw path is normalized: wallet addresses and numeric segments become `:id`,
 * and anything past the concrete-segment budget is collapsed into `/*` so an
 * arbitrarily deep path cannot create an unbounded label.
 */
export function normalizeRoute(req: Pick<Request, "route" | "baseUrl" | "path">): string {
  const matched = req.route as { path?: string } | undefined;
  if (matched?.path) {
    return `${req.baseUrl ?? ""}${matched.path}` || "/";
  }

  const rawPath = (req.path ?? "/").split("?")[0];
  const segments = rawPath.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return "/";

  const normalized = segments.map((segment) =>
    ADDRESS_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment) ? ":id" : segment
  );

  if (normalized.length > MAX_CONCRETE_SEGMENTS) {
    return `/${normalized.slice(0, MAX_CONCRETE_SEGMENTS).join("/")}/*`;
  }
  return `/${normalized.join("/")}`;
}

export interface MetricsMiddlewareOptions {
  registry: MetricsRegistry;
  /** Paths that are not recorded; scraping must not inflate its own numbers. */
  skipPaths?: string[];
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_SKIP_PATHS = ["/metrics", "/api/v1/metrics", "/health", "/version"];

/**
 * Express middleware that records latency, throughput and errors for every
 * request. Metrics are written on `finish` (the response actually went out) and
 * also on `close` when the client went away first — a slow request abandoned by
 * its client is exactly the kind of thing an operator needs to see, so it is
 * counted rather than dropped.
 */
export function createMetricsMiddleware(options: MetricsMiddlewareOptions): RequestHandler {
  const { registry } = options;
  const now = options.now ?? (() => Date.now());
  const skip = new Set(options.skipPaths ?? DEFAULT_SKIP_PATHS);

  // Per-instance concurrency counter. A module-level counter would be shared
  // across app instances (tests build many), and reading the gauge back out of
  // the registry on every request would be O(series).
  let inFlight = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    const path = (req.path ?? "").split("?")[0];
    if (skip.has(path)) {
      next();
      return;
    }

    const startedAt = now();
    inFlight += 1;
    registry.setGauge("http_requests_in_flight", inFlight);

    let recorded = false;
    const record = (): void => {
      if (recorded) return;
      recorded = true;

      const durationMs = Math.max(0, now() - startedAt);
      const method = req.method ?? "GET";
      const route = normalizeRoute(req);
      const status = String(res.statusCode);

      registry.increment("http_requests_total", { method, route, status });
      registry.observe("http_request_duration_ms", durationMs, { method, route });
      if (res.statusCode >= 400) {
        registry.increment("http_errors_total", { method, route, status });
      }
      inFlight = Math.max(0, inFlight - 1);
      registry.setGauge("http_requests_in_flight", inFlight);
    };

    // `finish` covers the normal path; `close` covers a client that disconnects
    // before the response is sent. `recorded` makes the pair idempotent.
    res.on("finish", record);
    res.on("close", record);
    next();
  };
}

/**
 * Refresh process-level gauges. Called by the `/metrics` handlers so a scrape
 * reports the value at scrape time rather than at startup.
 */
export function refreshProcessMetrics(registry: MetricsRegistry): void {
  // Guarded so a registry built without the process definitions (a focused unit
  // test, a custom embed) still renders instead of throwing on a scrape.
  if (registry.has("process_uptime_seconds")) {
    registry.setGauge("process_uptime_seconds", process.uptime());
  }
  const memory = typeof process.memoryUsage === "function" ? process.memoryUsage() : undefined;
  if (memory && registry.has("process_resident_memory_bytes")) {
    registry.setGauge("process_resident_memory_bytes", memory.rss);
  }
}
