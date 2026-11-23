/**
 * PostgreSQL persistence for the event-processing reliability primitives.
 *
 * Implements the three store interfaces the reliability layer needs —
 * {@link IdempotencyStore} (#648), {@link DeadLetterStore} (#650) and
 * {@link AggregationStore} (#651) — against the schema in
 * `migrations/010_event_reliability.sql`.
 *
 * The concurrency argument, once, because it is the reason the SQL looks the
 * way it does: every state transition that must not race is expressed as a
 * single conditional `UPDATE`/`INSERT` and judged by its `rowCount`. No
 * read-then-write anywhere. A read-then-write would let two workers both read
 * "not claimed", both proceed, and both apply the same event — which is the
 * duplicate this whole layer exists to prevent.
 */

import { Pool } from "pg";
import { toSafeBigInt } from "../db";
import {
  IdempotencyKey,
  IdempotencyLookup,
  IdempotencyStore,
  isValidIdempotencyKey,
} from "../idempotency";
import {
  DeadLetterRecord,
  DeadLetterReason,
  DeadLetterRow,
  DeadLetterStore,
} from "../dead-letter";
import {
  AggregationRun,
  AggregationStore,
  IndexAggregate,
  PriceObservation,
  SubmissionStatus,
} from "./job";

/** Rows currently held by an in-flight claim, per key. */
const CLAIMED = "claimed";

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Claim a key for processing.
   *
   * Two cases succeed, and the difference matters:
   *   - The key is new: `INSERT ... ON CONFLICT DO NOTHING` claims it.
   *   - The key exists but its work failed: the `UPDATE` re-claims it, which is
   *     what allows a dead-lettered or crashed event to be retried.
   *
   * A key that is already `processed` is never re-claimed — that is the
   * idempotency guarantee.
   */
  async claim(key: string): Promise<boolean> {
    if (!isValidIdempotencyKey(key)) return false;

    const inserted = await this.pool.query(
      `
      INSERT INTO event_idempotency (idempotency_key, status, attempts)
      VALUES ($1, $2, 0)
      ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [key, CLAIMED]
    );
    if (inserted.rowCount === 1) return true;

    // The key already exists. Re-claim it only if it has not completed.
    const reclaimed = await this.pool.query(
      `
      UPDATE event_idempotency
      SET status = $2, attempts = attempts + 1, claimed_at = NOW()
      WHERE idempotency_key = $1 AND status <> 'processed'
      `,
      [key, CLAIMED]
    );
    return (reclaimed.rowCount ?? 0) === 1;
  }

  async lookup(key: string): Promise<IdempotencyLookup> {
    if (!isValidIdempotencyKey(key)) return { status: "new" };

    const result = await this.pool.query(
      `SELECT status, error, attempts, processed_at FROM event_idempotency WHERE idempotency_key = $1`,
      [key]
    );
    if (!result.rowCount) return { status: "new" };

    const row = result.rows[0];
    const status = String(row.status);
    if (status === "processed") {
      return {
        status: "processed",
        processedAt: row.processed_at ? new Date(row.processed_at) : null,
      };
    }
    if (status === "failed") {
      return {
        status: "failed",
        error: row.error == null ? null : String(row.error),
        attempts: Number(row.attempts ?? 0),
      };
    }
    // `claimed` is in-flight, which is neither new nor completed. Reporting it
    // as "new" lets the caller attempt the work, which the claim in
    // `runOnce` will then arbitrate.
    return { status: "new" };
  }

  async markProcessed(key: string): Promise<void> {
    if (!isValidIdempotencyKey(key)) return;
    await this.pool.query(
      `
      UPDATE event_idempotency
      SET status = 'processed', error = NULL, processed_at = NOW()
      WHERE idempotency_key = $1
      `,
      [key]
    );
  }

  async markFailed(key: string, error: string): Promise<void> {
    if (!isValidIdempotencyKey(key)) return;
    await this.pool.query(
      `
      INSERT INTO event_idempotency (idempotency_key, status, error, attempts, failed_at)
      VALUES ($1, 'failed', $2, 1, NOW())
      ON CONFLICT (idempotency_key) DO UPDATE
        SET status = 'failed', error = EXCLUDED.error,
            attempts = event_idempotency.attempts + 1, failed_at = NOW()
      `,
      [key, error]
    );
  }
}

export class PostgresDeadLetterStore implements DeadLetterStore {
  constructor(private readonly pool: Pool) {}

  async record(entry: Omit<DeadLetterRecord, "deadLetteredAt" | "requeuedAt">): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO event_dead_letters (
        idempotency_key, event_id, contract_id, tx_hash, ledger,
        event_type, topic, value, error, reason, attempts, dead_lettered_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (idempotency_key) DO UPDATE
        SET error = EXCLUDED.error,
            reason = EXCLUDED.reason,
            attempts = EXCLUDED.attempts,
            value = EXCLUDED.value,
            topic = EXCLUDED.topic,
            dead_lettered_at = NOW()
      `,
      [
        entry.idempotencyKey,
        entry.eventId,
        entry.contractId,
        entry.txHash,
        entry.ledger,
        entry.eventType,
        entry.topic,
        entry.value,
        entry.error,
        entry.reason,
        entry.attempts,
      ]
    );
  }

  async list(
    limit: number,
    offset: number
  ): Promise<{ entries: DeadLetterRecord[]; total: number }> {
    const [count, rows] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int AS total FROM event_dead_letters WHERE requeued_at IS NULL`),
      this.pool.query(
        `
        SELECT idempotency_key, event_id, contract_id, tx_hash, ledger, event_type,
               topic, value, error, reason, attempts, dead_lettered_at, requeued_at
        FROM event_dead_letters
        WHERE requeued_at IS NULL
        ORDER BY dead_lettered_at DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      ),
    ]);

    return {
      entries: rows.rows.map(mapDeadLetterRow),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async requeue(idempotencyKey: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE event_dead_letters
      SET requeued_at = NOW()
      WHERE idempotency_key = $1 AND requeued_at IS NULL
      `,
      [idempotencyKey]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async countPending(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM event_dead_letters WHERE requeued_at IS NULL`
    );
    return Number(result.rows[0]?.total ?? 0);
  }
}

