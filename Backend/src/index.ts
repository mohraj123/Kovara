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
// import { streamEvents, RawEvent } from "./stream";
import { createApp } from "./api";
import { runMigrations } from "./migrate";
import { PostgresDatabase } from "./db";
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
        indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

// ── Event dispatch ────────────────────────────────────────────────────────────

// async function handleEvent(event: RawEvent): Promise<void> {
//   await persistEvent(event);

//   const eventType = event.topic[0];
//   console.log(`[indexer] ledger=${event.ledger} type=${eventType} tx=${event.txHash}`);
// }

// ── Graceful shutdown ─────────────────────────────────────────────────────────

// const abortController = new AbortController();

// function shutdown(signal: string): void {
//   console.log(`[indexer] Received ${signal}, shutting down…`);
//   abortController.abort();
// }

// process.on("SIGTERM", () => shutdown("SIGTERM"));
// process.on("SIGINT", () => shutdown("SIGINT"));

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

    await replayLedgerRange(
      {
        rpcUrl: STELLAR_RPC_URL,
        contractId: CONTRACT_ID,
        startLedger: replayStart,
        endLedger: replayEnd,
      },
      persistEvent,
      signal,
    );

    console.log("[indexer] Replay complete");

    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    process.on("SIGINT", () => server.close(() => process.exit(0)));
    return;
  }

  console.log("[indexer] Starting Kovara indexer (STUB MODE)");
  console.log(`[indexer] Version: ${pkg.version} | Node: ${process.version}`);
  console.log(`[indexer] API server listening on ${HOST}:${PORT}`);
  console.log("[indexer] Database and event streaming disabled for stub mode");

  await runMigrations(pgPool);
  await ensureEventsTable();
  await ensurePostSearchIndex();

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

  // Handle graceful shutdown
  process.on("SIGTERM", () => {
    server.close(() => {
      console.log("[indexer] API server closed");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    server.close(() => {
      console.log("[indexer] API server closed");
      process.exit(0);
    });
  });
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});