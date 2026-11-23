-- Migration: Reward accruals and claims, tamper-evident audit log, submission feed
-- Description:
--   #656: Per-address reward accruals derived from stored submission and
--         verification data, so a payout is reproducible rather than accumulated
--         by an opaque running total.
--   #657: Claim lifecycle with pending/claimable/claimed/processing states, claim
--         metadata, timestamps, and an idempotency key so a client retry cannot
--         pay out twice.
--   #658: Append-only audit log with a per-stream hash chain, plus a head table
--         that serialises concurrent appends so the chain cannot fork.
--   #659: Submissions table with status/user/date columns and the indexes the
--         feed's filters and its newest-first ordering need.
--
-- Version note: 012 follows 010 (PR #773, event reliability) and 011 (PR #774,
-- index analytics). The migration runner keys applied migrations by filename
-- prefix alone, so each number here is claimed by exactly one file.

-- ── Submissions (#659, and the input to #656) ────────────────────────────────
-- One row per crowdsourced submission. This is the verification workflow's
-- record, distinct from the published aggregate an index run derives from it.
CREATE TABLE IF NOT EXISTS submissions (
    id            TEXT        PRIMARY KEY,
    submitter     TEXT        NOT NULL,
    -- pending | verified | rejected. Constrained so a fourth state can never
    -- reach a filter or a reward rule that does not understand it.
    status        TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'verified', 'rejected')),
    country_iso   CHAR(2),
    category      TEXT,
    -- Price in the contract's smallest fixed-point unit. NUMERIC(39,0) for the
    -- same reason as elsewhere: BIGINT would overflow an i128-scaled value and
    -- publish a rounded, wrong figure.
    value         NUMERIC(39,0) NOT NULL,
    verified_by   TEXT,
    verified_at   TIMESTAMPTZ,
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT submissions_value_positive CHECK (value > 0),

    -- A verification is only meaningful once, and a verified submission must
    -- record who verified it and when. Enforced here so a "verified" row with
    -- no verifier cannot exist — an unverifiable verified claim is exactly the
    -- thing an audit must not contain.
    CONSTRAINT submissions_verification_consistent CHECK (
        (status = 'verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
        OR (status <> 'verified')
    )
);

-- The feed's default ordering is submitted_at DESC, id DESC. This composite
-- index serves both, and serves the filtered variants for country/category.
CREATE INDEX IF NOT EXISTS idx_submissions_feed
    ON submissions (submitted_at DESC, id DESC);

-- status as a leading column for "show me the verified queue".
CREATE INDEX IF NOT EXISTS idx_submissions_status
    ON submissions (status, submitted_at DESC, id DESC);

-- The "submissions by this user" filter.
CREATE INDEX IF NOT EXISTS idx_submissions_submitter
    ON submissions (submitter, submitted_at DESC, id DESC);

-- Reward recomputation reads verified submissions with their corroboration
-- count; country/category are the grouping keys.
CREATE INDEX IF NOT EXISTS idx_submissions_verified_window
    ON submissions (country_iso, category, submitted_at DESC)
    WHERE status = 'verified';

-- Verification records are the other half of a reward calculation. Kept
-- append-only and separately keyed so a re-submission cannot overwrite history.
CREATE TABLE IF NOT EXISTS verifications (
    submission_id TEXT        NOT NULL,
    verifier      TEXT        NOT NULL,
    -- approve | reject
    verdict       TEXT        NOT NULL CHECK (verdict IN ('approve', 'reject')),
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One vote per verifier per submission. This is the database-level
    -- enforcement of the "duplicate votes" edge case: a repeated vote is
    -- rejected at insert, so the rule holds even if a caller forgets to check.
    PRIMARY KEY (submission_id, verifier)
);

CREATE INDEX IF NOT EXISTS idx_verifications_verifier
    ON verifications (verifier, recorded_at DESC);

