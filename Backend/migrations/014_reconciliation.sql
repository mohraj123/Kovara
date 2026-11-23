-- Migration: Daily reconciliation runs and their discrepancies (#669)
-- Description:
--   The aggregation job (#651) writes `price_index_aggregates` from
--   `price_submissions`, but nothing compares the two. These tables give the
--   reconciliation job somewhere to record what it checked and what it found:
--
--     reconciliation_runs           — one row per (day) attempt; the row is the
--                                     lease, so a day is reconciled once across
--                                     replicas and a failed run is visible.
--     reconciliation_discrepancies  — one row per differing (country, category)
--                                     group, with both sides' counts and totals.
--
--   Results must be a queryable reporting surface, not a log line: an operator
--   asks "was yesterday's index consistent, and where did it drift" through the
--   API, which reads these tables.
--
-- `IF NOT EXISTS` throughout: the migration is re-runnable, matching
-- 010_event_reliability.sql and the rest of the suite.

CREATE TABLE IF NOT EXISTS reconciliation_runs (
    run_date          DATE        PRIMARY KEY,
    -- running | balanced | discrepancies | skipped | failed
    status            TEXT        NOT NULL DEFAULT 'running',
    -- Groups (country, category) seen on each side. Kept separately from the
    -- matched count so a one-sided day is distinguishable from an empty one.
    source_groups     INTEGER     NOT NULL DEFAULT 0,
    aggregate_groups  INTEGER     NOT NULL DEFAULT 0,
    matched_groups    INTEGER     NOT NULL DEFAULT 0,
    discrepancy_count INTEGER     NOT NULL DEFAULT 0,
    error             TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status
    ON reconciliation_runs (status);

CREATE TABLE IF NOT EXISTS reconciliation_discrepancies (
    run_date        DATE        NOT NULL REFERENCES reconciliation_runs(run_date) ON DELETE CASCADE,
    country_iso     TEXT        NOT NULL,
    category        TEXT        NOT NULL,
    -- missing_aggregate | missing_source | count_mismatch | value_mismatch
    kind            TEXT        NOT NULL,
    -- One side is NULL when the group exists only on the other side.
    source_count    INTEGER,
    aggregate_count INTEGER,
    -- NUMERIC, matching the source and aggregate columns: a price total is the
    -- contract's i128 and overflows BIGINT for a high-decimal token.
    source_value    NUMERIC,
    aggregate_value NUMERIC,
    count_delta     INTEGER,
    value_delta     NUMERIC,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One finding per group per run; a re-run replaces its own rows.
    PRIMARY KEY (run_date, country_iso, category)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_recent
    ON reconciliation_discrepancies (run_date DESC, country_iso, category);
