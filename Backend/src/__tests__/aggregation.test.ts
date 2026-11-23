import {
  AggregationScheduler,
  AggregationStore,
  IndexAggregate,
  PriceObservation,
  aggregateObservations,
  previousRunDate,
  runDailyAggregation,
  toRunDate,
} from "../aggregation/job";

function observation(overrides: Partial<PriceObservation> = {}): PriceObservation {
  return {
    submissionId: "sub-1",
    countryIso: "NG",
    category: "Food",
    value: 100n,
    timestamp: 1_700_000_000,
    submitter: "GAAA",
    status: "verified",
    ...overrides,
  };
}

/** In-memory store mirroring the Postgres lease semantics. */
class FakeAggregationStore implements AggregationStore {
  readonly runs = new Map<string, { claimed: boolean; complete: string | null }>();
  readonly aggregates: IndexAggregate[] = [];
  observations: PriceObservation[] = [];
  failOnList = false;

  async claimRun(runDate: string): Promise<boolean> {
    const run = this.runs.get(runDate);
    if (!run) {
      this.runs.set(runDate, { claimed: true, complete: null });
      return true;
    }
    if (run.complete !== null && run.complete !== "failed") return false;
    run.claimed = true;
    return true;
  }

  async listObservations(): Promise<PriceObservation[]> {
    if (this.failOnList) throw new Error("database unavailable");
    return this.observations;
  }

  async writeAggregate(aggregate: IndexAggregate): Promise<void> {
    const i = this.aggregates.findIndex(
      (a) =>
        a.runDate === aggregate.runDate &&
        a.countryIso === aggregate.countryIso &&
        a.category === aggregate.category
    );
    if (i >= 0) this.aggregates[i] = aggregate;
    else this.aggregates.push(aggregate);
  }

