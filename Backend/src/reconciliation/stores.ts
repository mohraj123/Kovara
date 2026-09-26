/**
 * PostgreSQL persistence for daily reconciliation (#669).
 *
 * Backs the schema in `migrations/014_reconciliation.sql` with the
 * {@link ReconciliationStore} the job needs and the read methods the API
 * exposes.
 *
 * The concurrency argument is the same one the aggregation store makes: every
 * state transition that must not race is a single conditional statement judged
 * by `rowCount`, never a read-then-write. The run row is the lease, so a second
 * replica cannot reconcile the same day concurrently, and a failed run stays
 * reclaimable so the next tick retries it.
 */

import { Pool } from "pg";
import { toSafeBigInt } from "../db";
import {
  Discrepancy,
  DiscrepancyKind,
  ReconcileTotals,
  ReconciliationReport,
  ReconciliationStatus,
  ReconciliationStore,
} from "./job";

/** A run without its discrepancy rows, as the list endpoint returns it. */
export type ReconciliationRunSummary = Omit<ReconciliationReport, "discrepancies">;

/** The read surface behind `GET /reconciliation`. */
export interface ReconciliationQueryStore {
  listRuns(limit: number, offset: number): Promise<{ runs: ReconciliationRunSummary[]; total: number }>;
  getRun(
    runDate: string
  ): Promise<{ run: ReconciliationRunSummary; discrepancies: Discrepancy[] } | null>;
}

