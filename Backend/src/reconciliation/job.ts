/**
 * Scheduled daily reconciliation (#669).
 *
 * The aggregation job (#651) reduces raw price submissions into a published
 * index. It runs once a day and writes its aggregates idempotently — which
 * means a run that silently produced the *wrong* aggregate is indistinguishable
 * from one that produced the right one. Nothing compares the index back to the
 * submissions it came from.
 *
 * This job is that comparison. Once a day it reads both sides — the verified
 * `price_submissions` for a day, and the `price_index_aggregates` computed for
 * that day — and reports every difference:
 *
 *   - a group with submissions but no aggregate  → the aggregation dropped it;
 *   - a group with an aggregate but no submissions → the aggregate is stale;
 *   - a group whose counts differ                 → the aggregate saw a
 *     different sample;
 *   - a group whose total value differs           → the aggregate's numbers do
 *     not add up to its inputs.
 *
 * Three design choices follow from the acceptance criteria:
 *
 *   1. **Triggered on schedule.** {@link ReconciliationScheduler} mirrors the
 *      aggregation scheduler: an in-process timer, a daily lease so a day is
 *      reconciled once across replicas, and an immediate catch-up of the most
 *      recent outstanding day. A comparison that only ran when someone
 *      remembered to click it would not catch the drift it exists to catch.
 *   2. **Differences are detected, not just logged.** The pure
 *      {@link reconcile} function returns a structured discrepancy list; the
 *      job persists it. A log line is not a reporting surface and cannot be
 *      queried.
 *   3. **Results are visible.** Every run is recorded (balanced, discrepancies,
 *      or failed) and the discrepancies are durable, so `GET /reconciliation`
 *      can answer "was yesterday's index consistent, and if not, where".
 *
 * The job never repairs anything. Reconciling and repairing in one step would
 * make a bug that corrupts data corrupt it with automatic approval; detecting
 * and reporting leaves the decision to an operator, which is what a data
 * integrity check is for.
 */

/** One side's totals for a (country, category) group. */
export interface ReconcileTotals {
  countryIso: string;
  category: string;
  /** Number of observations that went into the group. */
  count: number;
  /** Sum of the observation values, in the contract's smallest unit. */
  totalValue: bigint;
}

/** Why a group differs between source and aggregate. */
export type DiscrepancyKind =
  | "missing_aggregate"
  | "missing_source"
  | "count_mismatch"
  | "value_mismatch";

/** A single difference between the source and the aggregate for one group. */
export interface Discrepancy {
  countryIso: string;
  category: string;
  kind: DiscrepancyKind;
  sourceCount: number | null;
  aggregateCount: number | null;
  sourceValue: string | null;
  aggregateValue: string | null;
  /** source − aggregate, when both sides exist. */
  countDelta: number | null;
  valueDelta: string | null;
}

/** Outcome of one reconciliation run. */
export type ReconciliationStatus = "balanced" | "discrepancies" | "skipped" | "failed";

/** The durable record of a run. */
export interface ReconciliationReport {
  runDate: string;
  status: ReconciliationStatus;
  sourceGroups: number;
  aggregateGroups: number;
  matchedGroups: number;
  discrepancyCount: number;
  discrepancies: Discrepancy[];
  error: string | null;
  startedAt: Date;
  completedAt: Date;
}

/** The persistence surface the job needs. */
export interface ReconciliationStore {
  /**
   * Atomically claim the run for `runDate`. Returns false when another worker
   * (or a completed run) already owns the day.
   */
  claimRun(runDate: string): Promise<boolean>;
  /** Verified source totals for `runDate`, grouped by (country, category). */
  loadSourceTotals(runDate: string): Promise<ReconcileTotals[]>;
  /** Aggregate totals written for `runDate`, grouped the same way. */
  loadAggregateTotals(runDate: string): Promise<ReconcileTotals[]>;
  /** Replace the discrepancy rows for a run. Idempotent on (runDate, group). */
  writeDiscrepancies(runDate: string, discrepancies: Discrepancy[]): Promise<void>;
  /** Record the terminal state of the run. */
  completeRun(report: ReconciliationReport): Promise<void>;
}

/** Counts summarising a reconciliation, useful for tests and reporting. */
export interface ReconcileResult {
  discrepancies: Discrepancy[];
  sourceGroups: number;
  aggregateGroups: number;
  matchedGroups: number;
}

/**
 * Compare source totals against aggregate totals.
 *
 * Pure and deterministic: keyed by (country, category), every group on either
 * side is examined, so a group present on only one side is a discrepancy rather
 * than something silently skipped. The output is sorted by (country, category)
 * so two runs over the same data produce byte-identical reports and a diff
 * between them is meaningful.
 */