  async completeRun(run: { runDate: string; status: string }): Promise<void> {
    const existing = this.runs.get(run.runDate);
    if (existing) existing.complete = run.status;
  }
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

describe("toRunDate / previousRunDate", () => {
  it("formats a UTC day key", () => {
    expect(toRunDate(new Date("2026-03-04T23:59:59.999Z"))).toBe("2026-03-04");
  });

  it("steps back exactly one day, across month and year boundaries", () => {
    expect(previousRunDate("2026-03-04")).toBe("2026-03-03");
    expect(previousRunDate("2026-03-01")).toBe("2026-02-28");
    expect(previousRunDate("2026-01-01")).toBe("2025-12-31");
  });

  it("returns null for an unparseable date", () => {
    expect(previousRunDate("not-a-date")).toBeNull();
  });
});

describe("aggregateObservations", () => {
  const computedAt = new Date("2026-03-05T01:00:00.000Z");

  it("groups by country and category and averages the values", () => {
    const result = aggregateObservations(
      "2026-03-04",
      [
        observation({ value: 100n }),
        observation({ value: 200n }),
        observation({ value: 300n }),
      ],
      computedAt
    );

    expect(result).toHaveLength(1);
    expect(result[0].sampleCount).toBe(3);
    expect(result[0].totalValue).toBe(600n);
    // Integer division truncates, which is correct for a fixed-point price:
    // rounding up would systematically overstate the cost of living.
    expect(result[0].meanValue).toBe(200n);
    expect(result[0].contributorCount).toBe(1);
  });

  it("separates each (country, category) group", () => {
    const result = aggregateObservations(
      "2026-03-04",
      [
        observation({ countryIso: "NG", category: "Food", value: 100n }),
        observation({ countryIso: "NG", category: "Rent", value: 50_000n }),
        observation({ countryIso: "KE", category: "Food", value: 90n }),
      ],
      computedAt
    );

    expect(result).toHaveLength(3);
    expect(result.map((a) => `${a.countryIso}:${a.category}`).sort()).toEqual([
      "KE:Food",
      "NG:Food",
      "NG:Rent",
    ]);
  });

  it("counts distinct contributors, not observations", () => {
    const result = aggregateObservations(
      "2026-03-04",
      [
        observation({ submitter: "GAAA", value: 100n }),
        observation({ submitter: "GAAA", value: 200n }),
        observation({ submitter: "GBBB", value: 300n }),
      ],
      computedAt
    );

    expect(result[0].sampleCount).toBe(3);
    expect(result[0].contributorCount).toBe(2);
  });

  it("drops non-positive prices rather than skewing the mean", () => {
    const result = aggregateObservations(
      "2026-03-04",
      [observation({ value: 100n }), observation({ value: 0n }), observation({ value: -50n })],
      computedAt
    );

    expect(result[0].sampleCount).toBe(1);
    expect(result[0].meanValue).toBe(100n);
  });

  it("is deterministic: the same input produces the same output", () => {
    const input = [
      observation({ countryIso: "KE", category: "Food", value: 10n }),
      observation({ countryIso: "NG", category: "Food", value: 20n }),
      observation({ countryIso: "NG", category: "Food", value: 30n }),
    ];
    const a = aggregateObservations("2026-03-04", input, computedAt);
    const b = aggregateObservations("2026-03-04", input, computedAt);

    expect(a).toEqual(b);
    // Sorted by (country, category) so a re-run writes in a stable order.
    expect(a.map((x) => x.countryIso)).toEqual(["KE", "NG"]);
  });

  it("returns nothing for an empty input set", () => {
    expect(aggregateObservations("2026-03-04", [], computedAt)).toEqual([]);
  });

  it("carries both the run date and the computation time", () => {
    // Distinct on a catch-up run, so conflating them would make a
    // late-computed historical day look fresh.
    const result = aggregateObservations("2026-03-04", [observation()], computedAt);
    expect(result[0].runDate).toBe("2026-03-04");
    expect(result[0].computedAt).toBe(computedAt);
  });
});

describe("runDailyAggregation", () => {
  it("aggregates and records a successful run", async () => {
    const store = new FakeAggregationStore();
    store.observations = [observation({ value: 100n }), observation({ value: 300n })];

    const run = await runDailyAggregation(store, "2026-03-04");

    expect(run.status).toBe("success");
    expect(run.aggregatesWritten).toBe(1);
    expect(run.error).toBeNull();
    expect(store.aggregates[0].meanValue).toBe(200n);
  });

  it("skips a run that another worker already completed", async () => {
    const store = new FakeAggregationStore();
    store.observations = [observation()];

    await runDailyAggregation(store, "2026-03-04");
    const second = await runDailyAggregation(store, "2026-03-04");

    // The lease is what makes a day exactly-once across replicas.
    expect(second.status).toBe("skipped");
    expect(store.aggregates).toHaveLength(1);
  });

  it("excludes pending and rejected submissions by default", async () => {
    const store = new FakeAggregationStore();
    store.observations = [
      observation({ submissionId: "a", value: 100n, status: "verified" }),
      observation({ submissionId: "b", value: 9_999n, status: "pending" }),
      observation({ submissionId: "c", value: 9_999n, status: "rejected" }),
    ];

    const run = await runDailyAggregation(store, "2026-03-04");

    expect(run.status).toBe("success");
    expect(store.aggregates[0].sampleCount).toBe(1);
    expect(store.aggregates[0].meanValue).toBe(100n);
  });

  it("reports groups below the contributor threshold as partial", async () => {
    const store = new FakeAggregationStore();
    store.observations = [
      observation({ countryIso: "NG", submitter: "GAAA" }),
      observation({ countryIso: "KE", submitter: "GAAA" }),
      observation({ countryIso: "GH", submitter: "GAAA" }),
    ];

    const run = await runDailyAggregation(store, "2026-03-04", { minContributors: 2 });

    expect(run.status).toBe("partial");
    expect(run.aggregatesWritten).toBe(0);
    expect(run.emptyGroups).toBe(3);
    // A thin day is recorded as such rather than silently published as zero.
    expect(store.aggregates).toHaveLength(0);
  });

  it("records a failure without throwing, and leaves the day retryable", async () => {
    const store = new FakeAggregationStore();
    store.failOnList = true;

    const run = await runDailyAggregation(store, "2026-03-04");

    expect(run.status).toBe("failed");
    expect(run.error).toBe("database unavailable");
    expect(store.runs.get("2026-03-04")?.complete).toBe("failed");

    // A failed day is not marked done, so the next tick retries it.
    store.failOnList = false;
    store.observations = [observation()];
    const retried = await runDailyAggregation(store, "2026-03-04");
    expect(retried.status).toBe("success");
  });

  it("overwrites rather than duplicating on a re-run", async () => {
    const store = new FakeAggregationStore();
    store.observations = [observation({ value: 100n })];

    await runDailyAggregation(store, "2026-03-04");
    store.observations = [observation({ value: 100n }), observation({ value: 300n })];
    store.runs.get("2026-03-04")!.complete = "failed";
    await runDailyAggregation(store, "2026-03-04");

    expect(store.aggregates).toHaveLength(1);
    expect(store.aggregates[0].sampleCount).toBe(2);
  });
});

describe("AggregationScheduler", () => {
  const today = new Date("2026-03-05T12:00:00.000Z");

  it("runs today's aggregation when it is still outstanding", async () => {
    const store = new FakeAggregationStore();
    store.observations = [observation()];

    const scheduler = new AggregationScheduler(store, { now: () => today, log: silentLog });
    const run = await scheduler.tick();

    expect(run.runDate).toBe("2026-03-05");
    expect(run.status).toBe("success");
  });

  it("does no work when today is already complete", async () => {
    const store = new FakeAggregationStore();
    store.observations = [observation()];
    const scheduler = new AggregationScheduler(store, { now: () => today, log: silentLog });

    await scheduler.tick();
    const second = await scheduler.tick();

    expect(second.status).toBe("skipped");
  });

  it("catches up a day missed while the process was down", async () => {
    const store = new FakeAggregationStore();
    store.observations = [observation()];
    // Today and yesterday are both already done; the job backfills the day
    // before, which is the recovery-from-downtime path.
    await store.claimRun("2026-03-05");
    store.runs.get("2026-03-05")!.complete = "success";
    await store.claimRun("2026-03-04");
    store.runs.get("2026-03-04")!.complete = "success";

    const scheduler = new AggregationScheduler(store, { now: () => today, log: silentLog });
    const run = await scheduler.tick();

    expect(run.runDate).toBe("2026-03-03");
    expect(run.status).toBe("success");
  });

  it("respects the catch-up window", async () => {
    const store = new FakeAggregationStore();
    store.observations = [observation()];
    // Nothing is done, but the window is one day, so the walk stops at
    // yesterday rather than backfilling an unbounded history.
    const scheduler = new AggregationScheduler(store, {
      now: () => today,
      catchUpDays: 1,
      log: silentLog,
    });

    const run = await scheduler.tick();
    expect(run.status).toBe("success");
    expect(run.runDate).toBe("2026-03-05");
  });

  it("stops cleanly", async () => {
    const scheduler = new AggregationScheduler(new FakeAggregationStore(), { log: silentLog });
    scheduler.start();
    expect(scheduler.isStopped).toBe(false);
    scheduler.stop();
    expect(scheduler.isStopped).toBe(true);
  });
});
