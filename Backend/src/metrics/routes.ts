/**
 * `/metrics` handlers (#679).
 *
 * Two surfaces over the same registry, because they answer different questions:
 *
 *   - `GET /metrics` returns Prometheus text exposition — the format a scraper
 *     and a time-series database consume for latency/throughput/error history.
 *   - `GET /api/v1/metrics` returns a JSON snapshot — the format an operator or
 *     a human-readable dashboard consumes when they want to *look* at the
 *     current state without a Prometheus stack in front of it.
 *
 * Because both read one registry, the two can never disagree.
 */
import type { RequestHandler } from "express";
import { refreshProcessMetrics } from "./http";
import { MetricsRegistry } from "./registry";

export const METRICS_TOKEN_HEADER = "x-metrics-token";

/**
 * Optional bearer-token guard for the metrics surfaces.
 *
 * Metrics reveal traffic volume and error rates, so deployments that expose
 * `/metrics` beyond a private network can set `METRICS_TOKEN` to require it.
 * When the variable is unset the endpoints stay open, which is the useful
 * default for a Prometheus sidecar scraping over localhost and keeps existing
 * deployments unchanged.
 */
export function metricsTokenGuard(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const token = env.METRICS_TOKEN;
  return (req, res, next): void => {
    if (!token) {
      next();
      return;
    }
    const header = req.headers[METRICS_TOKEN_HEADER];
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (header === token || bearer === token) {
      next();
      return;
    }
    res.status(401).json({ error: "metrics token required", code: "UNAUTHORIZED" });
  };
}

/** Serve the registry as Prometheus text exposition. */
export function prometheusHandler(registry: MetricsRegistry): RequestHandler {
  return (_req, res): void => {
    refreshProcessMetrics(registry);
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(registry.toPrometheus());
  };
}

/** Serve the registry as a JSON snapshot. */
export function jsonMetricsHandler(registry: MetricsRegistry): RequestHandler {
  return (_req, res): void => {
    refreshProcessMetrics(registry);
    res.json(registry.snapshot());
  };
}
