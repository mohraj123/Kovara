/**
 * Static checks for the rewards/audit/submissions migration (#656-#659).
 *
 * The repo's DB layer is mocked in every other test (no real database is
 * required — see the comment at the top of src/db.ts), so these read the
 * migration SQL and assert on its contents rather than applying it to a live
 * PostgreSQL instance.
 *
 * The constraints asserted here are the ones that carry correctness on their
 * own. An application bug is catchable in review; a missing `UNIQUE` on an
 * idempotency key is a double payout in production and nothing at all until
 * then.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
}

const sql = readMigration("012_rewards_audit_submissions.sql");

describe("012_rewards_audit_submissions.sql — submissions (#659)", () => {
  it("creates the submissions table", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS submissions/i);
  });

  it("constrains status to the three states the feed and rules understand", () => {
    expect(sql).toMatch(
      /status\s+TEXT\s+NOT NULL DEFAULT 'pending'\s+CHECK\s+\(status IN \('pending', 'verified', 'rejected'\)\)/i
    );
  });

  it("rejects a non-positive value", () => {
    expect(sql).toMatch(/submissions_value_positive CHECK \(value > 0\)/i);
  });

  it("uses NUMERIC rather than BIGINT for the submitted value", () => {
    expect(sql).toMatch(/value\s+NUMERIC\(39,0\)\s+NOT NULL/i);
  });

  it("requires a verifier and timestamp for a verified submission", () => {
    // A "verified" row with no verifier is exactly what an audit must not
    // contain, so the database refuses to represent it.
    expect(sql).toMatch(/submissions_verification_consistent CHECK/i);
    expect(sql).toMatch(
      /status = 'verified' AND verified_by IS NOT NULL AND verified_at IS NOT NULL/i
    );
  });

  it("indexes the feed's default newest-first ordering", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_submissions_feed[\s\S]*?ON submissions \(submitted_at DESC, id DESC\)/i
    );
  });

  it("indexes each filter the feed supports", () => {
    expect(sql).toMatch(/idx_submissions_status/i);
    expect(sql).toMatch(/idx_submissions_submitter/i);
  });
});

describe("012_rewards_audit_submissions.sql — verifications (#656)", () => {
  it("keys a verification by submission and verifier", () => {
    // This primary key is the database-level enforcement of the "duplicate
    // votes" edge case: a repeat vote cannot be stored, so the rule holds even
    // if a caller forgets to check.
    expect(sql).toMatch(/PRIMARY KEY \(submission_id, verifier\)/i);
  });

  it("constrains the verdict", () => {
    expect(sql).toMatch(/verdict\s+TEXT\s+NOT NULL CHECK \(verdict IN \('approve', 'reject'\)\)/i);
  });
});

describe("012_rewards_audit_submissions.sql — rewards (#656, #657)", () => {
  it("stores accruals keyed so recomputation updates rather than duplicates", () => {
    expect(sql).toMatch(/PRIMARY KEY \(address, submission_id, kind\)/i);
  });

  it("constrains the accrual state machine", () => {
    expect(sql).toMatch(
      /state\s+TEXT\s+NOT NULL DEFAULT 'pending'\s+CHECK\s+\(state IN \('pending', 'claimable', 'claimed'\)\)/i
    );
  });

  it("forbids a negative reward", () => {
    expect(sql).toMatch(/amount\s+NUMERIC\(39,0\)\s+NOT NULL CHECK \(amount >= 0\)/i);
  });

  it("makes the claim idempotency key UNIQUE", () => {
    // The constraint, not the application check, is what makes two concurrent
    // claims of the same key resolve to one payout.
    expect(sql).toMatch(/idempotency_key\s+TEXT\s+NOT NULL UNIQUE/i);
  });

  it("records claim metadata and timestamps", () => {
    expect(sql).toMatch(/claimed_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
    expect(sql).toMatch(/completed_at\s+TIMESTAMPTZ/i);
    expect(sql).toMatch(/transaction_hash\s+TEXT/i);
    expect(sql).toMatch(/failure_reason\s+TEXT/i);
  });

  it("constrains the claim state machine", () => {
    expect(sql).toMatch(
      /state\s+TEXT\s+NOT NULL DEFAULT 'processing'\s+CHECK\s+\(state IN \('processing', 'completed', 'failed'\)\)/i
    );
  });

  it("indexes in-flight claims, which the status endpoint subtracts", () => {
    expect(sql).toMatch(/idx_reward_claims_processing[\s\S]*?WHERE state = 'processing'/i);
  });
});

describe("012_rewards_audit_submissions.sql — audit log (#658)", () => {
  it("stores a hash and a previous hash per entry", () => {
    // Without previous_hash, a deleted entry is indistinguishable from one that
    // never existed.
    expect(sql).toMatch(/hash\s+CHAR\(64\)\s+NOT NULL/i);
    expect(sql).toMatch(/previous_hash\s+CHAR\(64\)\s+NOT NULL/i);
  });

  it("records occurred_at separately from recorded_at", () => {
    // A backdated import is still recorded truthfully; collapsing the two would
    // make a backfilled entry look like a live one.
    expect(sql).toMatch(/occurred_at\s+TIMESTAMPTZ\s+NOT NULL/i);
    expect(sql).toMatch(/recorded_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
  });

  it("retains metadata verbatim as JSONB", () => {
    expect(sql).toMatch(/metadata\s+JSONB\s+NOT NULL DEFAULT '\{\}'::jsonb/i);
  });

  it("constrains outcome so a failure is distinguishable from an attempt", () => {
    expect(sql).toMatch(
      /outcome\s+TEXT\s+NOT NULL CHECK \(outcome IN \('success', 'failure', 'skipped'\)\)/i
    );
  });

  it("prefixes the stored actor so an address cannot collide with a component", () => {
    expect(sql).toMatch(/'address:G\.\.\.' \| 'system:<component>' \| 'unknown'/i);
  });

  it("indexes the primary read path newest-first with a total ordering", () => {
    expect(sql).toMatch(
      /idx_audit_log_stream_recent[\s\S]*?ON audit_log \(stream, occurred_at DESC, id DESC\)/i
    );
  });

  it("indexes each supported filter", () => {
    expect(sql).toMatch(/idx_audit_log_action/i);
    expect(sql).toMatch(/idx_audit_log_subject/i);
    expect(sql).toMatch(/idx_audit_log_actor/i);
  });

  it("creates the chain head table that concurrent appends lock", () => {
    // Without a single lockable row per stream, two appends read the same head
    // and the chain forks.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_chain_heads/i);
    expect(sql).toMatch(/stream\s+TEXT\s+PRIMARY KEY/i);
  });
});

describe("012_rewards_audit_submissions.sql — versioning", () => {
  it("does not collide with another migration's version prefix", () => {
    // The runner keys applied migrations by filename prefix alone, so two files
    // sharing a prefix means one is silently skipped. 010 is PR #773 and 011 is
    // PR #774.
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const mine = "012_rewards_audit_submissions.sql";
    const prefix = mine.split("_")[0];
    expect(files.filter((f) => f !== mine && f.split("_")[0] === prefix)).toEqual([]);
  });
});
