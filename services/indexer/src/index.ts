/**
 * Kovara Indexer — entry point.
 *
 * Connects to a Soroban RPC endpoint, streams contract events from the
 * Kovara contract, writes raw events to PostgreSQL, and dispatches each
 * event to the appropriate typed handler.
 *
 * Environment variables (all required unless noted):
 *   DATABASE_URL      - PostgreSQL connection string
 *   STELLAR_RPC_URL   - Soroban RPC endpoint
 *   CONTRACT_ID       - Bech32 contract address
 *   START_LEDGER      - Ledger sequence to start streaming from
 *   POLL_INTERVAL_MS  - (optional) polling interval in ms, default 5000
 */

import { Pool } from "pg";
import { streamEvents, RawEvent } from "./stream";
import { runMigrations } from "./migrate";

// ── Config ────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

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

  await ensureEventsTable();
  await runMigrations(pgPool);

  await streamEvents(
    {
      rpcUrl: STELLAR_RPC_URL,
      contractId: CONTRACT_ID,
      startLedger: START_LEDGER,
      pollIntervalMs: POLL_INTERVAL_MS,
    },
    handleEvent,
    abortController.signal
  );

  await pgPool.end();
  console.log("[indexer] Shutdown complete.");
}

main().catch((err) => {
  console.error("[indexer] Fatal error:", err);
  process.exit(1);
});