function mapDeadLetterRow(row: Record<string, unknown>): DeadLetterRecord {
  return {
    idempotencyKey: String(row.idempotency_key),
    eventId: String(row.event_id),
    contractId: String(row.contract_id),
    txHash: String(row.tx_hash),
    ledger: Number(row.ledger),
    eventType: String(row.event_type ?? ""),
    topic: Array.isArray(row.topic) ? row.topic.map(String) : [],
    value: String(row.value ?? ""),
    error: String(row.error ?? ""),
    reason: String(row.reason) as DeadLetterReason,
    attempts: Number(row.attempts ?? 0),
    deadLetteredAt: new Date(String(row.dead_lettered_at)),
    requeuedAt: row.requeued_at ? new Date(String(row.requeued_at)) : null,
  };
}

export class PostgresAggregationStore implements AggregationStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Claim a run for `runDate`.
   *
   * The claim is the row itself: `claim_run` holds the date and whether the run
   * is still owed. Inserting succeeds once; a second worker conflicts and
   * updates instead, which returns zero rows when the run is already complete.
   * A *failed* run is reclaimable, so the next tick retries the same day.
   */
  async claimRun(runDate: string): Promise<boolean> {
    const inserted = await this.pool.query(
      `
      INSERT INTO aggregation_runs (run_date, status, aggregates_written, started_at, completed_at)
      VALUES ($1, 'running', 0, NOW(), NOW())
      ON CONFLICT (run_date) DO NOTHING
      `,
      [runDate]
    );
    if (inserted.rowCount === 1) return true;

    const reclaimed = await this.pool.query(
      `
      UPDATE aggregation_runs
      SET status = 'running', started_at = NOW(), error = NULL
      WHERE run_date = $1 AND status IN ('failed', 'running')
      `,
      [runDate]
    );
    return (reclaimed.rowCount ?? 0) === 1;
  }

  async listObservations(runDate: string): Promise<PriceObservation[]> {
    const result = await this.pool.query(
      `
      SELECT submission_id, country_iso, category, value, timestamp, submitter, status
      FROM price_submissions
      WHERE submitted_at >= $1::date
        AND submitted_at <  ($1::date + INTERVAL '1 day')
      `,
      [runDate]
    );

    return result.rows.map((row) => ({
      submissionId: String(row.submission_id),
      countryIso: String(row.country_iso),
      category: String(row.category),
      // toSafeBigInt rather than a bare parse: a price that overflowed
      // JavaScript's safe-integer range would otherwise round silently and
      // publish a wrong index.
      value: toSafeBigInt(row.value),
      timestamp: Number(row.timestamp ?? 0),
      submitter: String(row.submitter),
      status: String(row.status) as SubmissionStatus,
    }));
  }

  async writeAggregate(aggregate: IndexAggregate): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO price_index_aggregates (
        run_date, country_iso, category, sample_count, total_value,
        mean_value, contributor_count, computed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (run_date, country_iso, category) DO UPDATE
        SET sample_count = EXCLUDED.sample_count,
            total_value = EXCLUDED.total_value,
            mean_value = EXCLUDED.mean_value,
            contributor_count = EXCLUDED.contributor_count,
            computed_at = EXCLUDED.computed_at
      `,
      [
        aggregate.runDate,
        aggregate.countryIso,
        aggregate.category,
        aggregate.sampleCount,
        aggregate.totalValue.toString(),
        aggregate.meanValue.toString(),
        aggregate.contributorCount,
        aggregate.computedAt,
      ]
    );
  }

  async completeRun(run: AggregationRun): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO aggregation_runs (
        run_date, status, aggregates_written, empty_groups, error, started_at, completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (run_date) DO UPDATE
        SET status = EXCLUDED.status,
            aggregates_written = EXCLUDED.aggregates_written,
            empty_groups = EXCLUDED.empty_groups,
            error = EXCLUDED.error,
            completed_at = EXCLUDED.completed_at
      `,
      [
        run.runDate,
        run.status,
        run.aggregatesWritten,
        run.emptyGroups,
        run.error,
        run.startedAt,
        run.completedAt,
      ]
    );
  }
}

/** Re-exported so callers can build keys without importing two modules. */
export type { IdempotencyKey };
