/**
 * Scheduled daily price-index aggregation.
 *
 * Issue #651. The price-vault contract accumulates individual `PriceSubmission`
 * records — one per (country, category, valid_from) — but nothing on-chain
 * reduces them to an index. This job is the off-chain reduction: once a day it
 * reads the submissions valid for a given day and writes one aggregate row per
 * (country, category).
 *
 * Three requirements shape the design, and they pull against each other:
 *
 *   - **Scheduled and executed reliably.** An in-process `setInterval` is the
 *     simplest thing that could work and the least reliable: it drifts, it does
 *     not run at all if the process is down at the scheduled moment, and two
 *     replicas both run it. {@link AggregationScheduler} therefore takes a
 *     lease keyed on the run date, so a given day is aggregated exactly once
 *     across every replica, and it runs immediately on start if today's run is
 *     still outstanding — which is what recovers a window that was missed
 *     while the process was down.
 *
 *   - **Outputs stored with a clear timestamp.** Every row carries
 *     `runDate` (the day being summarised, in UTC) and `computedAt` (when the
 *     job actually ran). Those are different on a catch-up run, and conflating
 *     them would make a late-computed historical day indistinguishable from a
 *     fresh one. The unique key on (run_date, country, category) makes the
 *     write idempotent, so a repeated run overwrites rather than duplicates.
 *
 *   - **Failures surfaced to operators.** A failed run is recorded as a row
 *     with `status = 'failed'` and the error text, not swallowed. The run is
 *     reported through the structured logger (which routes to alerting, see
 *     #683) with a stable event name so it can be alerted on. A day whose run
 *     failed is *not* marked done, so the next tick retries it.
 *
 * Aggregation itself is deliberately a plain mean in this issue. The issue asks
 * for the job to exist and run reliably; median/weighted computation, outlier
 * rejection, and the historical read endpoints that consume these rows are
 * separate issues (#652, #653, #654) and build on the storage this establishes.
 */

/** A single raw submission as the aggregation reads it. */
export interface PriceObservation {
  submissionId: string;
  countryIso: string;
  category: string;
  /** Price in the contract's smallest fixed-point unit. Always > 0 on-chain. */
  value: bigint;
  /** Observation timestamp (seconds). */
  timestamp: number;
  submitter: string;
  /** `pending` | `verified` | `rejected` — mirrors the contract's enum. */
  status: SubmissionStatus;
}

/** Lifecycle of a submission, mirroring `PriceVault::SubmissionStatus`. */
export type SubmissionStatus = "pending" | "verified" | "rejected";

/** One aggregate row written by a run. */
export interface IndexAggregate {
  runDate: string;
  countryIso: string;
  category: string;
  /** Number of observations that contributed. */
  sampleCount: number;
  /** Sum of the contributing values, in the fixed-point unit. */
  totalValue: bigint;
  /**
   * Mean of the contributing values, in the fixed-point unit. Integer
   * division truncates, which is the correct choice for a fixed-point price:
   * rounding up would systematically overstate the cost of living.
   */
  meanValue: bigint;
  /** Distinct submitters among the contributing observations. */
  contributorCount: number;
  /** When this aggregate was computed (distinct from `runDate`). */
  computedAt: Date;
}

/** Outcome of one scheduled run. */
export type RunStatus = "success" | "skipped" | "partial" | "failed";

/** The durable record of a run, written whatever the outcome. */
export interface AggregationRun {
  runDate: string;
  status: RunStatus;
  /** Aggregates written. Zero on failure. */
  aggregatesWritten: number;
  /** Groups that produced no data; these are gaps, not zeroes. */
  emptyGroups: number;
  error: string | null;
  startedAt: Date;
  completedAt: Date;
}

/** Options controlling which submissions a run considers. */
export interface AggregationOptions {
  /**
   * Only aggregate submissions in this status. Defaults to `verified`: a
   * pending submission is an unvetted claim and a rejected one is known bad,
   * so neither belongs in a published index.
   */
  includeStatuses?: SubmissionStatus[];
  /**
   * Minimum distinct contributors before a group is published. Defaults to 1
   * (publish whatever exists); raise it to suppress thin groups.
   */
  minContributors?: number;
  /** Injectable clock, for tests. */
  now?: () => Date;
}

