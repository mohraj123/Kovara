-- Event-processing reliability and daily index aggregation.
--
--   #648  event_idempotency        — stable, derived keys so a duplicate ledger
--                                     event is a no-op rather than a second write.
--   #650  event_dead_letters       — durable queue for unrecoverable failures,
--                                     with the full payload needed to debug them.
--   #651  aggregation_runs         — the lease + outcome of each daily run, so a
--                                     run is exactly-once across replicas and a
--                                     failure is visible in the run history.
--         price_index_aggregates    — one aggregate per (day, country, category),
--                                     with both the day summarised and the time
--                                     the computation actually ran.
--         price_submissions         — the per-submission rows the job reduces.
--                                     Created here so the job has a source to read
--                                     from its first deployment.
--
-- `IF NOT EXISTS` throughout: the migration is re-runnable, matching the
-- idempotent style already used by 001_profiles.sql / 008_cache_coordination.sql.

-- ── #648: idempotency keys ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_idempotency (
    -- Derived, namespaced key (see src/idempotency.ts). Derived rather than
    -- caller-supplied so a key cannot be reused across two different events.
    idempotency_key  TEXT        PRIMARY KEY,
    -- pending | claimed | processed | failed
    status           TEXT        NOT NULL DEFAULT 'pending',
    attempts         INTEGER     NOT NULL DEFAULT 0,
    error            TEXT,
    claimed_at       TIMESTAMPTZ,
    processed_at     TIMESTAMPTZ,
    failed_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports the "give me everything still owed" sweep that recovery performs.
CREATE INDEX IF NOT EXISTS idx_event_idempotency_status
    ON event_idempotency (status);

-- ── #650: dead-letter queue ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_dead_letters (
    idempotency_key  TEXT        PRIMARY KEY,
    event_id         TEXT        NOT NULL,
    contract_id      TEXT        NOT NULL,
    tx_hash          TEXT        NOT NULL,
    ledger           INTEGER     NOT NULL,
    event_type       TEXT        NOT NULL DEFAULT '',
    -- The raw topic and value are kept unredacted on purpose: this table is
    -- read by operators to reproduce a failure, so it must hold the payload.
    -- (Log lines still redact payloads; see src/logger.ts.)
    topic            TEXT[]      NOT NULL DEFAULT '{}',
    value            TEXT        NOT NULL DEFAULT '',
    error            TEXT        NOT NULL,
    -- retries_exhausted | permanent_failure | invalid_payload | wrong_contract
    reason           TEXT        NOT NULL,
    attempts         INTEGER     NOT NULL DEFAULT 1,
    dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Set when an operator requeued the event; NULL while it still needs attention.
    requeued_at      TIMESTAMPTZ
);

-- The operator view: what is outstanding, newest first.
CREATE INDEX IF NOT EXISTS idx_event_dead_letters_pending
    ON event_dead_letters (dead_lettered_at DESC)
    WHERE requeued_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_dead_letters_contract
    ON event_dead_letters (contract_id, ledger);

-- ── #651: daily aggregation ──────────────────────────────────────────────────

-- One row per attempted run. The row *is* the lease: a second worker cannot
-- insert the same run_date, and only a failed/running row can be reclaimed, so
-- a completed day is never aggregated twice.
CREATE TABLE IF NOT EXISTS aggregation_runs (
    run_date           DATE        PRIMARY KEY,
    -- running | success | partial | failed | skipped
    status             TEXT        NOT NULL DEFAULT 'running',
    aggregates_written INTEGER     NOT NULL DEFAULT 0,
    -- Groups that had data but were below the contributor threshold. Tracked
    -- separately from `aggregates_written` so a thin day is distinguishable
    -- from a day with no submissions at all.
    empty_groups       INTEGER     NOT NULL DEFAULT 0,
    error              TEXT,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aggregation_runs_status ON aggregation_runs (status);

-- The aggregated index, one row per (day, country, category).
--
-- `run_date` and `computed_at` are deliberately separate: a catch-up run
-- computes yesterday's index today, and conflating the two would make a
-- late-computed historical day indistinguishable from a fresh one.
CREATE TABLE IF NOT EXISTS price_index_aggregates (
    run_date          DATE        NOT NULL,
    country_iso       TEXT        NOT NULL,
    category          TEXT        NOT NULL,
    sample_count      INTEGER     NOT NULL,
    -- Prices are i128 on-chain, held as NUMERIC here: BIGINT would overflow on
    -- any token with 7+ decimals scaled into the smallest unit, and a rounded
    -- price publishes a wrong cost-of-living index.
    total_value       NUMERIC     NOT NULL,
    mean_value        NUMERIC     NOT NULL,
    contributor_count INTEGER     NOT NULL,
    computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_date, country_iso, category)
);

CREATE INDEX IF NOT EXISTS idx_price_index_aggregates_country
    ON price_index_aggregates (country_iso, category, run_date DESC);

-- The per-submission rows the job reduces. Mirrors `PriceSubmission` in
-- Contract/contracts/price-vault/src/lib.rs, including the validity window
-- (`valid_from` / `valid_until`) and the lifecycle status.
CREATE TABLE IF NOT EXISTS price_submissions (
    submission_id  TEXT        PRIMARY KEY,
    country_iso    TEXT        NOT NULL,
    category       TEXT        NOT NULL,
    -- Smallest fixed-point unit, as submitted. NUMERIC for the same reason as
    -- above: the contract type is i128.
    value          NUMERIC     NOT NULL,
    submitter      TEXT        NOT NULL,
    timestamp      BIGINT      NOT NULL,
    valid_from     BIGINT      NOT NULL,
    valid_until    BIGINT      NOT NULL,
    -- pending | verified | rejected, mirroring the contract enum.
    status         TEXT        NOT NULL DEFAULT 'pending',
    -- Observation time, used to bucket submissions into the day they belong to.
    submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The job's read path: one day's submissions, filtered by status.
CREATE INDEX IF NOT EXISTS idx_price_submissions_day
    ON price_submissions (submitted_at, status);

CREATE INDEX IF NOT EXISTS idx_price_submissions_lookup
    ON price_submissions (country_iso, category, submitted_at DESC);
