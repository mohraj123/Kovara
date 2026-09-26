/**
 * Database backup and restore validation (#681).
 *
 * The runbook has always said "back it up with `pg_dump`" and stopped there.
 * That is a procedure, not a controlled process: nothing records what was
 * dumped, nothing proves the dump is complete, and nothing checks the database
 * after a restore. A backup you have never restored is a hope, not a backup.
 *
 * This module is the pure, testable core of the process. It does not shell out
 * to `pg_dump`/`pg_restore` itself — the operator scripts in `Backend/scripts/`
 * do that — so the parts that decide *whether a backup is trustworthy* can be
 * unit-tested without a live PostgreSQL instance (the repo's DB layer is mocked
 * everywhere; see the comment at the top of `src/db.ts`).
 *
 * Three pieces:
 *
 *   1. {@link buildManifest} — the durable record of a backup: when it was
 *      taken, from which database, which tables it claims to contain, and the
 *      SHA-256 of the dump file. Without the checksum a truncated or corrupted
 *      dump is indistinguishable from a good one.
 *   2. {@link verifyManifest} — recompute the checksum and compare it to the
 *      manifest. This is the "is this file the backup it says it is" check.
 *   3. {@link validateRestore} — compare the row counts recorded at backup time
 *      against the counts read back after a restore. This is the "did the
 *      restore actually put the data back" check, and it is the one that
 *      catches a restore that silently dropped a table.
 *
 * The manifest is JSON so it can be stored beside the dump, committed to an
 * artifact store, or diffed between two backups.
 */

import { createHash } from "crypto";

/** Bump when the manifest shape changes incompatibly. */
export const MANIFEST_VERSION = 1;

/** One table's row count, as recorded at backup time and re-read after restore. */
export interface TableCount {
  table: string;
  rows: number;
}

/** The durable record written beside every dump. */
export interface BackupManifest {
  manifestVersion: number;
  /** ISO-8601 timestamp of when the dump was taken. */
  createdAt: string;
  /** Database the dump was taken from (name only — never the full URL). */
  database: string;
  /** `pg_dump` format used: `custom` (default) or `plain`. */
  format: "custom" | "plain";
  /** SHA-256 of the dump file, hex-encoded. */
  sha256: string;
  /** Size of the dump file in bytes. */
  bytes: number;
  /** Row counts per table, captured before the dump. */
  tables: TableCount[];
}

/** A single failed check, with enough context to act on it. */
export interface ValidationFailure {
  check: string;
  detail: string;
}

/** The outcome of a validation step. */
export interface ValidationResult {
  ok: boolean;
  failures: ValidationFailure[];
}

/** SHA-256 of a buffer, hex-encoded. */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Build a manifest for a completed dump.
 *
 * `tables` is sorted by name so two backups of the same database produce
 * byte-identical manifests and a diff between them is meaningful — the same
 * determinism argument the reconciliation report makes.
 */
export function buildManifest(input: {
  createdAt: Date;
  database: string;
  format: "custom" | "plain";
  dump: Buffer;
  tables: TableCount[];
}): BackupManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    createdAt: input.createdAt.toISOString(),
    database: input.database,
    format: input.format,
    sha256: sha256(input.dump),
    bytes: input.dump.length,
    tables: [...input.tables].sort((a, b) => a.table.localeCompare(b.table)),
  };
}

/**
 * Verify a dump file against its manifest.
 *
 * Checks the manifest is a shape we understand, that the file is the size the
 * manifest claims, and that its checksum matches. Size is checked separately
 * from the checksum so a truncated file reports "truncated" rather than the
 * less actionable "checksum mismatch".
 */
export function verifyManifest(manifest: BackupManifest, dump: Buffer): ValidationResult {
  const failures: ValidationFailure[] = [];

  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    failures.push({
      check: "manifest_version",
      detail: `manifest version ${manifest.manifestVersion} is not supported (expected ${MANIFEST_VERSION})`,
    });
  }

  if (dump.length !== manifest.bytes) {
    failures.push({
      check: "size",
      detail: `dump is ${dump.length} bytes but the manifest records ${manifest.bytes} (truncated or wrong file)`,
    });
  }

  const actual = sha256(dump);
  if (actual !== manifest.sha256) {
    failures.push({
      check: "checksum",
      detail: `dump sha256 ${actual} does not match manifest ${manifest.sha256}`,
    });
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Compare the counts recorded at backup time against the counts read back after
 * a restore.
 *
 * Every table in the manifest must be present after the restore with the same
 * count. A table that is missing entirely is reported as `missing_table` rather
 * than a count of zero, because "the restore dropped this table" and "the table
 * was empty" are different problems. Extra tables in the restored database are
 * ignored: a restore into a database that already had migrations applied will
 * legitimately have more tables than the dump contained.
 */
export function validateRestore(
  manifest: BackupManifest,
  restored: TableCount[]
): ValidationResult {
  const failures: ValidationFailure[] = [];
  const restoredByTable = new Map(restored.map((t) => [t.table, t.rows]));

  for (const expected of manifest.tables) {
    if (!restoredByTable.has(expected.table)) {
      failures.push({
        check: "missing_table",
        detail: `table "${expected.table}" is absent after restore (expected ${expected.rows} rows)`,
      });
      continue;
    }

    const actual = restoredByTable.get(expected.table)!;
    if (actual !== expected.rows) {
      failures.push({
        check: "row_count",
        detail: `table "${expected.table}" has ${actual} rows after restore but the backup recorded ${expected.rows}`,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Parse a manifest from JSON, rejecting anything that is not a manifest we can
 * act on. A malformed manifest must fail loudly: silently treating it as empty
 * would make every restore "valid".
 */
export function parseManifest(json: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("manifest must be a JSON object");
  }

  const m = parsed as Record<string, unknown>;
  const required = ["manifestVersion", "createdAt", "database", "format", "sha256", "bytes", "tables"];
  for (const key of required) {
    if (!(key in m)) throw new Error(`manifest is missing required field "${key}"`);
  }

  if (m.format !== "custom" && m.format !== "plain") {
    throw new Error(`manifest format must be "custom" or "plain", got ${JSON.stringify(m.format)}`);
  }
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) {
    throw new Error("manifest sha256 must be a 64-character hex string");
  }
  if (typeof m.bytes !== "number" || !Number.isInteger(m.bytes) || m.bytes < 0) {
    throw new Error("manifest bytes must be a non-negative integer");
  }
  if (!Array.isArray(m.tables)) {
    throw new Error("manifest tables must be an array");
  }

  const tables: TableCount[] = m.tables.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`manifest tables[${i}] must be an object`);
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.table !== "string" || t.table.length === 0) {
      throw new Error(`manifest tables[${i}].table must be a non-empty string`);
    }
    if (typeof t.rows !== "number" || !Number.isInteger(t.rows) || t.rows < 0) {
      throw new Error(`manifest tables[${i}].rows must be a non-negative integer`);
    }
    return { table: t.table, rows: t.rows };
  });

  return {
    manifestVersion: Number(m.manifestVersion),
    createdAt: String(m.createdAt),
    database: String(m.database),
    format: m.format,
    sha256: m.sha256,
    bytes: m.bytes,
    tables,
  };
}
