/**
 * In-process metrics registry (issue #679).
 *
 * The backend already wrote latency and error information into log lines, which
 * makes a question like "what is p95 latency on /api/v1/posts right now?" answerable
 * only by grepping logs and cannot be scraped by Prometheus at all. This module
 * is the single place where numeric runtime facts are recorded and read back, so
 * every surface (Prometheus text, JSON snapshot, the health endpoint) reads the
 * same numbers rather than each re-deriving them.
 *
 * Scope: this is a single-process registry, which is the correct grain for a
 * service that exposes its own `/metrics`. Aggregation *across* replicas is the
 * scrape layer's job — a registry that tried to do it would need leader election
 * and would still be wrong during a partition.
 *
 * Design choices worth stating:
 *
 *   - **Definitions before use.** A metric must be declared with its type, help
 *     text and label names. Recording against an undeclared metric throws, which
 *     is deliberate: a typo in a metric name otherwise creates a second, silent
 *     series that no dashboard watches.
 *   - **Canonical labels.** Series keys order labels deterministically and drop
 *     unexpected label names, so the same logical sample can never appear under
 *     two different keys because of object iteration order.
 *   - **Bounded cardinality.** A process that creates a series per unseen value
 *     (an address, a request id) leaks memory without bound and eventually dies.
 *     `maxSeries` caps the registry; once reached, new series are dropped and
 *     counted by `metrics_series_dropped_total` rather than silently accepted.
 *   - **Integers are not assumed.** Counters use `number`; a value can overflow
 *     only after 2^53 observations, which is not reachable within a process
 *     lifetime.
 */

export type MetricType = "counter" | "gauge" | "histogram";

/** Latency buckets in milliseconds, covering a fast cache hit to a slow query. */
export const DEFAULT_LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  /** Declared label names; only these are recorded. */
  labelNames: string[];
  /** Histogram bucket upper bounds. Ignored for counters and gauges. */
  buckets?: readonly number[];
}

export type LabelSet = Record<string, string | number>;

export interface CounterSnapshot {
  name: string;
  type: "counter";
  help: string;
  labels: Record<string, string>;
  value: number;
}

export interface GaugeSnapshot {
  name: string;
  type: "gauge";
  help: string;
  labels: Record<string, string>;
  value: number;
}

export interface HistogramBucketSnapshot {
  /** Upper bound, or `"+Inf"` for the catch-all bucket. */
  le: number | "+Inf";
  count: number;
}

export interface HistogramSnapshot {
  name: string;
  type: "histogram";
  help: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: HistogramBucketSnapshot[];
}

export interface MetricsSnapshot {
  generated_at: string;
  series_count: number;
  counters: CounterSnapshot[];
  gauges: GaugeSnapshot[];
  histograms: HistogramSnapshot[];
}

interface Series {
  definition: MetricDefinition;
  labels: Record<string, string>;
  /** Counter / gauge value. */
  value: number;
  /** Histogram state. */
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketCounts: number[];
}

export interface MetricsRegistryOptions {
  /** Hard cap on distinct series. Defaults to 1000. */
  maxSeries?: number;
}

/** Canonical, deterministic label ordering. */
function canonicalizeLabels(
  definition: MetricDefinition,
  labels: LabelSet | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of definition.labelNames) {
    const raw = labels?.[name];
    out[name] = raw === undefined ? "" : String(raw);
  }
  return out;
}

function seriesKey(definition: MetricDefinition, labels: Record<string, string>): string {
  const parts = definition.labelNames.map((name) => `${name}=${labels[name]}`);
  return `${definition.name}{${parts.join(",")}}`;
}

/**
 * The registry. One instance per application; the module exports a shared
 * default (`metrics`) for code that cannot be handed the instance.
 */
