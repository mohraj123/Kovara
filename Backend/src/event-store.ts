/**
 * Durable event store for the Kovara indexer.
 *
 * Provides PostgreSQL-backed reliability primitives used by the streaming
 * pipeline:
 *
 *   - BA-033: persisted, restorable stream cursor
 *   - BA-030: per-event processing status (pending / processed / failed / dead)
 *   - BA-031: dead-letter path and safe retry of failed events
 *
 * All methods are intentionally thin and transactional where it matters so
 * they compose with the rest of the indexer's Postgres access layer.
 */
import { Pool } from "pg";

/** Canonical key under which the latest safe cursor is persisted. */
export const STREAM_CURSOR_KEY = "latest_cursor";

export type EventStatus = "pending" | "processed" | "failed" | "dead";

export interface FailedEventRecord {
  eventId: string;
  contractId: string;
  txHash: string;
  ledger: number;
  error: string | null;
  attempts: number;
  failedAt: Date;
  topic: string[];
  value: string;
}

export class EventStore {
  constructor(private readonly pool: Pool) {}

  // ── Cursor persistence (BA-033) ────────────────────────────────────────────

  /**
   * Persist the latest safe cursor. Overwrites any previously stored value so
   * a restart always resumes from the most recently committed position.
   */
  async saveCursor(cursor: string): Promise<void> {
    if (!cursor || cursor.trim() === "") return;
    await this.pool.query(
      `
      INSERT INTO stream_state (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      `,
      [STREAM_CURSOR_KEY, cursor]
    );
  }

  /**
   * Load the last safe cursor. Returns null when no cursor has been persisted
   * yet, in which case the caller should fall back to its configured start
   * ledger.
   */
  async loadCursor(): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT value FROM stream_state WHERE key = $1`,
      [STREAM_CURSOR_KEY]
    );
    return result.rowCount ? String(result.rows[0].value) : null;
  }

  // ── Event status tracking (BA-030) ─────────────────────────────────────────

  /**
   * Mark an event as processed. Records the processing timestamp and clears
   * any prior failure metadata.
   */
  async markProcessed(eventId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE events
      SET status = 'processed', error = NULL,
          processed_at = COALESCE(processed_at, NOW()),
          failed_at = NULL, dead_lettered_at = NULL
      WHERE event_id = $1
      `,
      [eventId]
    );
  }

  /**
   * Mark an event as failed. Increments the attempt counter and records the
   * error message and a failure timestamp.
   */
  async markFailed(eventId: string, error: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE events
      SET status = 'failed',
          error = $2,
          attempts = attempts + 1,
          failed_at = NOW(),
          dead_lettered_at = NULL
      WHERE event_id = $1
      `,
      [eventId, error]
    );
  }

  /**
   * Move a failed event into the dead-letter state. The event is retained so
   * operators can inspect and safely retry it.
   */
  async deadLetter(eventId: string, error: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE events
      SET status = 'dead',
          error = $2,
          attempts = attempts + 1,
          failed_at = NOW(),
          dead_lettered_at = NOW()
      WHERE event_id = $1
      `,
      [eventId, error]
    );
  }

  // ── Dead-letter path and retry (BA-031) ────────────────────────────────────

  /**
   * List events that are in a failed or dead state so operators can inspect
   * and retry them.
   */
  async listFailedEvents(limit = 100, offset = 0): Promise<FailedEventRecord[]> {
    const result = await this.pool.query(
      `
      SELECT event_id, contract_id, tx_hash, ledger, error, attempts,
             failed_at, topic, value
      FROM events
      WHERE status IN ('failed', 'dead')
      ORDER BY COALESCE(dead_lettered_at, failed_at) DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );
    return result.rows.map((row) => ({
      eventId: String(row.event_id),
      contractId: String(row.contract_id),
      txHash: String(row.tx_hash),
      ledger: Number(row.ledger),
      error: row.error == null ? null : String(row.error),
      attempts: Number(row.attempts ?? 0),
      failedAt: new Date(String(row.failed_at)),
      topic: Array.isArray(row.topic) ? row.topic.map(String) : [],
      value: String(row.value ?? ""),
    }));
  }

  /**
   * Requeue a previously failed or dead-lettered event so it can be retried.
   * Resets the attempt counter and clears failure metadata. Safe because the
   * event row already exists and the handler's backing store is idempotent.
   */
  async requeueEvent(eventId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE events
      SET status = 'pending',
          error = NULL,
          attempts = 0,
          failed_at = NULL,
          dead_lettered_at = NULL
      WHERE event_id = $1
      `,
      [eventId]
    );
  }

  /**
   * Retry a batch of failed/dead-lettered events through `handler`. Each event
   * is processed independently: a success returns it to 'processed', a
   * repeated failure keeps it failed. Returns the number of events that were
   * successfully reprocessed. This leaves the durable failure record intact so
   * nothing is silently lost.
   */
  async retryFailedEvents(
    handler: (event: {
      eventId: string;
      contractId: string;
      txHash: string;
      ledger: number;
      topic: string[];
      value: string;
    }) => Promise<void>,
    limit = 100
  ): Promise<number> {
    const failed = await this.listFailedEvents(limit, 0);
    let requeued = 0;

    for (const record of failed) {
      try {
        await handler({
          eventId: record.eventId,
          contractId: record.contractId,
          txHash: record.txHash,
          ledger: record.ledger,
          topic: record.topic,
          value: record.value,
        });
        await this.markProcessed(record.eventId);
        requeued++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.markFailed(record.eventId, message);
      }
    }

    return requeued;
  }
}
