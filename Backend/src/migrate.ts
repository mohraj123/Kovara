import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool, PoolClient } from "pg";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const TABLE_NAME = "schema_version";
/** Advisory lock key — must be a bigint literal for pg_advisory_lock(bigint). */
const LOCK_KEY = 7_357_192_468;

/** How long to wait for another indexer before failing startup (BE-015). */
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 10_000;
/** Delay between non-blocking lock attempts. */
export const DEFAULT_MIGRATION_LOCK_POLL_MS = 100;

/**
 * Test-friendly overrides for migration timing and file access. Production
 * callers can ignore this entirely; tests supply deterministic clocks/readers.
 */
export interface MigrationRunOptions {
  lockTimeoutMs?: number;
  lockPollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  listFiles?: () => string[];
  readFile?: (file: string) => string;
}

/** Recorded version for a file: its full name without `.sql`, e.g. `007_event_processing`. */
export function migrationVersion(file: string): string {
  return file.replace(/\.sql$/, "");
}

/**
 * Whether a migration file is already applied.
 *
 * Versions used to be only the numeric prefix (`007`), which made files that
 * share a prefix indistinguishable: an interrupted run that applied
 * `007_a.sql` but not `007_b.sql` would skip `007_b.sql` forever. New records
 * use the full file stem. A bare-prefix record written by an older run still
 * counts for every file with that prefix, so databases migrated before this
 * change are not re-migrated.
 */
export function isApplied(
  file: string,
  applied: ReadonlySet<string> | ReadonlyMap<string, unknown>
): boolean {
  return applied.has(migrationVersion(file)) || applied.has(file.split("_")[0]);
}

/** Stable SHA-256 fingerprint of a migration's contents (BE-016). */
export function migrationChecksum(contents: string): string {
  return createHash("sha256").update(contents, "utf-8").digest("hex");
}

/**
 * Fail startup when a migration file was edited after it was applied.
 *
 * Records written before checksums were introduced have a `null` checksum and
 * are skipped: there is no trustworthy baseline to compare against. Every
 * newly applied migration stores one, so subsequent edits are caught.
 */
export function assertNoChecksumDrift(
  files: readonly string[],
  applied: ReadonlyMap<string, string | null>,
  readFile: (file: string) => string = (file) => readFileSync(join(MIGRATIONS_DIR, file), "utf-8")
): void {
  for (const file of files) {
    const version = migrationVersion(file);
    const expected = applied.get(version) ?? null;
    if (expected === null) continue;

    const actual = migrationChecksum(readFile(file));
    if (expected !== actual) {
      throw new Error(
        `Migration checksum drift detected for ${file} (version ${version}): ` +
          `expected ${expected}, got ${actual}`
      );
    }
  }
}

/** Read a positive millisecond setting, falling back when unset. */
function migrationTiming(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error(`${name} must be a positive whole number of milliseconds, but was "${raw}"`);
  }
  return Number(raw);
}

interface AcquireOptions {
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Acquire the advisory lock without blocking forever. `pg_advisory_lock`
 * waits indefinitely, so a crashed indexer that failed to unlock would hang
 * every future startup. Polling `pg_try_advisory_lock` lets us fail with the
 * lock key and timeout after a bounded wait.
 */
async function acquireMigrationLock(client: PoolClient, opts: AcquireOptions): Promise<void> {
  const deadline = opts.now() + opts.timeoutMs;

  for (;;) {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [LOCK_KEY]
    );
    if (result.rows[0]?.acquired === true) return;

    if (opts.now() >= deadline) {
      throw new Error(
        `Timed out after ${opts.timeoutMs}ms waiting for migration advisory lock ${LOCK_KEY}`
      );
    }
    await opts.sleep(opts.pollMs);
  }
}

interface MigrationRecord {
  version: string;
  name: string;
  applied_at: Date;
  /** NULL for records written before checksum tracking was added. */
  checksum: string | null;
}

/**
 * Run pending migrations serialised by a database-level advisory lock.
 *
 * A single client is checked out for the entire lock → migrate → unlock
 * lifetime so the lock is guaranteed to be released even on error. The wait
 * for the lock is bounded so a stale lock cannot hang startup forever.
 */
export async function runMigrations(pool: Pool, options: MigrationRunOptions = {}): Promise<void> {
  const timeoutMs = options.lockTimeoutMs ?? migrationTiming("MIGRATION_LOCK_TIMEOUT_MS", DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
  const pollMs = options.lockPollMs ?? migrationTiming("MIGRATION_LOCK_POLL_MS", DEFAULT_MIGRATION_LOCK_POLL_MS);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readMigration = options.readFile ?? ((file: string) => readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  const listFiles =
    options.listFiles ??
    (() => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort());

  const client = await pool.connect();
  try {
    await ensureSchemaTable(client);

    await acquireMigrationLock(client, { timeoutMs, pollMs, now, sleep });

    try {
      const applied = await getAppliedMigrations(client);
      const files = listFiles();

      assertNoChecksumDrift(files, applied, readMigration);

      const pending = files.filter((f) => !isApplied(f, applied));
      if (pending.length === 0) {
        return;
      }

      for (const file of pending) {
        const version = migrationVersion(file);
        const sql = readMigration(file);

        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(
            `INSERT INTO ${TABLE_NAME} (version, name, checksum) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
            [version, file, migrationChecksum(sql)]
          );
          await client.query("COMMIT");
          console.log(`[migrate] Applied ${file}`);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          console.warn(
            `[migrate] Could not apply ${file} (schema drift?), skipping: ${String(err)}`
          );
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function ensureSchemaTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      version    TEXT        PRIMARY KEY,
      name       TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum   TEXT
    )
  `);
  // Databases migrated before checksum tracking existed need the new column.
  await client.query(`ALTER TABLE ${TABLE_NAME} ADD COLUMN IF NOT EXISTS checksum TEXT`);
}

async function getAppliedMigrations(client: PoolClient): Promise<Map<string, string | null>> {
  // Deliberately not caught: treating a failed read as "nothing applied" would
  // re-run every migration against a database that already has them.
  const result = await client.query<MigrationRecord>(
    `SELECT version, checksum FROM ${TABLE_NAME} ORDER BY version`
  );
  return new Map(result.rows.map((r) => [r.version, r.checksum ?? null]));
}
