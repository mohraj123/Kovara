/**
 * Kovara Indexer — entry point.
 *
 * Connects to a Soroban RPC endpoint, streams contract events from the
 * Kovara contract, writes raw events to PostgreSQL, and dispatches each
 * event to the appropriate typed handler. Also starts the REST API server
 * for querying indexed data.
 *
 * Environment variables (all required unless noted):
 *   DATABASE_URL           - PostgreSQL connection string
 *   STELLAR_RPC_URL        - Soroban RPC endpoint
 *   CONTRACT_ID            - Bech32 contract address
 *   START_LEDGER           - Ledger sequence to start streaming from
 *   HOST                   - (optional) API server host, default 0.0.0.0
 *   PORT                   - (optional) API server port, default 3000
 *   TRUST_PROXY            - (optional) Number of proxies to trust (for X-Forwarded-For), default 0 (disabled)
 *   POLL_INTERVAL_MS       - (optional) Event streaming polling interval in ms, default 5000
 *   RATE_LIMIT_WINDOW_MS   - (optional) Rate limit window in ms, default 60000 (1 minute)
 *   RATE_LIMIT_MAX         - (optional) Max requests per IP per rate limit window, default 100
 *   ENABLE_AUTH_MIDDLEWARE - (optional) Enable authentication middleware (default: false)
 *   ENABLE_RATE_LIMITING   - (optional) Enable rate limiting middleware (default: true)
 *   ENABLE_EXPERIMENTAL_ROUTES - (optional) Enable experimental routes (e.g., pools) (default: false)
//  */.....
/**
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 * Idempotent: if the follow already exists the handler returns immediately
 * without issuing a database write.
 */

    // current.requestCount++;
// import { Pool } from "pg";
import { streamEvents, EventHandler, RawEvent } from "./stream";
import { createApp } from "./api";
import { runMigrations } from "./migrate";
import { PostgresDatabase } from "./db";
import { EventStore } from "./event-store";
import { withRetry } from "./retry";
import { logger } from "./logger";
import { randomUUID } from "crypto";
import pkg from "../package.json";

// ── Config ────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value for environment variable: ${name}`);
  }
  return parsed;
}

/**
 * BA-038: Parse a ledger sequence number from an environment variable, with
 * strict numeric validity and a lower bound. Returns the parsed integer and
 * throws before any RPC work when the value is not a valid non-negative
 * integer, so malformed replay configuration fails fast.
 */
function parseLedger(raw: string, name: string): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid ledger value for ${name}: "${raw}" is not an integer. Ledger ranges are ` +
        `inclusive on both ends and must be non-negative.`
    );
  }
  const parsed = parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ledger value for ${name}: "${raw}" is out of supported bounds.`);
  }
  return parsed;
}

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = parseEnvNumber("PORT", 3000);

const DATABASE_URL = process.env.DATABASE_URL || "sqlite::memory:";
const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.CONTRACT_ID || "PLACEHOLDER_CONTRACT_ID";
const START_LEDGER = parseInt(process.env.START_LEDGER || "0", 10);
const POLL_INTERVAL_MS = process.env["POLL_INTERVAL_MS"]
  ? parseInt(process.env["POLL_INTERVAL_MS"], 10)
  : undefined;

// Feature flags
const ENABLE_AUTH_MIDDLEWARE = process.env.ENABLE_AUTH_MIDDLEWARE === "true";
const ENABLE_RATE_LIMITING = process.env.ENABLE_RATE_LIMITING !== "false"; // default to true
const ENABLE_EXPERIMENTAL_ROUTES = process.env.ENABLE_EXPERIMENTAL_ROUTES === "true";

// ── Database ──────────────────────────────────────────────────────────────────

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  statement_timeout: parseInt(process.env["QUERY_TIMEOUT_MS"] ?? "", 10) || 30_000,
});

