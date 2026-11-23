
import { Pool, PoolClient } from "pg";
import {
  PostgresAnalyticsStore,
  QueryValidationError,
} from "./store";
import { FilterOptions } from "./index-aggregation";

/**
 * PostgreSQL session-level advisory lock.
 *
 * Keep this key stable across all replicas running this job.
 */
const AGGREGATION_LOCK_KEY = 8_112_004_731;

export interface DailyAggregationOptions {
  pool: Pool;

  /** Date to aggregate, in strict YYYY-MM-DD format. */
  runDate?: string;

  /** Filter configuration applied to every country/category pair. */
  filter?: FilterOptions;

  /** Maximum number of pairs processed in one invocation. */
  maxPairs?: number;

  /** Called after a pair has been processed and committed. */
  onPair?: (result: {
    countryIso: string;
    category: string;
    median: bigint | null;
  }) => void;
}

export interface DailyAggregationResult {
  runDate: string;
  /** Pairs that produced a published aggregate. */
  computed: number;
  /** Pairs with no surviving observation. */
  skipped: number;
  /** Pairs whose aggregation failed. */
  failed: number;
}

export interface AggregationTarget {
  country_iso: string;
  category: string;
}

type LockRow = {
  locked: boolean;
};

type UnlockRow = {
  unlocked: boolean;
};

/** Return yesterday's date in UTC as YYYY-MM-DD. */
export function previousUtcDay(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("now must be a valid Date");
  }

  const day = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  );

  day.setUTCDate(day.getUTCDate() - 1);

  return day.toISOString().slice(0, 10);
}

/**
 * Validate a strict calendar date.
 *
 * Rejects malformed strings and impossible dates such as 2026-02-30.
 */
function validateRunDate(runDate: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate);

  if (!match) {
    throw new QueryValidationError(
      `runDate is not a valid date: ${runDate}`,
      "INVALID_DATE",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Use setUTCFullYear to avoid Date.UTC's special handling of years 0–99.
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new QueryValidationError(
      `runDate is not a valid date: ${runDate}`,
      "INVALID_DATE",
    );
  }
}

/** Validate the optional pair limit before executing SQL. */
function validateMaxPairs(maxPairs: number | undefined): void {
  if (maxPairs === undefined) {
    return;
  }

  if (!Number.isSafeInteger(maxPairs) || maxPairs < 1) {
    throw new QueryValidationError(
      "maxPairs must be a positive safe integer",
      "INVALID_MAX_PAIRS",
    );
  }
}

/**
 * Attempt to acquire the session-level advisory lock.
 *
 * Returns false when another replica owns the lock.
 */
async function acquireAggregationLock(
  client: PoolClient,
): Promise<boolean> {
  const { rows } = await client.query<LockRow>(
    "SELECT pg_try_advisory_lock($1::bigint) AS locked",
    [AGGREGATION_LOCK_KEY],
  );

  return rows[0]?.locked === true;
}

/**
 * Release the lock explicitly.
 *
 * A failed unlock means the connection must not be reused blindly:
 * PostgreSQL session-level locks survive transaction boundaries.
 */
async function releaseAggregationLock(
  client: PoolClient,
): Promise<void> {
  const { rows } = await client.query<UnlockRow>(
    "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
    [AGGREGATION_LOCK_KEY],
  );

  if (rows[0]?.unlocked !== true) {
    throw new Error(
      "PostgreSQL did not confirm release of the aggregation lock",
    );
  }
}

/**
 * Run daily aggregation for one UTC calendar date.
 *
 * Properties:
 * - Serializes complete runs across replicas.
 * - Processes pairs independently.
 * - Keeps the advisory lock until processing finishes.
 * - Counts aggregation failures without aborting other pairs.
 * - Keeps callback errors separate from database failures.
 *
 * IMPORTANT:
 * Idempotent persistence must be guaranteed by aggregateDay() and
 * the database schema. This runner cannot establish that guarantee alone.
 */
