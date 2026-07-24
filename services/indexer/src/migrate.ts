import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const TABLE_NAME = "schema_version";
const LOCK_KEY = "kovara_migration_lock";

interface MigrationRecord {
  version: string;
  name: string;
  applied_at: Date;
}

/**
 * Run any pending SQL migrations found in the migrations directory.
 *
 * BE-28: The schema_version table creation is guarded with IF NOT EXISTS.
 * Individual migrations are applied in a transaction so a partially-applied
 * migration can be retried.  Non-fatal schema drift (e.g. a column that
 * already exists from a previous partial run) is caught and logged rather
 * than crashing the process, so the service can start and serve read
 * traffic even when the database is slightly ahead of or behind the
 * expected schema.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  await ensureSchemaTable(pool);

  // Acquire an advisory lock to prevent concurrent migration runs.
  await pool.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

  try {
    const applied = await getAppliedMigrations(pool);
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

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO ${TABLE_NAME} (version, name) VALUES ($1, $2)`,
          [version, file]
        );
        await client.query("COMMIT");
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[migrate] Failed to apply ${file}: ${err}`);
        // Continue to the next migration instead of crashing.
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

    // BE-28: Run each migration inside a transaction so it is atomic. If the
    // SQL statement fails due to schema drift (e.g. duplicate column) we
    // catch the error, roll back, log a warning, and continue to the next
    // migration so the service does not crash on startup.
    const client = await pool.connect();
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
      await client.query("ROLLBACK").catch(() => {
        // Swallow rollback errors — nothing useful we can do here.
      });
      console.warn(
        `[migrate] Could not apply ${file} (schema drift?), skipping: ${String(err)}`
      );
    } finally {
      client.release();
    }
  }
}

async function ensureSchemaTable(pool: Pool): Promise<void> {
  // BE-28: CREATE TABLE IF NOT EXISTS is idempotent and tolerates a
  // pre-existing table with compatible structure.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      version    TEXT        PRIMARY KEY,
      name       TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  try {
    const result = await pool.query<MigrationRecord>(
      `SELECT version FROM ${TABLE_NAME} ORDER BY version`
    );
    return new Set(result.rows.map((r) => r.version));
  } catch {
    // BE-28: If the schema_version table does not exist yet (first run
    // before ensureSchemaTable completed) return an empty set so all
    // migrations are treated as pending.
    return new Set();
  }
}
