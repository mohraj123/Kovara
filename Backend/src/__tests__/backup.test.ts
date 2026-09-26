/**
 * Backup/restore validation (#681).
 *
 * The scripts in `Backend/scripts/` shell out to `pg_dump`/`pg_restore`, which
 * no test environment has. The decisions that make a backup trustworthy —
 * checksum verification and post-restore row-count comparison — live in
 * `src/backup/backup.ts` and are tested here directly, matching the repo's
 * convention of mocking the database layer rather than requiring a live
 * PostgreSQL instance.
 */

import {
  BackupManifest,
  MANIFEST_VERSION,
  buildManifest,
  parseManifest,
  sha256,
  validateRestore,
  verifyManifest,
} from "../backup/backup";

const DUMP = Buffer.from("-- fake pg_dump output\nCREATE TABLE posts (id bigint);\n");

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    createdAt: "2026-01-01T00:00:00.000Z",
    database: "Kovara",
    format: "custom",
    sha256: sha256(DUMP),
    bytes: DUMP.length,
    tables: [
      { table: "posts", rows: 3 },
      { table: "profiles", rows: 2 },
    ],
    ...overrides,
  };
}

describe("buildManifest", () => {
  it("records the checksum, size and database of the dump", () => {
    const built = buildManifest({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      database: "Kovara",
      format: "custom",
      dump: DUMP,
      tables: [{ table: "posts", rows: 3 }],
    });

    expect(built.sha256).toBe(sha256(DUMP));
    expect(built.bytes).toBe(DUMP.length);
    expect(built.database).toBe("Kovara");
    expect(built.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(built.manifestVersion).toBe(MANIFEST_VERSION);
  });

  it("sorts tables by name so two backups of the same data are byte-identical", () => {
    const built = buildManifest({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      database: "Kovara",
      format: "custom",
      dump: DUMP,
      tables: [
        { table: "tips", rows: 1 },
        { table: "posts", rows: 3 },
        { table: "likes", rows: 2 },
      ],
    });

    expect(built.tables.map((t) => t.table)).toEqual(["likes", "posts", "tips"]);
  });
});

describe("verifyManifest", () => {
  it("accepts a dump that matches its manifest", () => {
    expect(verifyManifest(manifest(), DUMP)).toEqual({ ok: true, failures: [] });
  });

  it("rejects a dump whose contents changed", () => {
    const tampered = Buffer.from(DUMP.toString("utf8").replace("posts", "posts_evil"));
    const result = verifyManifest(manifest(), tampered);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.check)).toContain("checksum");
  });

  it("reports a truncated dump as a size failure, not just a checksum failure", () => {
    const truncated = DUMP.subarray(0, 5);
    const result = verifyManifest(manifest(), truncated);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.check)).toContain("size");
  });

  it("rejects a manifest written by an unsupported version", () => {
    const result = verifyManifest(manifest({ manifestVersion: 999 }), DUMP);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.check)).toContain("manifest_version");
  });
});

describe("validateRestore", () => {
  it("passes when every recorded table is present with the same count", () => {
    const result = validateRestore(manifest(), [
      { table: "posts", rows: 3 },
      { table: "profiles", rows: 2 },
    ]);

    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("fails when a table is missing after the restore", () => {
    const result = validateRestore(manifest(), [{ table: "posts", rows: 3 }]);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({ check: "missing_table" }),
    ]);
    expect(result.failures[0].detail).toContain("profiles");
  });

  it("fails when a table's row count differs after the restore", () => {
    const result = validateRestore(manifest(), [
      { table: "posts", rows: 2 },
      { table: "profiles", rows: 2 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({ check: "row_count" }),
    ]);
    expect(result.failures[0].detail).toContain("posts");
  });

  it("ignores extra tables the restored database has beyond the backup", () => {
    const result = validateRestore(manifest(), [
      { table: "posts", rows: 3 },
      { table: "profiles", rows: 2 },
      { table: "reconciliation_runs", rows: 10 },
    ]);

    expect(result.ok).toBe(true);
  });
});

describe("parseManifest", () => {
  it("round-trips a manifest through JSON", () => {
    const original = manifest();
    expect(parseManifest(JSON.stringify(original))).toEqual(original);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseManifest("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a manifest missing required fields", () => {
    expect(() => parseManifest(JSON.stringify({ manifestVersion: 1 }))).toThrow(
      /missing required field "createdAt"/
    );
  });

  it("rejects a malformed checksum", () => {
    expect(() => parseManifest(JSON.stringify(manifest({ sha256: "nope" })))).toThrow(
      /sha256/
    );
  });

  it("rejects an unknown format", () => {
    expect(() =>
      parseManifest(JSON.stringify({ ...manifest(), format: "tar" }))
    ).toThrow(/format/);
  });

  it("rejects a table entry with a non-integer row count", () => {
    expect(() =>
      parseManifest(JSON.stringify({ ...manifest(), tables: [{ table: "posts", rows: 1.5 }] }))
    ).toThrow(/rows/);
  });
});
