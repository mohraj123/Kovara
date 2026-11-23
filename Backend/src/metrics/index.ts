/**
 * Centralized backend metrics (#679).
 *
 * Import from here — `src/metrics` is the only supported entry point. The named
 * exports let a caller inject a registry (tests, an embedder with a different
 * scrape policy), while `metrics` is the process-wide default that any module
 * can record into without being handed the instance.
 */
export {
  MetricsRegistry,
  DEFAULT_LATENCY_BUCKETS_MS,
  type MetricDefinition,
  type MetricType,
  type LabelSet,
  type MetricsSnapshot,
  type CounterSnapshot,
  type GaugeSnapshot,
  type HistogramSnapshot,
  type HistogramBucketSnapshot,
  type MetricsRegistryOptions,
} from "./registry";

export {
  HTTP_METRIC_DEFINITIONS,
  normalizeRoute,
  createMetricsMiddleware,
  refreshProcessMetrics,
  type MetricsMiddlewareOptions,
} from "./http";

export {
  METRICS_TOKEN_HEADER,
  metricsTokenGuard,
  prometheusHandler,
  jsonMetricsHandler,
} from "./routes";

import { HTTP_METRIC_DEFINITIONS } from "./http";
import { MetricsRegistry } from "./registry";

/**
 * The process-wide registry. Every HTTP request and the health probe record
 * here, and both `/metrics` surfaces read from it.
 */
export const metrics = new MetricsRegistry(HTTP_METRIC_DEFINITIONS);
