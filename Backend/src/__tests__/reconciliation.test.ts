import {
  Discrepancy,
  ReconcileTotals,
  ReconciliationLogger,
  ReconciliationReport,
  ReconciliationScheduler,
  ReconciliationStore,
  reconcile,
  runDailyReconciliation,
  toRunDate,
} from "../reconciliation/job";

const silentLog: ReconciliationLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function totals(
  countryIso: string,
  category: string,
  count: number,
  totalValue: bigint
): ReconcileTotals {
  return { countryIso, category, count, totalValue };
}

class FakeReconciliationStore implements ReconciliationStore {
  claimed = new Set<string>();
  source: ReconcileTotals[] = [];
  aggregates: ReconcileTotals[] = [];
  written: Discrepancy[] | null = null;
  report: ReconciliationReport | null = null;
  failLoad = false;

  async claimRun(runDate: string): Promise<boolean> {
    if (this.claimed.has(runDate)) return false;
    this.claimed.add(runDate);
    return true;
  }

  async loadSourceTotals(): Promise<ReconcileTotals[]> {
    if (this.failLoad) throw new Error("source unavailable");
    return this.source;
  }

  async loadAggregateTotals(): Promise<ReconcileTotals[]> {
    return this.aggregates;
  }

  async writeDiscrepancies(_runDate: string, discrepancies: Discrepancy[]): Promise<void> {
    this.written = discrepancies;
  }

  async completeRun(report: ReconciliationReport): Promise<void> {
    this.report = report;
  }
}

describe("reconcile (#669)", () => {
  it("reports no discrepancies for identical sides", () => {
    const result = reconcile([totals("NG", "rent", 3, 300n)], [totals("NG", "rent", 3, 300n)]);
    expect(result.discrepancies).toEqual([]);
    expect(result.matchedGroups).toBe(1);
  });

  it("detects a source group with no aggregate", () => {
    const result = reconcile([totals("NG", "rent", 2, 20n)], []);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: "missing_aggregate",
      sourceCount: 2,
      aggregateCount: null,
    });
  });

  it("detects a stale aggregate with no source", () => {
    const result = reconcile([], [totals("NG", "rent", 2, 20n)]);
    expect(result.discrepancies[0]).toMatchObject({
      kind: "missing_source",
      sourceCount: null,
      aggregateCount: 2,
    });
  });

  it("detects a count mismatch and reports the delta", () => {
    const result = reconcile([totals("NG", "rent", 5, 50n)], [totals("NG", "rent", 3, 30n)]);
    // A count mismatch is reported alone, not also as a value mismatch.
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({
      kind: "count_mismatch",
      countDelta: 2,
      valueDelta: null,
    });
  });

  it("detects a value mismatch when counts agree but totals do not", () => {
    const result = reconcile([totals("NG", "rent", 3, 500n)], [totals("NG", "rent", 3, 450n)]);
    expect(result.discrepancies[0]).toMatchObject({
      kind: "value_mismatch",
      countDelta: 0,
      valueDelta: "50",
    });
  });

  it("checks every group on either side and sorts the output", () => {
    const result = reconcile(
      [totals("NG", "rent", 1, 1n), totals("KE", "food", 1, 1n)],
      [totals("NG", "rent", 1, 1n)]
    );
    // KE has source but no aggregate; NG matches.
    expect(result.sourceGroups).toBe(2);
    expect(result.aggregateGroups).toBe(1);
    expect(result.matchedGroups).toBe(1);
    expect(result.discrepancies.map((d) => d.countryIso)).toEqual(["KE"]);
  });

  it("returns an empty result for two empty sides", () => {
    const result = reconcile([], []);
    expect(result.discrepancies).toEqual([]);
    expect(result.matchedGroups).toBe(0);
  });
});

describe("runDailyReconciliation (#669)", () => {
  it("records a balanced run and persists no discrepancies", async () => {
    const store = new FakeReconciliationStore();
    store.source = [totals("NG", "rent", 3, 300n)];
    store.aggregates = [totals("NG", "rent", 3, 300n)];

    const report = await runDailyReconciliation(store, "2026-09-25");

    expect(report.status).toBe("balanced");
    expect(store.written).toEqual([]);
    expect(store.report?.status).toBe("balanced");
  });

  it("records discrepancies when the sides differ", async () => {
    const store = new FakeReconciliationStore();
    store.source = [totals("NG", "rent", 3, 300n)];
    store.aggregates = [];

    const report = await runDailyReconciliation(store, "2026-09-25");

    expect(report.status).toBe("discrepancies");
    expect(report.discrepancyCount).toBe(1);
    expect(store.written).toHaveLength(1);
  });

  it("skips a day another worker already owns", async () => {
    const store = new FakeReconciliationStore();
    store.claimed.add("2026-09-25");

    const report = await runDailyReconciliation(store, "2026-09-25");

    expect(report.status).toBe("skipped");
    expect(store.report).toBeNull();
  });

  it("records a failed run instead of throwing when the source is unavailable", async () => {
    const store = new FakeReconciliationStore();
    store.failLoad = true;

    const report = await runDailyReconciliation(store, "2026-09-25");

    expect(report.status).toBe("failed");
    expect(report.error).toMatch(/source unavailable/);
    expect(store.report?.status).toBe("failed");
  });
});

describe("ReconciliationScheduler (#669)", () => {
  const now = () => new Date("2026-09-26T12:00:00.000Z");

  it("reconciles today when it is still outstanding", async () => {
    const store = new FakeReconciliationStore();
    const scheduler = new ReconciliationScheduler(store, { now, log: silentLog });

    const report = await scheduler.tick();

    expect(report.runDate).toBe("2026-09-26");
    expect(store.claimed.has("2026-09-26")).toBe(true);
  });

  it("catches up a day missed while the process was down", async () => {
    const store = new FakeReconciliationStore();
    // Today is already claimed by another worker; yesterday is not.
    store.claimed.add("2026-09-26");
    const scheduler = new ReconciliationScheduler(store, { now, log: silentLog });

    const report = await scheduler.tick();

    expect(report.runDate).toBe("2026-09-25");
    expect(store.claimed.has("2026-09-25")).toBe(true);
  });

  it("logs a warning when discrepancies are found", async () => {
    const store = new FakeReconciliationStore();
    store.source = [totals("NG", "rent", 2, 20n)];
    const log: ReconciliationLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const scheduler = new ReconciliationScheduler(store, { now, log });

    await scheduler.tick();

    expect(log.warn).toHaveBeenCalledWith(
      "daily_reconciliation_discrepancies",
      expect.objectContaining({ runDate: "2026-09-26" })
    );
  });

  it("stops cleanly", () => {
    const store = new FakeReconciliationStore();
    const scheduler = new ReconciliationScheduler(store, { now, log: silentLog });
    scheduler.start();
    scheduler.stop();
    expect(scheduler.isStopped).toBe(true);
  });
});

describe("toRunDate", () => {
  it("formats a UTC day key", () => {
    expect(toRunDate(new Date("2026-09-26T23:59:59.000Z"))).toBe("2026-09-26");
  });
});
