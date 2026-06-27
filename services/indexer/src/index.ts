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
 */

import { Pool } from "pg";
import { streamEvents, RawEvent } from "./stream";
import { createApp } from "./api";
import { runMigrations } from "./migrate";

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

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = parseEnvNumber("PORT", 3000);

const DATABASE_URL = requireEnv("DATABASE_URL");
const STELLAR_RPC_URL = requireEnv("STELLAR_RPC_URL");
const CONTRACT_ID = requireEnv("CONTRACT_ID");
const START_LEDGER = parseInt(requireEnv("START_LEDGER"), 10);
const POLL_INTERVAL_MS = process.env["POLL_INTERVAL_MS"]
  ? parseInt(process.env["POLL_INTERVAL_MS"], 10)
  : undefined;

// ── Database ──────────────────────────────────────────────────────────────────

const pgPool = new Pool({ connectionString: DATABASE_URL });

async function ensureEventsTable(): Promise<void> {
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
}

async function ensurePostSearchIndex(): Promise<void> {
  await pgPool.query(`
    ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
  `);
  await pgPool.query(`
    UPDATE posts
    SET search_vector = to_tsvector('simple', coalesce(content, ''))
    WHERE search_vector IS NULL
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS idx_posts_search_vector
    ON posts USING GIN (search_vector)
  `);
}

async function persistEvent(event: RawEvent): Promise<void> {
  await pgPool.query(
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
  );
}

// ── Event dispatch ────────────────────────────────────────────────────────────

async function handleEvent(event: RawEvent): Promise<void> {
  await persistEvent(event);

  const eventType = event.topic[0];
  console.log(`[indexer] ledger=${event.ledger} type=${eventType} tx=${event.txHash}`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

const abortController = new AbortController();

function shutdown(signal: string): void {
  console.log(`[indexer] Received ${signal}, shutting down…`);
  abortController.abort();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[indexer] Starting Kovara indexer");
  console.log(`[indexer] RPC:      ${STELLAR_RPC_URL}`);
  console.log(`[indexer] Contract: ${CONTRACT_ID}`);
  console.log(`[indexer] From ledger: ${START_LEDGER}`);
  console.log(`[indexer] API server listening on ${HOST}:${PORT}`);

  await ensureEventsTable();
  await runMigrations(pgPool);

  // Create and start API server
  const app = createApp(pgPool);
  const server = app.listen(PORT, HOST);

  // Start event streaming in the background
  streamEvents(
    {
      rpcUrl: STELLAR_RPC_URL,
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      pollIntervalMs: POLL_INTERVAL_MS,
    },
    handleEvent,
    abortController.signal
  ).catch((err) => {
    console.error("[indexer] Event streaming error:", err);
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on("SIGTERM", () => {
    server.close(() => {
      console.log("[indexer] API server closed");
      pgPool.end().then(() => {
        console.log("[indexer] Shutdown complete.");
        process.exit(0);
      });
    });
  });

  process.on("SIGINT", () => {
    server.close(() => {
      console.log("[indexer] API server closed");
      pgPool.end().then(() => {
        console.log("[indexer] Shutdown complete.");
        process.exit(0);
      });
    });
  });
}

main().catch((err) => {
  console.error("[indexer] Fatal error:", err);
  process.exit(1);
});