/** The persistence surface the job needs. */
export interface AggregationStore {
  /**
   * Atomically claim the run for `runDate`. Returns false when another worker
   * (or an earlier attempt) already holds or completed the claim.
   */
  claimRun(runDate: string): Promise<boolean>;
  /** Read submissions whose timestamp falls on `runDate` (UTC). */
  listObservations(runDate: string): Promise<PriceObservation[]>;
  /** Upsert one aggregate. Idempotent on (runDate, countryIso, category). */
  writeAggregate(aggregate: IndexAggregate): Promise<void>;
  /** Record the terminal state of the run. */
  completeRun(run: AggregationRun): Promise<void>;
}

/** Format a date as the UTC `YYYY-MM-DD` day key the job aggregates by. */
export function toRunDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The UTC day before `runDate`, for the catch-up walk. */
export function previousRunDate(runDate: string): string | null {
  const parsed = Date.parse(`${runDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return null;
  return toRunDate(new Date(parsed - 86_400_000));
}

/**
 * Reduce observations to one aggregate per (country, category).
 *
 * A pure function so the arithmetic is testable without a database and
 * deterministic for a given input set — the same observations always produce
 * the same aggregates, which is what makes a re-run safe to overwrite.
 */
export function aggregateObservations(
  runDate: string,
  observations: PriceObservation[],
  computedAt: Date
): IndexAggregate[] {
  const groups = new Map<string, PriceObservation[]>();

  for (const observation of observations) {
    // The contract guarantees value > 0 (guards::require_positive_price), but
    // a zero or negative would drag a mean below the true cost of living, so
    // it is dropped here rather than trusted.
    if (observation.value <= 0n) continue;
    const key = `${observation.countryIso}:${observation.category}`;
    const list = groups.get(key);
    if (list) list.push(observation);
    else groups.set(key, [observation]);
  }

  const aggregates: IndexAggregate[] = [];
  for (const [key, group] of groups) {
    const separator = key.indexOf(":");
    aggregates.push({
      runDate,
      countryIso: key.slice(0, separator),
      category: key.slice(separator + 1),
      sampleCount: group.length,
      totalValue: group.reduce((sum, o) => sum + o.value, 0n),
      meanValue: mean(group),
      contributorCount: new Set(group.map((o) => o.submitter)).size,
      computedAt,
    });
  }

  // Sort by (country, category) so a run writes in a stable order. A re-run
  // that produces a different order would make diffing two runs harder for no
  // benefit, since the unique key makes the write order irrelevant.
  aggregates.sort(
    (a, b) =>
      a.countryIso.localeCompare(b.countryIso) || a.category.localeCompare(b.category)
  );
  return aggregates;
}

/** Integer mean of non-empty observations, truncated toward zero. */
function mean(observations: PriceObservation[]): bigint {
  if (observations.length === 0) return 0n;
  const total = observations.reduce((sum, o) => sum + o.value, 0n);
  return total / BigInt(observations.length);
}

/**
 * Run the aggregation once for `runDate`.
 *
 * Returns a `failed` run without throwing when the store is unavailable: a
 * database blip during a scheduled job must be recorded and retried on the next
 * tick, not crash the process that also serves the API.
 */
export async function runDailyAggregation(
  store: AggregationStore,
  runDate: string,
  options: AggregationOptions = {}
): Promise<AggregationRun> {
  const {
    includeStatuses = ["verified"],
    minContributors = 1,
    now = () => new Date(),
  } = options;

  const startedAt = now();

  // The lease is what makes the run exactly-once across replicas and
  // idempotent across restarts. Losing the claim is a normal outcome, not an
  // error: another worker owns this day.
  const claimed = await store.claimRun(runDate);
  if (!claimed) {
    return {
      runDate,
      status: "skipped",
      aggregatesWritten: 0,
      emptyGroups: 0,
      error: null,
      startedAt,
      completedAt: now(),
    };
  }

  let run: AggregationRun;
  try {
    const observations = await store.listObservations(runDate);
    const eligible = observations.filter((o) => includeStatuses.includes(o.status));
    const aggregates = aggregateObservations(runDate, eligible, startedAt);

    const publishable = aggregates.filter((a) => a.contributorCount >= minContributors);
    for (const aggregate of publishable) {
      await store.writeAggregate(aggregate);
    }

    const emptyGroups = aggregates.length - publishable.length;
    run = {
      runDate,
      status: emptyGroups > 0 ? "partial" : "success",
      aggregatesWritten: publishable.length,
      emptyGroups,
      error: null,
      startedAt,
      completedAt: now(),
    };
  } catch (err) {
    // Recorded rather than rethrown: the failure must be visible in the run
    // history and in the logs, but must not take down the process.
    run = {
      runDate,
      status: "failed",
      aggregatesWritten: 0,
      emptyGroups: 0,
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: now(),
    };
  }

  await store.completeRun(run);
  return run;
}

/** The minimum surface this module needs from the logger. */
export interface RunLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface SchedulerOptions {
  /** Milliseconds between ticks. Default: one hour. */
  intervalMs?: number;
  /** How many days back to catch up when a run is outstanding. Default: 7. */
  catchUpDays?: number;
  /** Injectable clock, for tests. */
  now?: () => Date;
  /** Log sink. Defaults to the console. */
  log?: RunLogger;
}

/** Default tick interval: hourly, so a missed daily run is caught the same day. */
export const DEFAULT_INTERVAL_MS = 3_600_000;

/** Default catch-up window, in days. */
export const DEFAULT_CATCH_UP_DAYS = 7;

/**
 * Drives `runDailyAggregation` on a timer.
 *
 * Each tick walks back from today one day at a time and runs the first day
 * whose lease it can claim. Stopping at the first claimable day is what makes
 * this efficient and self-healing: if today is already done, the loop returns
 * after one cheap `claimRun` call, and if three days were missed, it fills them
 * in order on the next tick. The catch-up window bounds the walk so a process
 * that has been down for a month does not try to backfill a month of history on
 * its first tick.
 */
export class AggregationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly store: AggregationStore,
    private readonly options: SchedulerOptions = {}
  ) {}

  /** Aggregate the most recent day that is still outstanding. */
  async tick(): Promise<AggregationRun> {
    const {
      catchUpDays = DEFAULT_CATCH_UP_DAYS,
      now = () => new Date(),
      log = console,
    } = this.options;

    const today = toRunDate(now());
    let runDate: string | null = today;

    for (let i = 0; i < catchUpDays && runDate !== null; i++) {
      const run = await runDailyAggregation(this.store, runDate, { now });
      if (run.status !== "skipped") {
        if (run.status === "failed") {
          // Surfaced to operators via the alerting hook behind logger.error.
          log.error("daily_aggregation_failed", {
            runDate: run.runDate,
            attempts: 1,
            error: run.error,
          });
        } else {
          log.info("daily_aggregation_completed", {
            runDate: run.runDate,
            status: run.status,
            aggregatesWritten: run.aggregatesWritten,
            emptyGroups: run.emptyGroups,
          });
        }
        return run;
      }
      runDate = previousRunDate(runDate);
    }

    return {
      runDate: today,
      status: "skipped",
      aggregatesWritten: 0,
      emptyGroups: 0,
      error: null,
      startedAt: now(),
      completedAt: now(),
    };
  }

  /**
   * Start ticking. An immediate first tick runs asynchronously so `start` never
   * blocks startup on a database round trip.
   */
  start(): void {
    const {
      intervalMs = DEFAULT_INTERVAL_MS,
      log = console,
    } = this.options;
    this.stopped = false;

    void (async () => {
      try {
        await this.tick();
      } catch (err) {
        log.error("daily_aggregation_tick_failed", { err });
      }
    })();

    this.timer = setInterval(() => {
      // Overlapping ticks would contend for the same lease; the claim would
      // settle it, but skipping is cheaper and keeps the logs readable.
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((err) => {
          log.error("daily_aggregation_tick_failed", { err });
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);

    // Do not hold the event loop open on shutdown.
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
