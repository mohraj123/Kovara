/**
 * Audit persistence and forensic queries.
 *
 * Issue #658. The chain itself lives in `chain.ts`; this module is the durable
 * side of it.
 *
 * Appending is serialised per stream with a row lock on the chain head. The
 * alternative — read the head, compute the hash, insert — has a race: two
 * concurrent appends for the same stream read the same head and produce two
 * records claiming the same `previousHash`, which silently forks the chain and
 * makes `verifyChain` report a break that nobody caused. Locking the head row
 * makes the read-hash-insert sequence atomic.
 */

import { Pool, PoolClient } from "pg";
import {
  AuditAction,
  AuditActor,
  AuditEntry,
  AuditEntryInput,
  AuditOutcome,
  ChainVerification,
  GENESIS_HASH,
  actorKeyOf,
  chainEntry,
  verifyChain,
} from "./chain";

/** Filters accepted by {@link AuditStore.listEntries}. */
export interface AuditQuery {
  stream?: string;
  action?: AuditAction;
  outcome?: AuditOutcome;
  /** Match entries whose subject is this contract, entity, or address. */
  subject?: string;
  /** Match entries performed by this address. */
  actor?: string;
  ledger?: number;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

/** A filtered, paginated page of audit entries. */
export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Minimal logging hook so the store can report anomalies without pulling in a logging framework. */
export interface AuditStoreLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AuditStoreOptions {
  /**
   * Cap, in milliseconds, on how long an append will wait for another append
   * on the same stream to release the head lock. Without this, a client that
   * dies mid-transaction (connection drop, crash) leaves the row locked until
   * Postgres notices the connection is gone, and every other append to that
   * stream queues silently behind it. Unset means no cap (previous behaviour).
   */
  lockTimeoutMs?: number;
  logger?: AuditStoreLogger;
}

/** Upper bound on `AuditQuery.limit`, regardless of what the caller asks for. */
const MAX_PAGE_SIZE = 500;

/** Row shape as returned by Postgres for `audit_log`, before mapping to {@link AuditEntry}. */
interface AuditLogRow {
  id: string;
  stream: string;
  action: string;
  actor: string;
  outcome: string;
  subject: string;
  ledger: number | null;
  transaction_hash: string | null;
  metadata: unknown;
  occurred_at: string | Date;
  hash: string;
  previous_hash: string;
}

const AUDIT_COLUMNS = `
  id, stream, action, actor, outcome, subject, ledger, transaction_hash,
  metadata, occurred_at, hash, previous_hash
`;

export class AuditStore {
  private readonly lockTimeoutMs?: number;
  private readonly logger?: AuditStoreLogger;

  constructor(private readonly pool: Pool, options: AuditStoreOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.logger = options.logger;
  }

  /**
   * Append one entry, chained to the current head of its stream.
   *
   * `FOR UPDATE` on the head row serialises appends within a stream, so the
   * chain cannot fork under concurrency. Streams are independent, so a busy
   * stream never blocks another.
   */
  async append(input: AuditEntryInput, id: string): Promise<AuditEntry> {
    return this.withTransaction(async (client) => {
      const previousHash = await this.lockHead(client, input.stream);
      const entry = chainEntry(input, previousHash, id);
      await this.insert(client, entry);
      return entry;
    });
  }

  /**
   * Append many entries in one transaction, chained in order.
   *
   * A batch is all-or-nothing on purpose: a partially written audit trail for a
   * single logical action is worse than none, because it implies a record was
   * lost and leaves the chain describing a sequence that never happened.
   */
  async appendBatch(inputs: AuditEntryInput[], idFor: (index: number) => string): Promise<AuditEntry[]> {
    if (inputs.length === 0) return [];
    return this.withTransaction(async (client) => {
      // Lock every affected stream in a deterministic order (sorted) so two
      // batches touching the same streams in different orders cannot deadlock.
      const streams = [...new Set(inputs.map((i) => i.stream))].sort();
      const heads = new Map<string, string>();
      for (const stream of streams) {
        heads.set(stream, await this.lockHead(client, stream));
      }

      const written: AuditEntry[] = [];
      for (const [index, input] of inputs.entries()) {
        const previous = heads.get(input.stream) ?? GENESIS_HASH;
        const entry = chainEntry(input, previous, idFor(index));
        await this.insert(client, entry);
        heads.set(input.stream, entry.hash);
        written.push(entry);
      }

      return written;
    });
  }

