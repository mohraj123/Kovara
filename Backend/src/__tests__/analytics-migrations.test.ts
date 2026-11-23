/**
 * Static checks for the price index analytics migration (#652-#655).
 *
 * The repo's DB layer is mocked in every other test (no real database is
 * required — see the comment at the top of src/db.ts), so these read the
 * migration SQL and assert on its contents rather than applying it to a live
 * PostgreSQL instance.
 *
 * These assertions exist because the mistakes they catch are invisible until
 * production: a wrong column type silently rounds published prices, and a
 * missing composite index turns a chart endpoint into a sequential scan.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
}

const sql = readMigration("011_price_index_analytics.sql");

describe("011_price_index_analytics.sql", () => {
  it("creates the observations table", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS price_observations/i);
  });

  it("stores observations in the category table used by the API", () => {
    expect(sql).toMatch(/country_iso\s+CHAR\(2\)\s+NOT NULL/i);
    expect(sql).toMatch(/category\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/submitter\s+TEXT\s+NOT NULL/i);
  });

  it("constrains status to the three states the aggregator understands", () => {
    // An unconstrained status would reach the aggregator as a fourth, unknown
    // state and be treated as verifiable by omission.
    expect(sql).toMatch(
      /status\s+TEXT\s+NOT NULL DEFAULT 'pending'\s+CHECK\s+\(status IN \('pending', 'verified', 'rejected'\)\)/i
    );
  });

  it("enforces a positive observation value", () => {
    // A zero or negative price would drag a mean below the truth and cannot be
    // a real measurement, so the database rejects it outright.
    expect(sql).toMatch(/CHECK \(value > 0\)/i);
  });

  it("uses NUMERIC rather than BIGINT for prices", () => {
    // The contract type is i128. BIGINT would overflow on a scaled token price
    // and publish a rounded — wrong — index.
    expect(sql).toMatch(/value\s+NUMERIC\(39,0\)\s+NOT NULL/i);
    expect(sql).not.toMatch(/value\s+BIGINT/i);
  });

  it("separates observation time from ingest time", () => {
    // A backfilled observation is observed on one date and stored on another;
    // collapsing the two would attribute it to the wrong day.
    expect(sql).toMatch(/observed_at\s+TIMESTAMPTZ\s+NOT NULL/i);
    expect(sql).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
  });

  it("indexes the aggregation scan path for verified observations", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_price_observations_agg_window[\s\S]*?ON price_observations \(country_iso, category, observed_at DESC\)\s*WHERE status = 'verified'/i
    );
  });

  it("indexes the per-submitter influence cap lookup", () => {
    expect(sql).toMatch(
      /idx_price_observations_submitter[\s\S]*?ON price_observations \(country_iso, category, submitter, observed_at DESC\)/i
    );
  });

  it("creates the daily aggregate table keyed by day, country, and category", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS price_index_aggregates/i);
    // The key that makes a catch-up re-run idempotent rather than duplicating.
    expect(sql).toMatch(
      /PRIMARY KEY \(run_date, country_iso, category\)/i
    );
  });

  it("stores the median and the weighted mean in separate columns", () => {
    // Deliberately not one "index_value" column: the two answer different
    // questions and neither should be silently substituted for the other.
    expect(sql).toMatch(/median_value\s+NUMERIC\(39,0\)\s+NOT NULL/i);
    expect(sql).toMatch(/weighted_value\s+NUMERIC\(39,0\)\s+NOT NULL/i);
  });

  it("records the exclusion breakdown on the aggregate row", () => {
    expect(sql).toMatch(/excluded_by_reason JSONB\s+NOT NULL DEFAULT '\{\}'::jsonb/i);
  });

  it("stores computed_at separately from run_date", () => {
    // A catch-up run computes yesterday's row today; conflating the two makes a
    // backfilled day indistinguishable from a fresh one.
    expect(sql).toMatch(/computed_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT NOW\(\)/i);
  });

  it("indexes the chronological access path used by history and leaderboards", () => {
    expect(sql).toMatch(
      /idx_price_index_aggregates_recent[\s\S]*?ON price_index_aggregates \(run_date DESC, country_iso, category\)/i
    );
  });

  it("creates the filter decision log keyed so a re-run replaces rather than duplicates", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS price_index_filter_decisions/i);
    expect(sql).toMatch(
      /PRIMARY KEY \(run_date, country_iso, category, submission_id\)/i
    );
  });

  it("records the threshold that produced each decision", () => {
    // Without the threshold, an exclusion cannot be reviewed — the log would
    // only say that something was dropped.
    expect(sql).toMatch(/threshold\s+NUMERIC\(39,0\)/i);
  });

  it("indexes excluded decisions for the review query", () => {
    expect(sql).toMatch(
      /idx_price_index_filter_decisions_excluded[\s\S]*?WHERE NOT included/i
    );
  });

  it("does not collide with another migration's version prefix", () => {
    // The runner keys applied migrations by filename prefix alone
    // (migrate.ts: f.split("_")[0]), so two files sharing a prefix means one is
    // silently skipped and never applied. This migration deliberately starts
    // at 011 because 010_event_reliability.sql claims 010 on the
    // feature/event-processing-reliability branch; asserting the prefix is
    // unique here is what keeps the two branches mergeable.
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const mine = "011_price_index_analytics.sql";
    const myPrefix = mine.split("_")[0];
    const colliding = files.filter(
      (f) => f !== mine && f.split("_")[0] === myPrefix
    );
    expect(colliding).toEqual([]);
  });

  it("notes the 010 collision in a comment for the reviewer", () => {
    // The version gap looks like a typo without this; with it, the reason for
    // skipping 010 is recorded where the next contributor will see it.
    expect(sql).toMatch(/010_event_reliability\.sql/);
  });
});
