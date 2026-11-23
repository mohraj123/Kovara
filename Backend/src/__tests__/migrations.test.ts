/**
 * Static checks for the follow/tip/like performance-index migrations
 * (BA-018 #453, BA-019 #454, BA-020 #455).
 *
 * The repo's DB layer is mocked in every other test (no real database is
 * required — see the comment at the top of src/db.ts), so these tests read
 * the migration SQL files directly and assert on their contents rather than
 * applying them against a live PostgreSQL instance.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";
import {
  assertNoChecksumDrift,
  migrationChecksum,
  runMigrations,
} from "../migrate";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
}

describe("007_follows_pagination_index.sql (BA-018 #453)", () => {
  const sql = readMigration("007_follows_pagination_index.sql");

  it("adds a composite index covering the followers-list pagination direction", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_follows_followee_follower\s+ON follows\s*\(\s*followee\s*,\s*follower\s*\)/i
    );
  });

  it("uses IF NOT EXISTS, matching the repo's existing migration convention", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/i);
  });
});

describe("008_tips_activity_indexes.sql (BA-019 #454)", () => {
  const sql = readMigration("008_tips_activity_indexes.sql");

  it("indexes tips by post_id", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_tips_post_id\s+ON tips\s*\(\s*post_id\s*\)/i);
  });

  it("indexes tips by tipper", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_tips_tipper\s+ON tips\s*\(\s*tipper\s*\)/i);
  });

  it("does not use invalid MySQL-style inline INDEX table items", () => {
    // The bug this migration works around: `CREATE TABLE ... (INDEX name (col))`
    // is not valid PostgreSQL syntax. Every index here must be a standalone
    // CREATE INDEX statement.
    expect(sql).not.toMatch(/^\s*INDEX\s+\w+\s*\(/im);
  });
});

describe("009_likes_membership_indexes.sql (BA-020 #455)", () => {
  const sql = readMigration("009_likes_membership_indexes.sql");

  it("indexes likes by post_id", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_likes_post_id\s+ON likes\s*\(\s*post_id\s*\)/i);
  });

  it("indexes likes by user_address", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_likes_user\s+ON likes\s*\(\s*user_address\s*\)/i);
  });

  it("does not use invalid MySQL-style inline INDEX table items", () => {
    expect(sql).not.toMatch(/^\s*INDEX\s+\w+\s*\(/im);
  });

  it("does not touch the duplicate-like protection defined in 004_tips_likes.sql", () => {
    // This migration must only add indexes; the UNIQUE (post_id, user_address)
    // constraint that prevents duplicate likes lives in 004_tips_likes.sql and
    // must not be redefined or dropped here. Strip comments before asserting
    // so mentioning "UNIQUE" in prose above doesn't trip the check.
    const sqlWithoutComments = sql.replace(/--.*$/gm, "");
    expect(sqlWithoutComments).not.toMatch(/UNIQUE/i);
    expect(sqlWithoutComments).not.toMatch(/DROP\s+CONSTRAINT/i);

    const originalTableMigration = readMigration("004_tips_likes.sql");
    expect(originalTableMigration).toMatch(/UNIQUE\s*\(\s*post_id\s*,\s*user_address\s*\)/i);
  });
});

describe("bounded migration lock acquisition (#1036)", () => {
  function setup(acquireAfterAttempt: number) {
    const queries: Array<[string, unknown[] | undefined]> = [];
    let attempts = 0;
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push([sql, params]);
        if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE")) return { rows: [] };
        if (sql.includes("pg_try_advisory_lock")) {
          attempts += 1;
          return { rows: [{ acquired: attempts >= acquireAfterAttempt }] };
        }
        if (sql.includes("SELECT version, checksum")) return { rows: [] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [] };
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) };
    return { client, pool, queries, attemptCount: () => attempts };
  }

  it("fails with a clear timeout instead of waiting forever", async () => {
    const { pool, client, queries, attemptCount } = setup(Number.POSITIVE_INFINITY);
    let nowMs = 1_000;

    await expect(
      runMigrations(pool as unknown as Pool, {
        lockTimeoutMs: 300,
        lockPollMs: 100,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
        listFiles: () => [],
        readFile: () => "",
      })
    ).rejects.toThrow(/Timed out after 300ms waiting for migration advisory lock/);

    expect(attemptCount()).toBe(4);
    expect(queries.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("migrates after the lock is released and always unlocks", async () => {
    const { pool, client, queries } = setup(3);
    let nowMs = 1_000;
    const sql = "SELECT 1;";

    await runMigrations(pool as unknown as Pool, {
      lockTimeoutMs: 1_000,
      lockPollMs: 100,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      listFiles: () => ["010_test.sql"],
      readFile: () => sql,
    });

    const insert = queries.find(([query]) => query.includes("INSERT INTO schema_version"));
    expect(insert?.[1]).toEqual(["010_test", "010_test.sql", migrationChecksum(sql)]);
    expect(queries.some(([query]) => query.includes("pg_advisory_unlock"))).toBe(true);
    expect(
      queries.some(([query]) => query.includes("pg_advisory_lock(") && !query.includes("try"))
    ).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("migration checksum drift detection (#1037)", () => {
  it("matches unchanged files and skips legacy records without a checksum", () => {
    const sql = "SELECT 1;";
    const checksum = migrationChecksum(sql);

    expect(() =>
      assertNoChecksumDrift(["010_test.sql"], new Map([["010_test", checksum]]), () => sql)
    ).not.toThrow();
    expect(() =>
      assertNoChecksumDrift(["010_test.sql"], new Map([["010_test", null]]), () => "anything")
    ).not.toThrow();
  });

  it("rejects a migration file modified after it was applied", () => {
    const expected = migrationChecksum("original SQL");

    expect(() =>
      assertNoChecksumDrift(
        ["010_test.sql"],
        new Map([["010_test", expected]]),
        () => "modified SQL"
      )
    ).toThrow(/checksum drift.*010_test\.sql.*expected.*got/);
  });
});