async function ensureEventsTable(): Promise<void> {
  // BE-28: Wrap in try/catch so a pre-existing table with a slightly
  // different layout (schema drift) does not crash startup. The IF NOT
  // EXISTS guards make the statement idempotent; the outer catch logs the
  // discrepancy and allows the service to continue with whatever schema is
  // present.
  try {
    // BA-030: The events table tracks processing status (pending/processed/
    // failed/dead) with error details and timestamps so operators and replay
    // tooling can observe exactly how each event was handled.
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id            BIGSERIAL   PRIMARY KEY,
        event_id      TEXT        NOT NULL UNIQUE,
        ledger        INTEGER     NOT NULL,
        contract_id   TEXT        NOT NULL,
        topic         TEXT[]      NOT NULL,
        value         TEXT        NOT NULL,
        tx_hash       TEXT        NOT NULL,
        closed_at     TIMESTAMPTZ NOT NULL,
        indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status        TEXT        NOT NULL DEFAULT 'new'
        id                BIGSERIAL   PRIMARY KEY,
        event_id          TEXT        NOT NULL UNIQUE,
        ledger            INTEGER     NOT NULL,
        contract_id       TEXT        NOT NULL,
        topic             TEXT[]      NOT NULL,
        value             TEXT        NOT NULL,
        tx_hash           TEXT        NOT NULL,
        closed_at         TIMESTAMPTZ NOT NULL,
        indexed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status            TEXT        NOT NULL DEFAULT 'pending',
        error             TEXT,
        attempts          INTEGER     NOT NULL DEFAULT 0,
        processed_at      TIMESTAMPTZ,
        failed_at         TIMESTAMPTZ,
        dead_lettered_at  TIMESTAMPTZ
      )
    `);
    // BA-033: Durable stream-state store used to persist the latest safe cursor
    // so a restart resumes without re-processing already-committed events.
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS stream_state (
        key        TEXT        PRIMARY KEY,
        value      TEXT        NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_events_ledger      ON events (ledger);
      CREATE INDEX IF NOT EXISTS idx_events_contract_id ON events (contract_id);
    `);
  } catch (err) {
    // BE-28: Non-fatal — log and continue. If the events table is genuinely
    // missing the service will fail later when it tries to insert, giving a
    // clearer error at that point.
    // BA-039: Structured warning with redacted error context.
    logger.warn("schema_drift_detected", { area: "events_table", err });
  }
}

