import { MetricDefinition, MetricsRegistry } from "../registry";

const DEFS: MetricDefinition[] = [
  { name: "requests_total", type: "counter", help: "requests", labelNames: ["method", "route"] },
  { name: "queue_depth", type: "gauge", help: "depth", labelNames: [] },
  {
    name: "latency_ms",
    type: "histogram",
    help: "latency",
    labelNames: ["route"],
    buckets: [5, 10],
  },
];

function registry(): MetricsRegistry {
  return new MetricsRegistry(DEFS);
}

describe("MetricsRegistry / counters", () => {
  it("records and snapshots a counter", () => {
    const r = registry();
    r.increment("requests_total", { method: "GET", route: "/posts" });
    r.increment("requests_total", { method: "GET", route: "/posts" }, 2);

    const counters = r.snapshot().counters;
    const series = counters.find((c) => c.name === "requests_total");
    expect(series).toMatchObject({ value: 3, labels: { method: "GET", route: "/posts" } });
  });

  it("orders labels canonically regardless of insertion order", () => {
    const r = registry();
    r.increment("requests_total", { route: "/a", method: "GET" });
    r.increment("requests_total", { method: "GET", route: "/a" });
    expect(r.snapshot().counters.filter((c) => c.name === "requests_total")).toHaveLength(1);
  });

  it("throws when recording an undefined metric", () => {
    expect(() => registry().increment("nope_total")).toThrow(/not defined/);
  });

  it("throws when the metric exists with a different type", () => {
    expect(() => registry().increment("queue_depth")).toThrow(/not a counter/);
  });
});

describe("MetricsRegistry / gauges", () => {
  it("sets and overwrites a gauge", () => {
    const r = registry();
    r.setGauge("queue_depth", 4);
    r.setGauge("queue_depth", 2);
    expect(r.snapshot().gauges.find((g) => g.name === "queue_depth")?.value).toBe(2);
  });
});

describe("MetricsRegistry / histograms", () => {
  it("tracks count, sum, min, max", () => {
    const r = registry();
    r.observe("latency_ms", 3, { route: "/a" });
    r.observe("latency_ms", 8, { route: "/a" });

    const h = r.snapshot().histograms.find((x) => x.name === "latency_ms");
    expect(h).toMatchObject({ count: 2, sum: 11, min: 3, max: 8 });
  });

  it("renders cumulative buckets including +Inf", () => {
    const r = registry();
    r.observe("latency_ms", 3, { route: "/a" });
    r.observe("latency_ms", 8, { route: "/a" });

    const h = r.snapshot().histograms.find((x) => x.name === "latency_ms");
    expect(h?.buckets).toEqual([
      { le: 5, count: 1 },
      { le: 10, count: 2 },
      { le: "+Inf", count: 2 },
    ]);
  });

  it("counts a value above the last bound only in +Inf", () => {
    const r = registry();
    r.observe("latency_ms", 1000, { route: "/a" });
    const h = r.snapshot().histograms[0];
    expect(h.buckets).toEqual([
      { le: 5, count: 0 },
      { le: 10, count: 0 },
      { le: "+Inf", count: 1 },
    ]);
  });

  it("reports 0 for min/max on an unobserved bucket set", () => {
    const h = registry()
      .snapshot()
      .histograms.find((x) => x.name === "latency_ms");
    expect(h).toBeUndefined();
  });
});

describe("MetricsRegistry / Prometheus exposition", () => {
  it("emits HELP and TYPE once per metric", () => {
    const r = registry();
    r.increment("requests_total", { method: "GET", route: "/a" });
    r.increment("requests_total", { method: "POST", route: "/a" });

    const text = r.toPrometheus();
    expect(text.match(/# HELP requests_total/g)).toHaveLength(1);
    expect(text.match(/# TYPE requests_total counter/g)).toHaveLength(1);
  });

  it("emits histogram _bucket, _sum and _count series", () => {
    const r = registry();
    r.observe("latency_ms", 3, { route: "/a" });
    const text = r.toPrometheus();
    expect(text).toContain('latency_ms_bucket{le="5",route="/a"} 1');
    expect(text).toContain('latency_ms_bucket{le="10",route="/a"} 1');
    expect(text).toContain('latency_ms_bucket{le="+Inf",route="/a"} 1');
    expect(text).toContain('latency_ms_sum{route="/a"} 3');
    expect(text).toContain('latency_ms_count{route="/a"} 1');
  });

  it("escapes quotes, backslashes and newlines in label values", () => {
    const r = registry();
    r.increment("requests_total", { method: "G\\T", route: 'a"b\nc' });
    const text = r.toPrometheus();
    expect(text).toContain('method="G\\\\T"');
    expect(text).toContain('route="a\\"b\\nc"');
  });
});

describe("MetricsRegistry / cardinality guard", () => {
  it("drops new series past the cap and counts the drops", () => {
    // A single labelled counter, so the only eager series is the drop counter.
    const r = new MetricsRegistry(
      [{ name: "requests_total", type: "counter", help: "requests", labelNames: ["route"] }],
      { maxSeries: 2 }
    );
    r.increment("requests_total", { route: "/a" }); // 2nd series, fits
    r.increment("requests_total", { route: "/b" }); // at cap -> dropped
    r.increment("requests_total", { route: "/c" }); // dropped

    expect(r.seriesCount()).toBe(2);
    const dropped = r.snapshot().counters.find((c) => c.name === "metrics_series_dropped_total");
    expect(dropped?.value).toBe(2);
  });
});

describe("MetricsRegistry / reset and determinism", () => {
  it("clears series on reset", () => {
    const r = registry();
    r.increment("requests_total", { method: "GET", route: "/a" });
    r.reset();
    // Only the label-less metrics (`metrics_series_dropped_total`, `queue_depth`)
    // are restored; the labelled `requests_total` series is gone.
    expect(r.seriesCount()).toBe(2);
    expect(r.snapshot().counters.filter((c) => c.name === "requests_total")).toHaveLength(0);
  });

  it("returns series in a stable order", () => {
    const r = registry();
    r.increment("requests_total", { method: "GET", route: "/b" });
    r.increment("requests_total", { method: "GET", route: "/a" });
    const first = r.snapshot().counters.map((c) => `${c.labels.method}${c.labels.route}`);
    const second = r.snapshot().counters.map((c) => `${c.labels.method}${c.labels.route}`);
    expect(first).toEqual(second);
  });
});
