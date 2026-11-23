-- Migration: Price index observations, daily aggregates, and filter-decision log
-- Description:
--   #652: Median and credibility-weighted aggregation inputs plus a durable
--         daily aggregate table, so a published index value is reproducible
--         rather than recomputed per request.
--   #653: A durable log of every filter decision (inclusion/exclusion and the
--         threshold responsible), so a disputed index value can be traced back
--         to the exact observations that were removed and why.
--   #654/#655: Storage backing the historical index series and country
--         leaderboards.
--
-- Version note: this is numbered 011 rather than 010 because PR #773
-- (feature/event-processing-reliability) already claims 010 with
-- 010_event_reliability.sql. The migration runner keys applied migrations by
-- the filename prefix alone, so two files sharing a prefix means one of them is
-- silently skipped. Skipping 010 here keeps both migrations applicable after
-- the branches merge.

-- ── Price observations (#652) ────────────────────────────────────────────────
-- Raw crowdsourced price submissions, one row per submission.
CREATE TABLE IF NOT EXISTS price_observations (
    id              TEXT        PRIMARY KEY,
    country_iso     CHAR(2)     NOT NULL,
    category        TEXT        NOT NULL,
    -- Price in the contract's smallest fixed-point unit. NUMERIC(39,0) mirrors
    -- the contract's i128: BIGINT would overflow for any token with more than
    -- ~9 decimals scaled up, silently publishing a rounded index.
    value           NUMERIC(39,0) NOT NULL,
    submitter       TEXT        NOT NULL,
    -- pending | verified | rejected
    status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'verified', 'rejected')),
    -- Observation time (when the price was observed), distinct from created_at
    -- (when the row was ingested).
    observed_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A submission is a positive price by definition. Enforcing it here means
    -- the aggregation never has to defend against a zero or negative
    -- observation reaching the median.
    CONSTRAINT price_observations_value_positive CHECK (value > 0)
);

-- Primary access path: the verified observations for one country and category
-- within a window, which is exactly what a daily aggregation run scans.
CREATE INDEX IF NOT EXISTS idx_price_observations_agg_window
    ON price_observations (country_iso, category, observed_at DESC)
    WHERE status = 'verified';

-- Supports the per-submitter influence cap: counting a submitter's
-- contributions within a window requires their rows grouped by submitter.
CREATE INDEX IF NOT EXISTS idx_price_observations_submitter
    ON price_observations (country_iso, category, submitter, observed_at DESC);

-- ── Daily aggregates (#652, #654) ─────────────────────────────────────────────
-- One row per (run_date, country, category). This is the canonical published
-- index: the API serves it directly rather than recomputing, so every reader
-- sees the same value for a given day.
CREATE TABLE IF NOT EXISTS price_index_aggregates (
    run_date          DATE        NOT NULL,
    country_iso       CHAR(2)     NOT NULL,
    category          TEXT        NOT NULL,
    -- Median and credibility-weighted mean of the included observations. Both
    -- are kept: the median is robust and the weighted mean rewards
    -- corroboration, and they are deliberately separate columns so one cannot
    -- silently be used in place of the other.
    median_value      NUMERIC(39,0) NOT NULL,
    weighted_value    NUMERIC(39,0) NOT NULL,
    sample_count      INTEGER     NOT NULL DEFAULT 0,
    contributor_count INTEGER     NOT NULL DEFAULT 0,
    excluded_count    INTEGER     NOT NULL DEFAULT 0,
    -- JSONB breakdown of exclusions by reason, so a published row explains its
    -- own sample size.
    excluded_by_reason JSONB      NOT NULL DEFAULT '{}'::jsonb,
    -- When the aggregate was computed. Deliberately distinct from run_date: a
    -- catch-up run computes yesterday's row today, and conflating the two would
    -- make a backfilled day indistinguishable from a fresh one.
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One aggregate per day per country per category. The upsert in the
    -- aggregation job relies on this to make a re-run idempotent.
    PRIMARY KEY (run_date, country_iso, category)
);

-- Descending by date because both read paths are chronological: the history
-- series is newest-first and the leaderboard windows the most recent days.
CREATE INDEX IF NOT EXISTS idx_price_index_aggregates_recent
    ON price_index_aggregates (run_date DESC, country_iso, category);

-- Country leaderboard: ranks countries by index value over a window.
CREATE INDEX IF NOT EXISTS idx_price_index_aggregates_country
    ON price_index_aggregates (country_iso, run_date DESC);

-- ── Filter decision log (#653) ───────────────────────────────────────────────
-- Append-only record of every observation considered by a daily run, with the
-- reason it was kept or dropped and the threshold that decided it. Retaining
-- the decision (not just the outcome) is what makes a disputed index
-- reviewable: "submission s3 was excluded because it exceeded 1_500_000" is
-- answerable, "we removed some outliers" is not.
CREATE TABLE IF NOT EXISTS price_index_filter_decisions (
    run_date      DATE         NOT NULL,
    country_iso   CHAR(2)      NOT NULL,
    category      TEXT         NOT NULL,
    submission_id TEXT         NOT NULL,
    value         NUMERIC(39,0) NOT NULL,
    included      BOOLEAN      NOT NULL,
    -- One of the FilterReason values in src/analytics/index-aggregation.ts.
    reason        TEXT         NOT NULL,
    -- The bound or fence that produced the decision, NULL when the reason does
    -- not have one (e.g. a status rejection).
    threshold     NUMERIC(39,0),
    recorded_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Idempotent recording: a re-run for the same day replaces its own
    -- decisions rather than accumulating duplicates.
    PRIMARY KEY (run_date, country_iso, category, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_price_index_filter_decisions_excluded
    ON price_index_filter_decisions (run_date DESC, country_iso, category)
    WHERE NOT included;
