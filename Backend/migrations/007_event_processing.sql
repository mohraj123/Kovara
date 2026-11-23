-- Migration: Event processing status, stream cursor persistence, and dead-letter support
-- Description:
--   BA-030: Track event processing status (pending/processed/failed/dead) with error
--           details and timestamps on the events table.
--   BA-031: Provide a durable dead-letter path so failed events can be retained and
--           retried safely by operators.
--   BA-033: Persist the latest safe stream cursor so restarts resume without event loss.

-- Extend the events table with processing-state columns (BA-030).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS status             TEXT        NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS error              TEXT,
  ADD COLUMN IF NOT EXISTS attempts           INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_lettered_at   TIMESTAMPTZ;

-- Processing status values: pending | processed | failed | dead
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);

-- Durable stream-state store (key/value) used to persist the latest safe cursor
-- (BA-033) and any future durable indexer state.
CREATE TABLE IF NOT EXISTS stream_state (
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
