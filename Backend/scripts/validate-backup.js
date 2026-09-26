#!/usr/bin/env node
/* Validate a backup file against its manifest (#681).
 *
 * Usage:
 *   node scripts/validate-backup.js <dump> <manifest.json>
 *
 * Exits 0 when the dump matches its manifest (size + SHA-256), 1 otherwise.
 * This is the check to run before trusting a backup — and the one to run on a
 * schedule against the most recent backup, so a corrupt dump is discovered
 * before the day it is needed.
 */
const fs = require("node:fs");
const { readManifest } = require("./backup-lib");
const { verifyManifest, parseManifest } = require("../dist/backup/backup");

function main() {
  const [dumpPath, manifestPath] = process.argv.slice(2);
  if (!dumpPath || !manifestPath) {
    console.error("usage: node scripts/validate-backup.js <dump> <manifest.json>");
    process.exit(1);
  }

  if (!fs.existsSync(dumpPath)) {
    console.error(`dump not found: ${dumpPath}`);
    process.exit(1);
  }

  const manifest = readManifest(manifestPath, parseManifest);
  const dump = fs.readFileSync(dumpPath);
  const result = verifyManifest(manifest, dump);

  if (result.ok) {
    console.log(`OK: ${dumpPath} matches ${manifestPath}`);
    console.log(`  database: ${manifest.database}`);
    console.log(`  created:  ${manifest.createdAt}`);
    console.log(`  bytes:    ${manifest.bytes}`);
    console.log(`  sha256:   ${manifest.sha256}`);
    console.log(`  tables:   ${manifest.tables.length}`);
    return;
  }

  console.error(`FAILED: ${dumpPath} does not match ${manifestPath}`);
  for (const failure of result.failures) {
    console.error(`  [${failure.check}] ${failure.detail}`);
  }
  process.exit(1);
}

main();