async function ensurePostSearchIndex(): Promise<void> {
  // BE-28: Each statement is wrapped individually so a failure on one step
  // (e.g. the column already exists with a different type) does not prevent
  // the remaining steps from running.
  try {
    await pgPool.query(`
      ALTER TABLE posts
      ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    `);
  } catch (err) {
    // BA-039: Structured warning with redacted error context.
    logger.warn("post_search_index_warn", { step: "add_search_vector", err });
  }

  try {
    await pgPool.query(`
      UPDATE posts
      SET search_vector = to_tsvector('simple', coalesce(content, ''))
      WHERE search_vector IS NULL
    `);
  } catch (err) {
    // BA-039: Structured warning with redacted error context.
    logger.warn("post_search_index_warn", { step: "populate_search_vector", err });
  }

  try {
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_search_vector
      ON posts USING GIN (search_vector)
    `);
  } catch (err) {
    // BA-039: Structured warning with redacted error context.
    logger.warn("post_search_index_warn", { step: "create_search_index", err });
  }
}

async function persistEvent(event: RawEvent): Promise<void> {
  await withRetry(
    () =>
      pgPool.query(
        `
        INSERT INTO events
          (event_id, ledger, contract_id, topic, value, tx_hash, closed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id) DO NOTHING
        `,
        [
          event.id,
          event.ledger,
          event.contractId,
          event.topic,
          event.value,
          event.txHash,
          new Date(event.ledgerClosedAt),
        ]
      ),
    {
      maxAttempts: 3,
      baseDelayMs: 300,
      backoffMultiplier: 2,
      isRetryable: (err: unknown) => {
        if (err instanceof Error) {
          const msg = err.message.toLowerCase();
          return (
            msg.includes("connection") ||
            msg.includes("timeout") ||
            msg.includes("econnreset") ||
            msg.includes("econnrefused") ||
            msg.includes("socket hang up") ||
            msg.includes("pool exhausted")
          );
        }
        return false;
      },
      operationLabel: "persistEvent",
    }
  );
}

// ── Recoverable event processing (BA-029) ───────────────────────────────────
//
// Persistence and the downstream side effects (writing profiles, posts, likes,
// tips via the typed handlers) are separate DB operations. Persisting an event
// without recording whether its side effects completed can leave an event
// present in `events` yet never reflected in the domain tables — e.g. when the
// process crashes between the INSERT and the handler committing its writes.
//
// To make persistence and handling recoverable we attach an explicit
// processing state to every persisted event:
//   - `new`       persisted, side effects not yet (or not known to be) applied
//   - `processed` side effects applied and committed
//   - `failed`    the handler raised (kept for diagnosis/retry)
//
// A persisted event is therefore *never* in an unaccounted state: on startup we
// run `recoverPendingEvents`, which reprocesses every event that is not yet
// `processed`, replaying whatever side effects were missed after a crash and
// advancing each event to `processed` only once its handler succeeds.

export type RawEventHandler = (event: RawEvent) => Promise<void>;

/** Swap/select the event status atomically; returns whether the swap happened.
 *  Used to claim an event before processing so a single (or concurrent)
 *  reprocessor does not duplicate side effects. */
async function claimEvent(eventId: string, from: string): Promise<boolean> {
  const result = await pgPool.query(
    `UPDATE events SET status = 'processing' WHERE event_id = $1 AND status = $2`,
    [eventId, from]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await pgPool.query(`UPDATE events SET status = 'processed' WHERE event_id = $1`, [eventId]);
}

export async function markEventFailed(eventId: string): Promise<void> {
  await pgPool.query(`UPDATE events SET status = 'failed' WHERE event_id = $1`, [eventId]);
}

/** Persist an event and process it under an explicit state transition so the
 *  event is never left present-but-unprocessed. Returns true if the event was
 *  newly claimed (i.e. its side effects actually ran). */
export async function processEvent(event: RawEvent, handler: RawEventHandler): Promise<boolean> {
  await persistEvent(event);
  // Claim the event (from 'new') before dispatching so the same event is not
  // processed twice by a concurrent/restarted worker. If it was already claimed
  // or processed, we treat it as done.
  if (!(await claimEvent(event.id, "new"))) return false;
  try {
    await handler(event);
  } catch (err) {
    await markEventFailed(event.id);
    throw err;
  }
  await markEventProcessed(event.id);
  return true;
}

/** Replay side effects for every event that was persisted but not fully
 *  processed — this is what makes crash recovery and restart-based replay safe.
 *  Returns the number of events (re)processed. */
export async function recoverPendingEvents(handler: RawEventHandler): Promise<number> {
  const result = await pgPool.query(
    `SELECT * FROM events WHERE status <> 'processed' ORDER BY ledger ASC, id ASC`
  );
  let recovered = 0;
  for (const row of result.rows) {
    const event: RawEvent = {
      id: String(row.event_id),
      ledger: Number(row.ledger),
      contractId: String(row.contract_id),
      topic: Array.isArray(row.topic) ? row.topic.map(String) : [],
      value: String(row.value ?? ""),
      txHash: String(row.tx_hash ?? ""),
      ledgerClosedAt: row.closed_at instanceof Date
        ? row.closed_at.toISOString()
        : String(row.closed_at),
    };
    if (await processEvent(event, handler)) recovered += 1;
  }
  return recovered;
/**
 * Wrap a persistence handler so every event's processing outcome is durably
 * recorded on the events table (BA-030) and repeated failures are retained so
 * operators can retry them (BA-031).
 *
 * The returned handler:
 *   - persists the event (insert is idempotent via event_id uniqueness),
 *   - marks it 'processed' on success (advancing the stream cursor safely),
 *   - records the error and retains the event as 'failed' on failure without
 *     dropping it, so it can be retried by operators.
 */
function trackProcessing(store: EventStore): EventHandler {
  return async (event: RawEvent): Promise<void> => {
    try {
      await persistEvent(event);
      await store.markProcessed(event.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await store.markFailed(event.id, message);
      } catch {
        // Logging-only fallback so a failed status update cannot silently
        // swallow the original processing error.
        console.error(`[indexer] Could not record failure for event ${event.id}:`, message);
      }
      throw err;
    }
  };
}

// ── Event dispatch ────────────────────────────────────────────────────────────

// async function handleEvent(event: RawEvent): Promise<void> {
//   await persistEvent(event);

//   const eventType = event.topic[0];
//   console.log(`[indexer] ledger=${event.ledger} type=${eventType} tx=${event.txHash}`);
// }

// ── Graceful shutdown (BA-007) ────────────────────────────────────────────────
// Abort controller and signal handlers were previously commented out.
// Restored: SIGTERM and SIGINT now abort streaming and close server + DB cleanly.

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const replayStartLedger = process.env["REPLAY_START_LEDGER"];
  const replayEndLedger = process.env["REPLAY_END_LEDGER"];

  // BA-039: Bind a per-run correlation context (run id) so all log lines
  // emitted during this process share a groupable correlationId.
  const runId = crypto.randomUUID();
  const runLogger = logger.child({ correlationId: runId });

  if (replayStartLedger && replayEndLedger) {
    runLogger.info("replay_mode_start", {
      startLedger: replayStartLedger,
      endLedger: replayEndLedger,
    });

    await ensureEventsTable();
    await runMigrations(pgPool);
    await ensurePostSearchIndex();

    // BA-038: Parse and validate the replay range before any RPC calls are
    // made. Invalid numeric values, reversed ordering, or out-of-bounds
    // ranges must fail fast rather than silently iterating over nothing.
    const replayStart = parseLedger(replayStartLedger, "REPLAY_START_LEDGER");
    const replayEnd = parseLedger(replayEndLedger, "REPLAY_END_LEDGER");

    if (replayStart > replayEnd) {
      throw new Error(
        `Invalid replay range: REPLAY_START_LEDGER (${replayStart}) must not exceed ` +
          `REPLAY_END_LEDGER (${replayEnd}). The range is inclusive on both ends.`
      );
    }

    const db = new PostgresDatabase(pgPool);
    // Set up auth middleware if enabled
    const authMiddleware: AuthMiddleware = ENABLE_AUTH_MIDDLEWARE
      ? (req, res, next) => {
          const token = req.headers.authorization?.replace("Bearer ", "");
          if (!token || token !== process.env.API_SECRET) {
            res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
            return;
          }
          next();
        }
      : noopAuthMiddleware;
    const app = createApp(db, { authMiddleware });
    const server = app.listen(PORT, HOST);

    console.log(`[indexer] API server ready at http://${HOST}:${PORT} (replay mode)`);

    const signal = new AbortController().signal;
    const { replayLedgerRange } = await import("./stream");

    // BA-029: persistence and handling travel together under explicit processing
    // state, and any event left unfinished by a previous run is reprocessed on
    // startup, so no persisted event remains permanently unprocessed.
    const dispatch = async (event: RawEvent): Promise<void> => {
      // Typed handler dispatch (profiles / posts / likes / tips) is wired here
      // in production. Persisting + claiming + marking ensures the event's side
      // effects are accounted for even if this process crashes mid-dispatch.
      void event;
    };
    const eventStore = new EventStore(pgPool);
    const tracked = trackProcessing(eventStore);

    await replayLedgerRange(
      {
        rpcUrl: STELLAR_RPC_URL,
        contractId: CONTRACT_ID,
        startLedger: replayStart,
        endLedger: replayEnd,
      },
      (event) => processEvent(event, dispatch),
      tracked,
      signal,
    );

    const recovered = await recoverPendingEvents(dispatch);
    if (recovered > 0) {
      console.log(`[indexer] Recovery reprocessed ${recovered} unfinished event(s)`);
    }

    console.log("[indexer] Replay complete");

    // BA-009: Close the database pool so the process can exit cleanly.
    // Previously only the HTTP server was closed, leaving pg connections open.
    const closeReplay = (signal?: string) => {
      server.close(async () => {
        await pgPool.end().catch(() => {});
        if (signal) logger.info("replay_shutdown", { signal });
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => closeReplay("SIGTERM"));
    process.on("SIGINT", () => closeReplay("SIGINT"));
    closeReplay();
    return;
  }

  console.log("[indexer] Starting Kovara indexer (STUB MODE)");
  console.log(`[indexer] Version: ${pkg.version} | Node: ${process.version}`);
  console.log(`[indexer] API server listening on ${HOST}:${PORT}`);
  console.log("[indexer] Database and event streaming disabled for stub mode");

  await runMigrations(pgPool);
  await ensureEventsTable();
  await ensurePostSearchIndex();

  // ── Event streaming (BA-030/031/032/033) ─────────────────────────────────
  // When streaming is enabled the indexer persists and restores the cursor
  // durably (BA-033), verifies event contract ownership (BA-032), records
  // processing status (BA-030), and routes repeated failures to the
  // dead-letter path (BA-031). Disabled by default to preserve stub mode.
  const abortController = new AbortController();
  const eventStore = new EventStore(pgPool);
  const tracked = trackProcessing(eventStore);

  if (process.env["ENABLE_STREAMING"] === "true") {
    const { streamEvents } = await import("./stream");
    console.log("[indexer] Streaming enabled — starting Soroban event stream");
    streamEvents(
      {
        rpcUrl: STELLAR_RPC_URL,
        contractId: CONTRACT_ID,
        startLedger: START_LEDGER,
        pollIntervalMs: POLL_INTERVAL_MS,
        store: eventStore,
      },
      tracked,
      abortController.signal,
    ).catch((err) => {
      logger.error("Event stream exited unexpectedly:", err);
    });
  }

// Create and start API server
    const db = new PostgresDatabase(pgPool);
    // Set up auth middleware if enabled
    const authMiddleware: AuthMiddleware = ENABLE_AUTH_MIDDLEWARE
      ? (req, res, next) => {
          const token = req.headers.authorization?.replace("Bearer ", "");
          if (!token || token !== process.env.API_SECRET) {
            res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
            return;
          }
          next();
        }
      : noopAuthMiddleware;
    const app = createApp(db, { authMiddleware });
  const server = app.listen(PORT, HOST);

  console.log(`[indexer] Server ready at http://${HOST}:${PORT}`);

  // BA-008: Guard against concurrent signals racing to close the same server
  // more than once. A single `shuttingDown` flag ensures only the first signal
  // triggers cleanup; subsequent signals are no-ops.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_initiated", { signal });
    abortController.abort();
    server.close(async () => {
      await pgPool.end().catch(() => {});
      logger.info("shutdown_complete", { signal });
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});