export class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly series = new Map<string, Series>();
  private readonly maxSeries: number;

  constructor(definitions: MetricDefinition[] = [], options: MetricsRegistryOptions = {}) {
    this.maxSeries = options.maxSeries ?? 1000;
    const dropped: MetricDefinition = {
      name: "metrics_series_dropped_total",
      type: "counter",
      help: "Samples dropped because the registry reached its series cap.",
      labelNames: [],
    };
    this.define(dropped);
    for (const definition of definitions) this.define(definition);
  }

  /** Declare a metric. Re-declaring an identical definition is a no-op. */
  define(definition: MetricDefinition): void {
    const existing = this.definitions.get(definition.name);
    if (existing) {
      if (existing.type !== definition.type) {
        throw new Error(
          `metric ${definition.name} already defined as ${existing.type}, cannot redefine as ${definition.type}`
        );
      }
      return;
    }
    this.definitions.set(definition.name, definition);
    // A metric with no labels has exactly one series, so create it up front.
    // An operator scraping a service that has not served a request yet should
    // see `http_requests_in_flight 0` / `service_up 0`, not an absent metric
    // that is indistinguishable from a broken exporter.
    if (definition.labelNames.length === 0) {
      this.getOrCreate(definition);
    }
  }

  /** True when the metric has been declared. */
  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /** Number of live series; useful for cardinality debugging. */
  seriesCount(): number {
    return this.series.size;
  }

  increment(name: string, labels?: LabelSet, by = 1): void {
    const definition = this.definitionFor(name, "counter");
    const series = this.getOrCreate(definition, labels);
    if (series) series.value += by;
  }

  setGauge(name: string, value: number, labels?: LabelSet): void {
    const definition = this.definitionFor(name, "gauge");
    const series = this.getOrCreate(definition, labels);
    if (series) series.value = value;
  }

  observe(name: string, value: number, labels?: LabelSet): void {
    const definition = this.definitionFor(name, "histogram");
    const series = this.getOrCreate(definition, labels);
    if (!series) return;
    series.count += 1;
    series.sum += value;
    series.min = Math.min(series.min, value);
    series.max = Math.max(series.max, value);
    const buckets = definition.buckets ?? DEFAULT_LATENCY_BUCKETS_MS;
    for (let i = 0; i < buckets.length; i += 1) {
      if (value <= buckets[i]) {
        series.bucketCounts[i] += 1;
        // Buckets are cumulative in exposition, so only the first matching
        // bucket increments — later buckets are derived at render time.
        break;
      }
    }
    if (value > buckets[buckets.length - 1]) {
      series.bucketCounts[buckets.length] += 1;
    }
  }

  /** Deterministic snapshot of every series, sorted by metric then labels. */
  snapshot(now: () => Date = () => new Date()): MetricsSnapshot {
    const counters: CounterSnapshot[] = [];
    const gauges: GaugeSnapshot[] = [];
    const histograms: HistogramSnapshot[] = [];

    for (const series of this.sortedSeries()) {
      const { definition, labels } = series;
      if (definition.type === "counter") {
        counters.push({
          name: definition.name,
          type: "counter",
          help: definition.help,
          labels,
          value: series.value,
        });
      } else if (definition.type === "gauge") {
        gauges.push({
          name: definition.name,
          type: "gauge",
          help: definition.help,
          labels,
          value: series.value,
        });
      } else {
        histograms.push(this.histogramSnapshot(series));
      }
    }

    return {
      generated_at: now().toISOString(),
      series_count: this.series.size,
      counters,
      gauges,
      histograms,
    };
  }

  /** Render every defined metric in the Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];

    // Group series by metric so each metric's HELP/TYPE block is contiguous.
    const byName = new Map<string, Series[]>();
    for (const series of this.series.values()) {
      const list = byName.get(series.definition.name) ?? [];
      list.push(series);
      byName.set(series.definition.name, list);
    }

    // Every declared metric is emitted, even with no samples. A metric that
    // vanishes when idle breaks dashboards and alerts, and makes "no traffic"
    // indistinguishable from "exporter broken".
    for (const definition of this.definitions.values()) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);

      const seriesList = (byName.get(definition.name) ?? []).sort((a, b) =>
        seriesKey(a.definition, a.labels).localeCompare(seriesKey(b.definition, b.labels))
      );

      for (const series of seriesList) {
        if (definition.type === "histogram") {
          const buckets = definition.buckets ?? DEFAULT_LATENCY_BUCKETS_MS;
          let cumulative = 0;
          for (let i = 0; i < buckets.length; i += 1) {
            cumulative += series.bucketCounts[i];
            lines.push(
              `${definition.name}_bucket${renderLabels(series.labels, { le: String(buckets[i]) })} ${cumulative}`
            );
          }
          cumulative += series.bucketCounts[buckets.length];
          lines.push(
            `${definition.name}_bucket${renderLabels(series.labels, { le: "+Inf" })} ${cumulative}`
          );
          lines.push(`${definition.name}_sum${renderLabels(series.labels)} ${series.sum}`);
          lines.push(`${definition.name}_count${renderLabels(series.labels)} ${series.count}`);
        } else {
          lines.push(`${definition.name}${renderLabels(series.labels)} ${series.value}`);
        }
      }
    }

    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }

  reset(): void {
    this.series.clear();
    // Re-create the eager, label-less series so `reset()` returns to the same
    // shape the registry started with.
    for (const definition of this.definitions.values()) {
      if (definition.labelNames.length === 0) this.getOrCreate(definition);
    }
  }

  private definitionFor(name: string, expected: MetricType): MetricDefinition {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`metric ${name} is not defined; call define() before recording`);
    }
    if (definition.type !== expected) {
      throw new Error(`metric ${name} is a ${definition.type}, not a ${expected}`);
    }
    return definition;
  }

  private getOrCreate(definition: MetricDefinition, labels?: LabelSet): Series | undefined {
    const canonical = canonicalizeLabels(definition, labels);
    const key = seriesKey(definition, canonical);
    const existing = this.series.get(key);
    if (existing) return existing;

    if (this.series.size >= this.maxSeries) {
      // Count the drop, but never let the drop itself grow the registry further.
      const dropSeries = [...this.series.values()].find(
        (s) => s.definition.name === "metrics_series_dropped_total"
      );
      if (dropSeries) dropSeries.value += 1;
      return undefined;
    }

    const buckets =
      definition.type === "histogram" ? (definition.buckets ?? DEFAULT_LATENCY_BUCKETS_MS) : [];
    const series: Series = {
      definition,
      labels: canonical,
      value: 0,
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      bucketCounts: new Array(buckets.length + 1).fill(0),
    };
    this.series.set(key, series);
    return series;
  }

  private histogramSnapshot(series: Series): HistogramSnapshot {
    const buckets = series.definition.buckets ?? DEFAULT_LATENCY_BUCKETS_MS;
    const rendered: HistogramBucketSnapshot[] = [];
    let cumulative = 0;
    for (let i = 0; i < buckets.length; i += 1) {
      cumulative += series.bucketCounts[i];
      rendered.push({ le: buckets[i], count: cumulative });
    }
    cumulative += series.bucketCounts[buckets.length];
    rendered.push({ le: "+Inf", count: cumulative });

    return {
      name: series.definition.name,
      type: "histogram",
      help: series.definition.help,
      labels: series.labels,
      count: series.count,
      sum: series.sum,
      // An empty histogram has no observed minimum; report 0 rather than
      // Infinity so the JSON payload stays valid and comparable.
      min: series.count === 0 ? 0 : series.min,
      max: series.count === 0 ? 0 : series.max,
      buckets: rendered,
    };
  }

  private sortedSeries(): Series[] {
    return [...this.series.values()].sort((a, b) =>
      seriesKey(a.definition, a.labels).localeCompare(seriesKey(b.definition, b.labels))
    );
  }
}

/** Render a `{k="v"}` label block; empty when there are no labels. */
function renderLabels(labels: Record<string, string>, extra: Record<string, string> = {}): string {
  const entries = Object.entries({ ...labels, ...extra }).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  const body = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
  return `{${body}}`;
}

/** Escape a label value per the Prometheus exposition format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