export class PostgresReconciliationStore
  implements ReconciliationStore, ReconciliationQueryStore
{
  constructor(private readonly pool: Pool) {}

  /**
   * Claim the run for `runDate`.
   *
   * Inserting succeeds once; a second worker conflicts. A `failed` or
   * `running` run is reclaimable (recovers a crashed attempt), but a completed
   * `balanced`/`discrepancies` run is not, so a day is reconciled once.
   */
  async claimRun(runDate: string): Promise<boolean> {
    const inserted = await this.pool.query(
      `
      INSERT INTO reconciliation_runs (run_date, status, started_at, completed_at)
      VALUES ($1, 'running', NOW(), NOW())
      ON CONFLICT (run_date) DO NOTHING
      `,
      [runDate]
    );
    if (inserted.rowCount === 1) return true;

    const reclaimed = await this.pool.query(
      `
      UPDATE reconciliation_runs
      SET status = 'running', started_at = NOW(), error = NULL
      WHERE run_date = $1 AND status IN ('running', 'failed')
      `,
      [runDate]
    );
    return (reclaimed.rowCount ?? 0) === 1;
  }

  async loadSourceTotals(runDate: string): Promise<ReconcileTotals[]> {
    const result = await this.pool.query(
      `
      SELECT country_iso, category,
             COUNT(*)::int AS count,
             COALESCE(SUM(value), 0)::text AS total_value
      FROM price_submissions
      WHERE status = 'verified'
        AND submitted_at >= $1::date
        AND submitted_at <  ($1::date + INTERVAL '1 day')
      GROUP BY country_iso, category
      `,
      [runDate]
    );

    return result.rows.map((row) => ({
      countryIso: String(row.country_iso),
      category: String(row.category),
      count: Number(row.count ?? 0),
      totalValue: toSafeBigInt(row.total_value as string | number | bigint),
    }));
  }

  async loadAggregateTotals(runDate: string): Promise<ReconcileTotals[]> {
    const result = await this.pool.query(
      `
      SELECT country_iso, category, sample_count AS count, total_value
      FROM price_index_aggregates
      WHERE run_date = $1::date
      `,
      [runDate]
    );

    return result.rows.map((row) => ({
      countryIso: String(row.country_iso),
      category: String(row.category),
      count: Number(row.count ?? 0),
      totalValue: toSafeBigInt(row.total_value as string | number | bigint),
    }));
  }

  /**
   * Replace the discrepancy rows for a run in one transaction.
   *
   * Delete-then-insert rather than upsert: a re-run can legitimately produce
   * *fewer* discrepancies (a transient source gap was filled), and leaving the
   * stale rows behind would overstate the problem.
   */
  async writeDiscrepancies(runDate: string, discrepancies: Discrepancy[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM reconciliation_discrepancies WHERE run_date = $1`, [runDate]);

      for (const discrepancy of discrepancies) {
        await client.query(
          `
          INSERT INTO reconciliation_discrepancies (
            run_date, country_iso, category, kind,
            source_count, aggregate_count, source_value, aggregate_value,
            count_delta, value_delta
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            runDate,
            discrepancy.countryIso,
            discrepancy.category,
            discrepancy.kind,
            discrepancy.sourceCount,
            discrepancy.aggregateCount,
            discrepancy.sourceValue,
            discrepancy.aggregateValue,
            discrepancy.countDelta,
            discrepancy.valueDelta,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async completeRun(report: ReconciliationReport): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO reconciliation_runs (
        run_date, status, source_groups, aggregate_groups,
        matched_groups, discrepancy_count, error, started_at, completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (run_date) DO UPDATE
        SET status = EXCLUDED.status,
            source_groups = EXCLUDED.source_groups,
            aggregate_groups = EXCLUDED.aggregate_groups,
            matched_groups = EXCLUDED.matched_groups,
            discrepancy_count = EXCLUDED.discrepancy_count,
            error = EXCLUDED.error,
            completed_at = EXCLUDED.completed_at
      `,
      [
        report.runDate,
        report.status,
        report.sourceGroups,
        report.aggregateGroups,
        report.matchedGroups,
        report.discrepancyCount,
        report.error,
        report.startedAt,
        report.completedAt,
      ]
    );
  }

  async listRuns(
    limit: number,
    offset: number
  ): Promise<{ runs: ReconciliationRunSummary[]; total: number }> {
    const [count, rows] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int AS total FROM reconciliation_runs`),
      this.pool.query(
        `
        SELECT run_date, status, source_groups, aggregate_groups,
               matched_groups, discrepancy_count, error, started_at, completed_at
        FROM reconciliation_runs
        ORDER BY run_date DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      ),
    ]);

    return {
      runs: rows.rows.map(mapRunRow),
      total: Number(count.rows[0]?.total ?? 0),
    };
  }

  async getRun(
    runDate: string
  ): Promise<{ run: ReconciliationRunSummary; discrepancies: Discrepancy[] } | null> {
    const runResult = await this.pool.query(
      `
      SELECT run_date, status, source_groups, aggregate_groups,
             matched_groups, discrepancy_count, error, started_at, completed_at
      FROM reconciliation_runs
      WHERE run_date = $1::date
      `,
      [runDate]
    );
    if (!runResult.rowCount) return null;

    const discrepancyResult = await this.pool.query(
      `
      SELECT country_iso, category, kind, source_count, aggregate_count,
             source_value, aggregate_value, count_delta, value_delta
      FROM reconciliation_discrepancies
      WHERE run_date = $1::date
      ORDER BY country_iso ASC, category ASC
      `,
      [runDate]
    );

    return {
      run: mapRunRow(runResult.rows[0]),
      discrepancies: discrepancyResult.rows.map(mapDiscrepancyRow),
    };
  }
}

function mapRunRow(row: Record<string, unknown>): ReconciliationRunSummary {
  return {
    runDate: toIsoDay(row.run_date),
    status: String(row.status) as ReconciliationStatus,
    sourceGroups: Number(row.source_groups ?? 0),
    aggregateGroups: Number(row.aggregate_groups ?? 0),
    matchedGroups: Number(row.matched_groups ?? 0),
    discrepancyCount: Number(row.discrepancy_count ?? 0),
    error: row.error == null ? null : String(row.error),
    startedAt: new Date(String(row.started_at)),
    completedAt: new Date(String(row.completed_at)),
  };
}

function mapDiscrepancyRow(row: Record<string, unknown>): Discrepancy {
  return {
    countryIso: String(row.country_iso),
    category: String(row.category),
    kind: String(row.kind) as DiscrepancyKind,
    sourceCount: row.source_count == null ? null : Number(row.source_count),
    aggregateCount: row.aggregate_count == null ? null : Number(row.aggregate_count),
    sourceValue: row.source_value == null ? null : String(row.source_value),
    aggregateValue: row.aggregate_value == null ? null : String(row.aggregate_value),
    countDelta: row.count_delta == null ? null : Number(row.count_delta),
    valueDelta: row.value_delta == null ? null : String(row.value_delta),
  };
}

/** pg returns DATE columns as a Date at UTC midnight; normalise to `YYYY-MM-DD`. */
function toIsoDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