-- ── Reward accruals (#656, #657) ─────────────────────────────────────────────
-- One row per (address, submission, kind). Balances are always derived by
-- summing these rows; no running total is stored, so a total and its lines
-- cannot disagree.
CREATE TABLE IF NOT EXISTS reward_accruals (
    address       TEXT        NOT NULL,
    submission_id TEXT        NOT NULL,
    -- corroboration (earned as a submitter) | verification (earned as a verifier)
    kind          TEXT        NOT NULL
                              CHECK (kind IN ('corroboration', 'verification')),
    amount        NUMERIC(39,0) NOT NULL CHECK (amount >= 0),
    -- pending (held for review) | claimable | claimed
    state         TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (state IN ('pending', 'claimable', 'claimed')),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Re-running a reward calculation updates these rows rather than inserting
    -- duplicates, which is what makes recomputation idempotent.
    PRIMARY KEY (address, submission_id, kind)
);

-- The status endpoint sums by address and state.
CREATE INDEX IF NOT EXISTS idx_reward_accruals_by_state
    ON reward_accruals (address, state);

-- ── Reward claims (#657) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reward_claims (
    claim_id         TEXT        PRIMARY KEY,
    address          TEXT        NOT NULL,
    amount           NUMERIC(39,0) NOT NULL CHECK (amount >= 0),
    -- processing (in flight) | completed | failed
    state            TEXT        NOT NULL DEFAULT 'processing'
                                  CHECK (state IN ('processing', 'completed', 'failed')),
    claimed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    transaction_hash TEXT,
    failure_reason   TEXT,

    -- The idempotency key is UNIQUE, and that constraint — not the
    -- application check — is what makes two concurrent claims of the same key
    -- resolve to one payout. The second insert conflicts and the caller gets
    -- the winner's claim back.
    idempotency_key  TEXT        NOT NULL UNIQUE
);

-- Claim history is newest-first per address.
CREATE INDEX IF NOT EXISTS idx_reward_claims_by_address
    ON reward_claims (address, claimed_at DESC);

-- In-flight claims are what the status endpoint subtracts from `claimed` to
-- report money that has left the accrual pool but not yet settled on chain.
CREATE INDEX IF NOT EXISTS idx_reward_claims_processing
    ON reward_claims (address, state)
    WHERE state = 'processing';

-- ── Audit log (#658) ─────────────────────────────────────────────────────────
-- Append-only. Each row's hash covers its own canonical content plus the
-- previous row's hash, so altering or removing any row breaks verification for
-- every row after it.
--
-- There is no UPDATE or DELETE grant implied by this schema: revoking write
-- privileges on this table after the application role is set up is what makes
-- the chain meaningful, and is noted in the README.
CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT        PRIMARY KEY,
    -- Partition key. The chain is independent per stream, so concurrent writers
    -- for different streams do not block each other.
    stream          TEXT        NOT NULL,
    action          TEXT        NOT NULL,
    -- 'address:G...' | 'system:<component>' | 'unknown'. Prefixed so a filter
    -- for an address cannot match a system component with a similar name.
    actor           TEXT        NOT NULL,
    -- success | failure | skipped
    outcome         TEXT        NOT NULL CHECK (outcome IN ('success', 'failure', 'skipped')),
    subject         TEXT        NOT NULL,
    ledger          INTEGER,
    transaction_hash TEXT,
    -- Verbatim context. An audit entry that records only "submission.rejected"
    -- is not reviewable, so the detail captured at the time is retained.
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     TIMESTAMPTZ NOT NULL,

    hash         CHAR(64) NOT NULL,
    previous_hash CHAR(64) NOT NULL,

    -- Occurred at, and recorded at. A batch import can backdate occurred_at
    -- while recorded_at stays truthful, which is a distinction a forensic
    -- reviewer needs.
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The primary read path: newest-first, total ordering, for a stream.
CREATE INDEX IF NOT EXISTS idx_audit_log_stream_recent
    ON audit_log (stream, occurred_at DESC, id DESC);

-- Filtering by action or outcome without pinning a stream.
CREATE INDEX IF NOT EXISTS idx_audit_log_action
    ON audit_log (action, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_outcome
    ON audit_log (outcome, occurred_at DESC)
    WHERE outcome <> 'success';

-- Filtering by the entity or contract an action touched.
CREATE INDEX IF NOT EXISTS idx_audit_log_subject
    ON audit_log (subject, occurred_at DESC);

-- Filtering by actor.
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON audit_log (actor, occurred_at DESC);

-- Chain head per stream. Its only purpose is to be a single row that
-- concurrent appends can lock, which is what stops two writers reading the same
-- head and forking the chain.
CREATE TABLE IF NOT EXISTS audit_chain_heads (
    stream     TEXT        PRIMARY KEY,
    hash       CHAR(64)    NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
