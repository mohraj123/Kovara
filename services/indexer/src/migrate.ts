import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const TABLE_NAME = "schema_version";

interface MigrationRecord {
  version: string;
  name: string;
  applied_at: Date;
}

export async function runMigrations(pool: Pool): Promise<void> {
  await ensureSchemaTable(pool);

  const applied = await getAppliedMigrations(pool);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.split("_")[0];
    if (applied.has(version)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    await pool.query(sql);

    await pool.query(
      `INSERT INTO ${TABLE_NAME} (version, name) VALUES ($1, $2)`,
      [version, file]
    );

    console.log(`[migrate] Applied ${file}`);
  }
}

async function ensureSchemaTable(pool: Pool): Promise<void> {
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
    return new Set();
  }
}
