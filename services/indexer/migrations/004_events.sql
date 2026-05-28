-- Migration 004: raw on-chain events
--
-- Stores raw event payloads emitted by the Linkora contract.

CREATE TABLE IF NOT EXISTS events (
    id               BIGSERIAL PRIMARY KEY,
    contract_address TEXT        NOT NULL,
    event_type       TEXT        NOT NULL,
    tx_hash          TEXT        NOT NULL,
    ledger           INTEGER     NOT NULL,
    topic            JSONB       NOT NULL,
    value            JSONB       NOT NULL,
    raw_event        JSONB       NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tx_hash, ledger, event_type)
);

CREATE INDEX IF NOT EXISTS idx_events_contract_ledger
    ON events (contract_address, ledger DESC);