  /**
   * Run `fn` inside a transaction, guaranteeing COMMIT on success and ROLLBACK
   * on failure. Centralising this means `append` and `appendBatch` cannot drift
   * apart on error handling, and gives every write path the same lock-timeout
   * and rollback-failure logging for free.
   */
  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (this.lockTimeoutMs !== undefined) {
        // SET LOCAL doesn't accept a bound parameter; lockTimeoutMs is trusted
        // config (not request input), so inlining the number is safe.
        const ms = Math.max(0, Math.trunc(this.lockTimeoutMs));
        await client.query(`SET LOCAL lock_timeout = '${ms}ms'`);
      }
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        this.logger?.warn("audit store rollback failed", { error: rollbackErr });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read the current chain head for a stream, taking a row lock on it.
   *
   * The row is inserted on demand so the lock has something to attach to. A
   * concurrent first-append for the same stream blocks here and then sees the
   * row the other transaction committed.
   */
  private async lockHead(client: PoolClient, stream: string): Promise<string> {
    // Insert the head row on demand so the lock has something to attach to.
    // DO NOTHING on conflict: this statement does not lock the existing row,
    // and is only establishing that the row exists.
    await client.query(
      `
      INSERT INTO audit_chain_heads (stream, hash, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (stream) DO NOTHING
      `,
      [stream, GENESIS_HASH]
    );
    // The row lock is taken here. Two concurrent appends for the same stream
    // serialise on this read, so the second sees the hash the first committed
    // and chains onto it instead of forking.
    const locked = await client.query<{ hash: string }>(
      "SELECT hash FROM audit_chain_heads WHERE stream = $1 FOR UPDATE",
      [stream]
    );
    return locked.rows[0]?.hash ?? GENESIS_HASH;
  }

  /**
   * Insert one entry and advance its stream's head.
   *
   * `ON CONFLICT (id) DO NOTHING` makes a retried append with the same id
   * idempotent instead of erroring — but a blind retry must not blindly
   * advance the head a second time, and a genuine id collision (same id,
   * different content) must not be mistaken for a retry. So when the insert
   * is a no-op, the existing row is read back and compared: if it matches
   * what we were about to write, the earlier call already updated the head
   * and there is nothing left to do here; if it doesn't match, this is a real
   * collision and must not be allowed to silently advance the head to a hash
   * it doesn't actually own.
   */
  private async insert(client: PoolClient, entry: AuditEntry): Promise<void> {
    const inserted = await client.query(
      `
      INSERT INTO audit_log
        (id, stream, action, actor, outcome, subject, ledger, transaction_hash,
         metadata, occurred_at, hash, previous_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
      ON CONFLICT (id) DO NOTHING
      `,
      [
        entry.id,
        entry.stream,
        entry.action,
        actorKeyOf(entry.actor),
        entry.outcome,
        entry.subject,
        entry.ledger ?? null,
        entry.transactionHash ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.occurredAt,
        entry.hash,
        entry.previousHash,
      ]
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query<AuditLogRow>(
        `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE id = $1`,
        [entry.id]
      );
      const row = existing.rows[0];
      if (!row || row.hash !== entry.hash || row.previous_hash !== entry.previousHash) {
        throw new Error(
          `audit entry id collision: "${entry.id}" already exists with different content`
        );
      }
      // Genuine retry of an already-committed append. The original call
      // already advanced the head, so doing it again here would be a
      // harmless no-op — but it's still worth surfacing, since a caller
      // retrying writes it should be treating as already-succeeded usually
      // points at a bug one layer up.
      this.logger?.warn("audit entry append retried after success", {
        id: entry.id,
        stream: entry.stream,
      });
      return;
    }

    // Keep the head in step with the insert. The row is already locked by
    // lockHead, so this update cannot race another append in the same stream.
    const headUpdate = await client.query(
      "UPDATE audit_chain_heads SET hash = $2, updated_at = NOW() WHERE stream = $1",
      [entry.stream, entry.hash]
    );
    if (headUpdate.rowCount !== 1) {
      // Should be unreachable: lockHead guarantees the row exists before we
      // get here. Treated as corruption rather than silently proceeding.
      throw new Error(`audit chain head row missing for stream "${entry.stream}"`);
    }
  }