export function reconcile(
  source: ReconcileTotals[],
  aggregates: ReconcileTotals[]
): ReconcileResult {
  const sourceByKey = indexByGroup(source);
  const aggregateByKey = indexByGroup(aggregates);

  const keys = new Set<string>([...sourceByKey.keys(), ...aggregateByKey.keys()]);
  const discrepancies: Discrepancy[] = [];
  let matchedGroups = 0;

  for (const key of keys) {
    const s = sourceByKey.get(key);
    const a = aggregateByKey.get(key);

    if (s && !a) {
      discrepancies.push({
        ...splitKey(key),
        kind: "missing_aggregate",
        sourceCount: s.count,
        aggregateCount: null,
        sourceValue: s.totalValue.toString(),
        aggregateValue: null,
        countDelta: null,
        valueDelta: null,
      });
      continue;
    }

    if (!s && a) {
      discrepancies.push({
        ...splitKey(key),
        kind: "missing_source",
        sourceCount: null,
        aggregateCount: a.count,
        sourceValue: null,
        aggregateValue: a.totalValue.toString(),
        countDelta: null,
        valueDelta: null,
      });
      continue;
    }

    // Both sides exist.
    const sourceCount = s!.count;
    const aggregateCount = a!.count;

    if (sourceCount !== aggregateCount) {
      // A count mismatch is reported alone: the totals are derived from the
      // counts, so a differing count inevitably differs in value, and reporting
      // both would double-count one corruption as two findings.
      discrepancies.push({
        ...splitKey(key),
        kind: "count_mismatch",
        sourceCount,
        aggregateCount,
        sourceValue: s!.totalValue.toString(),
        aggregateValue: a!.totalValue.toString(),
        countDelta: sourceCount - aggregateCount,
        valueDelta: null,
      });
      continue;
    }

    if (s!.totalValue !== a!.totalValue) {
      const delta = s!.totalValue - a!.totalValue;
      discrepancies.push({
        ...splitKey(key),
        kind: "value_mismatch",
        sourceCount,
        aggregateCount,
        sourceValue: s!.totalValue.toString(),
        aggregateValue: a!.totalValue.toString(),
        countDelta: 0,
        valueDelta: delta.toString(),
      });
      continue;
    }

    matchedGroups += 1;
  }

  discrepancies.sort(
    (x, y) => x.countryIso.localeCompare(y.countryIso) || x.category.localeCompare(y.category)
  );

  return {
    discrepancies,
    sourceGroups: sourceByKey.size,
    aggregateGroups: aggregateByKey.size,
    matchedGroups,
  };
}

function indexByGroup(totals: ReconcileTotals[]): Map<string, ReconcileTotals> {
  const map = new Map<string, ReconcileTotals>();
  for (const total of totals) {
    map.set(`${total.countryIso}:${total.category}`, total);
  }
  return map;
}

function splitKey(key: string): { countryIso: string; category: string } {
  const separator = key.indexOf(":");
  return {
    countryIso: key.slice(0, separator),
    category: key.slice(separator + 1),
  };
}

