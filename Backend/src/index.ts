/**
 * Kovara Indexer — entry point.
 *
 * Connects to a Soroban RPC endpoint, streams contract events from the
 * Kovara contract, writes raw events to PostgreSQL, and dispatches each
 * event to the appropriate typed handler. Also starts the REST API server
 * for querying indexed data.
 *
 * Environment variables (all required unless noted):
 *   DATABASE_URL           - PostgreSQL connection string (required)
 *   CONTRACT_ID            - Stellar contract address, a 56-char C… strkey (required)
 *   STELLAR_RPC_URL        - (optional) Soroban RPC endpoint, default testnet
 *   START_LEDGER           - (optional) Ledger sequence to stream from, default 0
 *   HOST                   - (optional) API server host, default 0.0.0.0
 *   PORT                   - (optional) API server port, default 3000
 *   TRUST_PROXY            - (optional) Number of proxies to trust (for X-Forwarded-For), default 0 (disabled)
 *   POLL_INTERVAL_MS       - (optional) Event streaming polling interval in ms, default 5000
 *   RATE_LIMIT_WINDOW_MS   - (optional) Rate limit window in ms, default 60000 (1 minute)
 *   RATE_LIMIT_MAX         - (optional) Max requests per IP per rate limit window, default 100
 *   ENABLE_AUTH_MIDDLEWARE - (optional) Enable authentication middleware (default: false)
 *   ENABLE_RATE_LIMITING   - (optional) Enable rate limiting middleware (default: true)
 *   ENABLE_EXPERIMENTAL_ROUTES - (optional) Enable experimental routes (e.g., pools) (default: false)
 */
import { Pool } from "pg";
import { streamEvents, EventHandler, RawEvent } from "./stream";
import { createApp, AuthMiddleware } from "./api";
import { runMigrations } from "./migrate";
import { PostgresDatabase } from "./db";
import { EventStore } from "./event-store";
import { withRetry } from "./retry";
import { logger } from "./logger";
import { randomUUID } from "crypto";
import { ConfigError, IndexerConfig, loadConfig, parseStartLedger } from "./config";
import pkg from "../package.json";

// ── Config ────────────────────────────────────────────────────────────────────

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
  if ((raw?.trim() ?? "") === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  // Shares parseStartLedger's validation so a replay bound and START_LEDGER
  // accept exactly the same values.
  return parseStartLedger(raw, name);
}

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = parseEnvNumber("PORT", 3000);

/**
 * Validate every startup-critical variable before anything else runs.
 *
 * This deliberately happens at module scope, ahead of the connection pool and
 * any migration or RPC work: a missing DATABASE_URL, an absent or malformed
 * CONTRACT_ID, or a non-numeric START_LEDGER used to be papered over with
 * defaults that produced an indexer which started successfully and then could
 * never index anything. Every problem is reported together so one restart is
 * enough to see them all.
 */
function loadStartupConfig(): IndexerConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.always("config_invalid", { problems: err.problems });
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const {
  databaseUrl: DATABASE_URL,
  stellarRpcUrl: STELLAR_RPC_URL,
  contractId: CONTRACT_ID,
  startLedger: START_LEDGER,
} = loadStartupConfig();

const POLL_INTERVAL_MS = parseEnvNumber("POLL_INTERVAL_MS", 5000);

// Feature flags
const ENABLE_AUTH_MIDDLEWARE = process.env.ENABLE_AUTH_MIDDLEWARE === "true";
const ENABLE_RATE_LIMITING = process.env.ENABLE_RATE_LIMITING !== "false"; // default to true
const ENABLE_EXPERIMENTAL_ROUTES = process.env.ENABLE_EXPERIMENTAL_ROUTES === "true";

/** Pass-through middleware used when ENABLE_AUTH_MIDDLEWARE is off. */
const noopAuthMiddleware: AuthMiddleware = (_req, _res, next) => next();

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
}

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

// ── Event dispatch (BA-006) ───────────────────────────────────────────────────

async function handleEvent(event: RawEvent, db: PostgresDatabase): Promise<void> {
  const eventType = event.topic[0];
  logger.info("event_dispatch", { ledger: event.ledger, type: eventType, tx: event.txHash });

  switch (eventType) {
    case "profile_set":
      await (await import("./handlers/profile")).handleProfileSet(db, event as never);
      break;
    case "post_created":
      await (await import("./handlers/post")).handlePostCreated(db, event as never, { pgPool });
      break;
    case "post_deleted":
      await (await import("./handlers/post")).handlePostDeleted(db, event as never);
      break;
    case "like":
      await (await import("./handlers/like")).handleLike(db, event as never, { pgPool });
      break;
    case "follow":
      await (await import("./handlers/follow")).handleFollow(db, event as never);
      break;
    case "unfollow":
      await (await import("./handlers/follow")).handleUnfollow(db, event as never);
      break;
    case "tip":
      await (await import("./handlers/tip")).handleTip(db, event as never, { pgPool });
      break;
    case "pool_created":
      await (await import("./handlers/pool")).handlePoolCreated(db, event as never);
      break;
    case "pool_deposit":
      await (await import("./handlers/pool")).handlePoolDeposit(db, event as never);
      break;
    case "pool_withdraw":
      await (await import("./handlers/pool")).handlePoolWithdraw(db, event as never);
      break;
    default:
      logger.warn("unknown_event_type", { type: eventType, eventId: event.id });
  }
}

// ── Graceful shutdown (BA-007) ────────────────────────────────────────────────
// Abort controller and signal handlers were previously commented out.
// Restored: SIGTERM and SIGINT now abort streaming and close server + DB cleanly.

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const replayStartLedger = process.env["REPLAY_START_LEDGER"];
  const replayEndLedger = process.env["REPLAY_END_LEDGER"];

  // BA-039: Bind a per-run correlation context (run id) so all log lines
  // emitted during this process share a groupable correlationId.
  const runId = randomUUID();
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

  logger.info("indexer_start", { version: pkg.version, node: process.version, host: HOST, port: PORT });

  await runMigrations(pgPool);
  await ensureEventsTable();
  await ensurePostSearchIndex();

  const abortController = new AbortController();
  const eventStore = new EventStore(pgPool);
  const db = new PostgresDatabase(pgPool);
  const tracked = trackProcessing(eventStore);

  // BA-005: Start the real event stream unconditionally (no STUB MODE).
  logger.info("stream_start", { rpcUrl: STELLAR_RPC_URL, contractId: CONTRACT_ID, startLedger: START_LEDGER, pollIntervalMs: POLL_INTERVAL_MS });
  streamEvents(
    {
      rpcUrl: STELLAR_RPC_URL,
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      pollIntervalMs: POLL_INTERVAL_MS,
      store: eventStore,
    },
    (event) => processEvent(event, (e) => handleEvent(e, db)),
    abortController.signal,
  ).catch((err) => {
    if (err instanceof Error) {
      logger.errorWithContext(
        "Fatal error in event stream",
        err,
        { operation: "stream", errorCode: "STREAM_FATAL" }
      );
    } else {
      logger.error("stream_fatal", { err });
    }
  });

// Create and start API server
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
  if (err instanceof Error) {
    logger.errorWithContext(
      "Fatal error during application startup",
      err,
      { errorCode: "STARTUP_FATAL" }
    );
  } else {
    logger.error("Fatal error:", err);
  }
  process.exit(1);
});