  /**
   * Filtered, paginated audit query.
   *
   * Filters are bound as parameters and assembled as an AND list, so no caller
   * value can reach the SQL text. Ordering is total — `occurred_at DESC` then
   * `id DESC` — so pagination cannot skip or repeat a record when two entries
   * share a timestamp, which in a burst of contract events is the normal case
   * rather than the exception.
   */
  async listEntries(query: AuditQuery): Promise<AuditPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const add = (clause: (index: number) => string, value: unknown): void => {
      params.push(value);
      conditions.push(clause(params.length));
    };

    if (query.stream) add((i) => `stream = $${i}`, query.stream);
    if (query.action) add((i) => `action = $${i}`, query.action);
    if (query.outcome) add((i) => `outcome = $${i}`, query.outcome);
    if (query.subject) add((i) => `subject = $${i}`, query.subject);
    if (query.actor) add((i) => `actor = $${i}`, actorKeyOf({ kind: "address", address: query.actor }));
    if (query.ledger !== undefined) add((i) => `ledger = $${i}`, query.ledger);
    if (query.from) add((i) => `occurred_at >= $${i}`, query.from);
    if (query.to) add((i) => `occurred_at <= $${i}`, query.to);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Clamp rather than trust the caller: `limit`/`offset` often arrive
    // straight from request query params, and an unbounded limit turns one
    // slow request into a full table scan.
    const limit = Math.min(Math.max(1, Math.trunc(query.limit) || 1), MAX_PAGE_SIZE);
    const offset = Math.max(0, Math.trunc(query.offset) || 0);

    // Independent reads (no snapshot guarantee across the two queries, same
    // as before), but issued concurrently instead of sequentially — halves
    // the round-trip latency on every call.
    const [countResult, result] = await Promise.all([
      this.pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM audit_log ${where}`, params),
      this.pool.query<AuditLogRow>(
        `
        SELECT ${AUDIT_COLUMNS} FROM audit_log ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, limit, offset]
      ),
    ]);

    const total = countResult.rows[0]?.total ?? 0;
    return {
      entries: result.rows.map((row) => this.mapEntry(row)),
      total,
      limit,
      offset,
      hasMore: offset + result.rows.length < total,
    };
  }

  /** Read a whole stream in chain order, for verification. */
  async getStream(stream: string): Promise<AuditEntry[]> {
    const result = await this.pool.query<AuditLogRow>(
      `
      SELECT ${AUDIT_COLUMNS} FROM audit_log
      WHERE stream = $1
      ORDER BY occurred_at ASC, id ASC
      `,
      [stream]
    );
    return result.rows.map((row) => this.mapEntry(row));
  }

  /**
   * Recompute a stream's chain and report whether it is intact.
   *
   * A full read, because a chain cannot be verified from a prefix: proving the
   * history is intact means checking all of it. Callers should run this on a
   * schedule or on demand, not per request.
   */
  async verify(stream: string): Promise<ChainVerification> {
    return verifyChain(await this.getStream(stream));
  }

  private mapEntry(row: AuditLogRow): AuditEntry {
    const transactionHash = row.transaction_hash ?? undefined;
    return {
      id: row.id,
      stream: row.stream,
      action: row.action as AuditAction,
      actor: parseActorKey(row.actor),
      outcome: row.outcome as AuditOutcome,
      subject: row.subject,
      ledger: row.ledger === null ? undefined : row.ledger,
      ...(transactionHash ? { transactionHash } : {}),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      occurredAt: new Date(row.occurred_at),
      hash: row.hash,
      previousHash: row.previous_hash,
    };
  }
}

/** Parse the stored actor key back into a structured actor. */
function parseActorKey(key: string): AuditActor {
  if (key.startsWith("address:")) return { kind: "address", address: key.slice("address:".length) };
  if (key.startsWith("system:")) return { kind: "system", component: key.slice("system:".length) };
  return { kind: "unknown" };
}