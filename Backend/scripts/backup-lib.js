/* Shared helpers for the backup/restore operator scripts (#681).
 *
 * These scripts are plain Node (no TypeScript build step) so an operator can run
 * them against a production database without compiling the service first. The
 * decision logic they rely on lives in `src/backup/backup.ts` and is unit-tested;
 * this file only does the process plumbing (spawning `pg_dump`/`psql`, reading
 * and writing files).
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Tables whose row counts are recorded in a manifest and checked after restore. */
const TRACKED_TABLES = [
  "profiles",
  "posts",
  "follows",
  "tips",
  "likes",
  "pools",
  "events",
  "stream_state",
  "schema_version",
];

/** Parse DATABASE_URL, failing fast with a clear message when it is missing. */
function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (postgres:// or postgresql:// URL)");
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error("DATABASE_URL must be a postgres:// or postgresql:// URL");
    process.exit(1);
  }
  return url;
}

/** The database name from a connection URL, for the manifest. */
function databaseName(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\//, "") || "unknown";
  } catch {
    return "unknown";
  }
}

/** Run a command, returning stdout as a Buffer. Throws on non-zero exit. */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    maxBuffer: 1024 * 1024 * 512,
    stdio: options.captureStderr ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    ...options,
  });
}

/**
 * Read row counts for the tracked tables that exist.
 *
 * A table that does not exist in this deployment is skipped rather than
 * reported as zero: the manifest should describe what was actually dumped.
 */
function readTableCounts(databaseUrl) {
  const list = TRACKED_TABLES.map((t) => `'${t}'`).join(", ");
  const sql = `
    SELECT c.relname AS table_name, COALESCE(s.n_live_tup, 0) AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN (${list})
    ORDER BY c.relname;
  `;
  const out = run("psql", [databaseUrl, "-At", "-F", "\t", "-c", sql], { captureStderr: true });
  return out
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [table, rows] = line.split("\t");
      return { table, rows: Number(rows) };
    });
}

/**
 * Exact row counts, used after a restore.
 *
 * `pg_stat_user_tables.n_live_tup` is an estimate refreshed by autovacuum, so it
 * is fine for a pre-dump snapshot but not for proving a restore: the check must
 * compare exact counts. `COUNT(*)` per table is exact.
 */
function readExactTableCounts(databaseUrl, tables) {
  if (tables.length === 0) return [];
  const selects = tables
    .map((t) => `SELECT '${t.table}' AS table_name, COUNT(*)::bigint AS rows FROM "${t.table}"`)
    .join(" UNION ALL ");
  const out = run("psql", [databaseUrl, "-At", "-F", "\t", "-c", `${selects};`], {
    captureStderr: true,
  });
  return out
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [table, rows] = line.split("\t");
      return { table, rows: Number(rows) };
    });
}

/** Write a manifest beside its dump. */
function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/** Read and parse a manifest, exiting with a clear message on failure. */
function readManifest(manifestPath, parseManifest) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  try {
    return parseManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(`invalid manifest ${manifestPath}: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  TRACKED_TABLES,
  requireDatabaseUrl,
  databaseName,
  run,
  readTableCounts,
  readExactTableCounts,
  writeManifest,
  readManifest,
};