/** Format a date as the UTC `YYYY-MM-DD` day key the job reconciles by. */
export function toRunDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The UTC day before `runDate`, for the catch-up walk. */
export function previousRunDate(runDate: string): string | null {
  const parsed = Date.parse(`${runDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return null;
  return toRunDate(new Date(parsed - 86_400_000));
}

/** Minimum surface the job needs from the logger. */
export interface ReconciliationLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ReconciliationOptions {
  /** Injectable clock, for tests. */
  now?: () => Date;
}

/**
 * Run reconciliation once for `runDate`.
 *
 * A store failure is recorded on the run, not thrown: a database blip during a
 * scheduled job must be visible in the run history and retried on the next
 * tick, not crash the process that also serves the API.
 */
export async function runDailyReconciliation(
  store: ReconciliationStore,
  runDate: string,
  options: ReconciliationOptions = {}
): Promise<ReconciliationReport> {
  const { now = () => new Date() } = options;
  const startedAt = now();

  const claimed = await store.claimRun(runDate);
  if (!claimed) {
    // Another worker owns this day, or it already completed. Reported as
    // `skipped` rather than `balanced` so the scheduler can tell "nothing to
    // do here" from "the check ran and found the data consistent" and continue
    // walking back to a day that still needs a run.
    return {
      runDate,
      status: "skipped",
      sourceGroups: 0,
      aggregateGroups: 0,
      matchedGroups: 0,
      discrepancyCount: 0,
      discrepancies: [],
      error: null,
      startedAt,
      completedAt: now(),
    };
  }

  let report: ReconciliationReport;

  try {
    const [source, aggregates] = await Promise.all([
      store.loadSourceTotals(runDate),
      store.loadAggregateTotals(runDate),
    ]);

    const result = reconcile(source, aggregates);

    await store.writeDiscrepancies(runDate, result.discrepancies);

    report = {
      runDate,
      status: result.discrepancies.length > 0 ? "discrepancies" : "balanced",
      sourceGroups: result.sourceGroups,
      aggregateGroups: result.aggregateGroups,
      matchedGroups: result.matchedGroups,
      discrepancyCount: result.discrepancies.length,
      discrepancies: result.discrepancies,
      error: null,
      startedAt,
      completedAt: now(),
    };
  } catch (err) {
    report = {
      runDate,
      status: "failed",
      sourceGroups: 0,
      aggregateGroups: 0,
      matchedGroups: 0,
      discrepancyCount: 0,
      discrepancies: [],
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: now(),
    };
  }

  await store.completeRun(report);
  return report;
}

export interface ReconciliationSchedulerOptions {
  /** Milliseconds between ticks. Default: one hour. */
  intervalMs?: number;
  /** How many days back to catch up when a run is outstanding. Default: 7. */
  catchUpDays?: number;
  /** Injectable clock, for tests. */
  now?: () => Date;
  /** Log sink. Defaults to the console. */
  log?: ReconciliationLogger;
}

export const DEFAULT_RECONCILIATION_INTERVAL_MS = 3_600_000;
export const DEFAULT_RECONCILIATION_CATCH_UP_DAYS = 7;

/**
 * Drives `runDailyReconciliation` on a timer.
 *
 * Each tick walks back from today one day at a time and reconciles the first
 * day whose lease it can claim, exactly as the aggregation scheduler does.
 * Stopping at the first claimable day means a healthy system does one cheap
 * claim per tick, and a missed window is filled in order on the next tick.
 */
export class ReconciliationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly store: ReconciliationStore,
    private readonly options: ReconciliationSchedulerOptions = {}
  ) {}

  /** Reconcile the most recent day that is still outstanding. */
  async tick(): Promise<ReconciliationReport> {
    const {
      catchUpDays = DEFAULT_RECONCILIATION_CATCH_UP_DAYS,
      now = () => new Date(),
      log = console,
    } = this.options;

    const today = toRunDate(now());
    let runDate: string | null = today;

    for (let i = 0; i < catchUpDays && runDate !== null; i++) {
      const report = await runDailyReconciliation(this.store, runDate, { now });
      if (report.status === "skipped") {
        runDate = previousRunDate(runDate);
        continue;
      }
      if (report.status === "failed") {
        // A failure is surfaced loudly: it means the check did not run, which
        // is itself a data-integrity signal operators need.
        log.error("daily_reconciliation_failed", {
          runDate: report.runDate,
          error: report.error,
        });
        return report;
      }
      if (report.discrepancyCount > 0) {
        log.warn("daily_reconciliation_discrepancies", {
          runDate: report.runDate,
          discrepancies: report.discrepancyCount,
          matchedGroups: report.matchedGroups,
        });
        return report;
      }
      // Balanced. A balanced run still ends the tick, so a completed day is not
      // re-walked; only a day that was skipped (another worker owns it) moves on.
      log.info("daily_reconciliation_completed", {
        runDate: report.runDate,
        matchedGroups: report.matchedGroups,
      });
      return report;
    }

    return {
      runDate: today,
      status: "skipped",
      sourceGroups: 0,
      aggregateGroups: 0,
      matchedGroups: 0,
      discrepancyCount: 0,
      discrepancies: [],
      error: null,
      startedAt: now(),
      completedAt: now(),
    };
  }

  /** Start ticking; the first tick runs immediately. */
  start(): void {
    const { intervalMs = DEFAULT_RECONCILIATION_INTERVAL_MS, log = console } = this.options;
    this.stopped = false;

    void (async () => {
      try {
        await this.tick();
      } catch (err) {
        log.error("daily_reconciliation_tick_failed", { err });
      }
    })();

    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((err) => {
          log.error("daily_reconciliation_tick_failed", { err });
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);

    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop ticking. Safe to call when not started. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Whether the scheduler has been stopped. */
  get isStopped(): boolean {
    return this.stopped;
  }
}
