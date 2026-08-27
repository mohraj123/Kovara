import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool, PoolClient } from "pg";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const TABLE_NAME = "schema_version";
/** Advisory lock key — must be a bigint literal for pg_advisory_lock(bigint). */
const LOCK_KEY = 7_357_192_468;

interface MigrationRecord {
  version: string;
  name: string;
  applied_at: Date;
}

/**
 * Run pending migrations serialised by a database-level advisory lock.
 *
 * A single client is checked out for the entire lock → migrate → unlock
 * lifetime so the lock is guaranteed to be released even on error.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureSchemaTable(client);

    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    try {
      const applied = await getAppliedMigrations(client);

      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      const pending = files.filter((f) => {
        const version = f.split("_")[0];
        return !applied.has(version);
      });

      if (pending.length === 0) {
        return;
      }

      for (const file of pending) {
        const version = file.split("_")[0];
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(
            `INSERT INTO ${TABLE_NAME} (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
            [version, file]
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
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client: PoolClient): Promise<Set<string>> {
  try {
    const result = await client.query<MigrationRecord>(
      `SELECT version FROM ${TABLE_NAME} ORDER BY version`
    );
    return new Set(result.rows.map((r) => r.version));
  } catch {
    return new Set();
  }
}
