-- BA-029: track explicit processing state for every persisted raw event so a
-- crash between persistence and the downstream side effects never leaves an
-- event present but permanently unprocessed. Startup recovery reprocesses any
-- event that is not yet `processed`.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';

CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);
