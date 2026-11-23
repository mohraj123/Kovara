#!/usr/bin/env node
/* Restore a database backup and validate the result (#681).
 *
 * Usage:
 *   DATABASE_URL=postgresql://… node scripts/restore.js <dump> <manifest.json> [--yes]
 *
 * The process is deliberately gated:
 *
 *   1. The dump is verified against its manifest *before* anything is touched.
 *      Restoring a corrupt dump over a live database is worse than not
 *      restoring at all.
 *   2. The target database is named and the operator must confirm (or pass
 *      `--yes` for automation).
 *   3. `pg_restore`/`psql` runs with `--clean --if-exists` so the restore is
 *      idempotent and re-runnable.
 *   4. Row counts are read back and compared to the manifest. A mismatch is a
 *      non-zero exit: the restore is not "done" until the data is proven back.
 *
 * See docs/backend/runbook.md §9 for the operator procedure.
 */
const fs = require("node:fs");
const readline = require("node:readline");
const {
  requireDatabaseUrl,
  databaseName,
  run,
  readExactTableCounts,
  readManifest,
} = require("./backup-lib");
const { verifyManifest, validateRestore, parseManifest } = require("../dist/backup/backup");

function parseArgs(argv) {
  const args = { yes: false, positional: [] };
  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") args.yes = true;
    else args.positional.push(arg);
  }
  return args;
}

async function confirm(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(prompt, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [dumpPath, manifestPath] = args.positional;
  if (!dumpPath || !manifestPath) {
    console.error("usage: node scripts/restore.js <dump> <manifest.json> [--yes]");
    process.exit(1);
  }

  const databaseUrl = requireDatabaseUrl();

  if (!fs.existsSync(dumpPath)) {
    console.error(`dump not found: ${dumpPath}`);
    process.exit(1);
  }

  const manifest = readManifest(manifestPath, parseManifest);
  const dump = fs.readFileSync(dumpPath);

  // Step 1: never restore an unverified dump.
  const verification = verifyManifest(manifest, dump);
  if (!verification.ok) {
    console.error("Refusing to restore: the dump does not match its manifest.");
    for (const failure of verification.failures) {
      console.error(`  [${failure.check}] ${failure.detail}`);
    }
    process.exit(1);
  }
  console.log(`Verified ${dumpPath} against ${manifestPath}`);

  // Step 2: confirm the target.
  const target = databaseName(databaseUrl);
  if (!args.yes) {
    const ok = await confirm(
      `Restore backup of "${manifest.database}" into database "${target}"? This overwrites existing data. [y/N] `
    );
    if (!ok) {
      console.error("Aborted.");
      process.exit(1);
    }
  }

  // Step 3: restore.
  console.log(`Restoring into "${target}"…`);
  if (manifest.format === "custom") {
    run("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      databaseUrl,
      dumpPath,
    ]);
  } else {
    run("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", dumpPath]);
  }

  // Step 4: prove the data came back.
  console.log("Validating restored row counts…");
  const restored = readExactTableCounts(databaseUrl, manifest.tables);
  const validation = validateRestore(manifest, restored);

  if (!validation.ok) {
    console.error("Restore validation FAILED:");
    for (const failure of validation.failures) {
      console.error(`  [${failure.check}] ${failure.detail}`);
    }
    process.exit(1);
  }

  console.log(`Restore validated: ${manifest.tables.length} tables match the backup.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