export async function runDailyIndexAggregation(
  options: DailyAggregationOptions,
): Promise<DailyAggregationResult> {
  const {
    pool,
    filter = {},
    maxPairs,
    onPair,
  } = options;

  const runDate = options.runDate ?? previousUtcDay();

  // Fail fast before obtaining a connection or changing database state.
  validateRunDate(runDate);
  validateMaxPairs(maxPairs);

  const store = new PostgresAnalyticsStore(pool);

  const result: DailyAggregationResult = {
    runDate,
    computed: 0,
    skipped: 0,
    failed: 0,
  };

  const client = await pool.connect();

  let lockAcquired = false;
  let destroyConnection = false;

  try {
    lockAcquired = await acquireAggregationLock(client);

    if (!lockAcquired) {
      // Another replica owns the lock. No pairs were processed.
      return result;
    }

    /*
     * Deterministic ordering makes the selected subset reproducible.
     *
     * This query intentionally retains your original source of targets.
     * It does not, by itself, implement completion-aware catch-up.
     */
    const targetQuery = maxPairs === undefined
      ? `
        SELECT DISTINCT country_iso, category
        FROM price_observations
        WHERE status = 'verified'
          AND observed_at >= $1::date
          AND observed_at < ($1::date + INTERVAL '1 day')
        ORDER BY country_iso ASC, category ASC
      `
      : `
        SELECT DISTINCT country_iso, category
        FROM price_observations
        WHERE status = 'verified'
          AND observed_at >= $1::date
          AND observed_at < ($1::date + INTERVAL '1 day')
        ORDER BY country_iso ASC, category ASC
        LIMIT $2
      `;

    const targetParams = maxPairs === undefined
      ? [runDate]
      : [runDate, maxPairs];

    const targets = await client.query<AggregationTarget>(
      targetQuery,
      targetParams,
    );

    /*
     * Keep the lock throughout pair processing.
     *
     * Do not release it immediately after target selection: doing so would
     * allow another replica to start while this run is still active.
     */
    for (const target of targets.rows) {
      let median: bigint | null = null;
      let pairSucceeded = false;
      let pairSkipped = false;

      try {
        const outcome = await store.aggregateDay(
          target.country_iso,
          target.category,
          runDate,
          filter,
        );

        if (outcome === null || outcome.median === null) {
          pairSkipped = true;
        } else {
          median = outcome.median;
        }

        pairSucceeded = true;
      } catch (error) {
        result.failed += 1;

        console.warn(
          `[index-aggregation] ${target.country_iso}/${target.category} ` +
          `failed for ${runDate}: ${String(error)}`,
        );
      }

      if (!pairSucceeded) {
        // Continue with the next country/category pair.
        continue;
      }

      if (pairSkipped) {
        result.skipped += 1;
      } else {
        result.computed += 1;
      }

      /*
       * A notification failure must not turn a successful database write
       * into a failed aggregation.
       */
      if (onPair) {
        try {
          onPair({
            countryIso: target.country_iso,
            category: target.category,
            median,
          });
        } catch (error) {
          console.warn(
            `[index-aggregation] onPair callback failed for ` +
            `${target.country_iso}/${target.category}: ${String(error)}`,
          );
        }
      }
    }

    return result;
  } finally {
    try {
      if (lockAcquired) {
        try {
          await releaseAggregationLock(client);
        } catch (error) {
          /*
           * Destroy the connection instead of returning a potentially
           * lock-holding session to the pool.
           *
           * Closing the PostgreSQL session releases session-level locks.
           */
          destroyConnection = true;

          console.error(
            "[index-aggregation] Failed to release advisory lock:",
            error,
          );

          throw error;
        }
      }
    } finally {
      // pg PoolClient.release(error) removes an unhealthy client from reuse.
      client.release(
        destroyConnection
          ? new Error("Discarding connection after advisory-lock cleanup failure")
          : undefined,
      );
    }
  }
}
