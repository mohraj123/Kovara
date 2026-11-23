#!/usr/bin/env node
/* Create a database backup with a verifiable manifest (#681).
 *
 * Usage:
 *   DATABASE_URL=postgresql://… node scripts/backup.js [--out DIR] [--format custom|plain]
 *
 * Writes two files into the output directory (default `./backups`):
 *
 *   kovara-<timestamp>.dump      the pg_dump output
 *   kovara-<timestamp>.manifest.json   the manifest (checksum + row counts)
 *
 * The manifest is what makes the backup a controlled process rather than a
 * file: `scripts/validate-backup.js` re-checks the checksum, and
 * `scripts/restore.js` compares the recorded row counts against the restored
 * database. See docs/backend/runbook.md §9.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  requireDatabaseUrl,
  databaseName,
  run,
  readTableCounts,
  writeManifest,
} = require("./backup-lib");
const { buildManifest } = require("../dist/backup/backup");

function parseArgs(argv) {
  const args = { out: "backups", format: "custom" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--format") args.format = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (args.format !== "custom" && args.format !== "plain") {
    console.error('--format must be "custom" or "plain"');
    process.exit(1);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = requireDatabaseUrl();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(args.out, `kovara-${stamp}`);
  const dumpPath = `${base}.dump`;
  const manifestPath = `${base}.manifest.json`;

  fs.mkdirSync(args.out, { recursive: true });

  // Snapshot the row counts *before* the dump so the manifest describes the
  // state the dump was taken from.
  console.log("Reading table row counts…");
  const tables = readTableCounts(databaseUrl);

  console.log(`Running pg_dump (${args.format}) → ${dumpPath}`);
  const dumpArgs = [databaseUrl, "--no-owner", "--no-privileges"];
  if (args.format === "custom") dumpArgs.push("--format=custom");
  else dumpArgs.push("--format=plain");
  const dump = run("pg_dump", dumpArgs);
  fs.writeFileSync(dumpPath, dump);

  const manifest = buildManifest({
    createdAt: new Date(),
    database: databaseName(databaseUrl),
    format: args.format,
    dump,
    tables,
  });
  writeManifest(manifestPath, manifest);

  console.log(`Backup written: ${dumpPath} (${manifest.bytes} bytes)`);
  console.log(`Manifest written: ${manifestPath}`);
  console.log(`sha256: ${manifest.sha256}`);
  console.log(`Tables recorded: ${manifest.tables.length}`);
}

main();
