/**
 * Kovara Indexer — startup configuration.
 *
 * Every value the indexer needs before it can do useful work is parsed and
 * validated here, in one place, with no side effects. The indexer previously
 * substituted defaults for values it cannot actually run without — a
 * `sqlite::memory:` connection string for a PostgreSQL-only implementation, a
 * `PLACEHOLDER_CONTRACT_ID` that matches no contract, and a `parseInt` result
 * that could be `NaN`. Each of those let the process reach a "ready" state
 * while being permanently unable to index anything.
 *
 * The rule this module enforces: configuration that has no safe default is
 * required, and a value that is present but unusable is an error rather than a
 * silent fallback. Failures are collected and reported together so an operator
 * fixing a `.env` file sees every problem in one pass.
 */

/** Raised when one or more environment variables are missing or unusable. */
export class ConfigError extends Error {
  /** Every individual problem found, in declaration order. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const detail = problems.map((p) => `  - ${p}`).join("\n");
    super(`Invalid indexer configuration:\n${detail}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** PostgreSQL pool tuning — all values are in the validated startup config. */
export interface DatabasePoolConfig {
  /** Maximum number of clients in the pool (`max`). */
  max: number;
  /** How long to wait for a connection before timing out (`connectionTimeoutMillis`). */
  connectionTimeoutMillis: number;
  /** How long a client may sit idle before being closed (`idleTimeoutMillis`). */
  idleTimeoutMillis: number;
  /** Per-query statement timeout (`statement_timeout`). */
  statementTimeoutMillis: number;
}

/** The validated configuration the indexer starts from. */
export interface IndexerConfig {
  databaseUrl: string;
  stellarRpcUrl: string;
  contractId: string;
  startLedger: number;
  dbPool: DatabasePoolConfig;
}

/** A `process.env`-shaped source of raw values. */
export type EnvSource = Record<string, string | undefined>;

// ── DATABASE_URL ─────────────────────────────────────────────────────────────

/**
 * PostgreSQL URI schemes accepted by `pg`. Anything else (notably `sqlite:`)
 * describes a database this indexer cannot talk to.
 */
const POSTGRES_SCHEMES = ["postgres:", "postgresql:"];

/**
 * Validate `DATABASE_URL` as a PostgreSQL connection string.
 *
 * There is no meaningful default: the implementation issues PostgreSQL-specific
 * SQL (`TEXT[]` columns, `TSVECTOR`/GIN search indexes, `ON CONFLICT`), so a
 * missing value must stop startup rather than fall back to an in-memory SQLite
 * URL the driver would never reach anyway.
 */
export function parseDatabaseUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") {
    throw new ConfigError([
      "DATABASE_URL is required — the indexer stores events in PostgreSQL and has no " +
        "usable default (example: postgresql://user:password@localhost:5432/kovara)",
    ]);
  }

  let scheme: string;
  try {
    scheme = new URL(value).protocol.toLowerCase();
  } catch {
    throw new ConfigError([
      `DATABASE_URL is not a valid connection URL: "${redactUrl(value)}" ` +
        "(expected postgresql://user:password@host:port/database)",
    ]);
  }

  if (!POSTGRES_SCHEMES.includes(scheme)) {
    throw new ConfigError([
      `DATABASE_URL must be a PostgreSQL connection string, but its scheme is "${scheme}". ` +
        "The indexer only supports PostgreSQL (postgres:// or postgresql://).",
    ]);
  }

  return value;
}

/**
 * Strip credentials from a connection URL before it appears in an error
 * message, so a malformed value cannot leak a password into the logs.
 */
function redactUrl(value: string): string {
  const at = value.lastIndexOf("@");
  if (at === -1) return value;
  const schemeEnd = value.indexOf("//");
  const prefix = schemeEnd === -1 ? "" : value.slice(0, schemeEnd + 2);
  return `${prefix}***${value.slice(at)}`;
}

// ── CONTRACT_ID ──────────────────────────────────────────────────────────────

/** RFC 4648 base32 alphabet used by Stellar strkey encoding. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Strkey version byte for a contract address, i.e. `2 << 3`. Encodes as "C". */
const STRKEY_VERSION_CONTRACT = 2 << 3;

/** 1 version byte + a 32-byte contract hash + a 2-byte checksum. */
const STRKEY_CONTRACT_BYTES = 35;

/** 35 bytes of payload encode to exactly 56 unpadded base32 characters. */
const STRKEY_CONTRACT_CHARS = 56;

/** Decode unpadded base32, or return null if the input is not base32. */
function base32Decode(input: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((input.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;

  for (let i = 0; i < input.length; i++) {
    const symbol = BASE32_ALPHABET.indexOf(input[i]);
    if (symbol === -1) return null;
    value = (value << 5) | symbol;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }

  return out;
}

/** CRC16-XModem (polynomial 0x1021, zero seed), the strkey checksum. */
function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Whether `value` is a well-formed Stellar contract address (a `C…` strkey):
 * 56 base32 characters carrying the contract version byte, a 32-byte hash and a
 * valid CRC16 checksum. The checksum is what makes this stronger than a shape
 * check — it rejects typos and placeholder-looking values that happen to have
 * the right length and alphabet.
 */
export function isValidContractId(value: string): boolean {
  if (value.length !== STRKEY_CONTRACT_CHARS) return false;

  const decoded = base32Decode(value);
  if (decoded === null || decoded.length !== STRKEY_CONTRACT_BYTES) return false;
  if (decoded[0] !== STRKEY_VERSION_CONTRACT) return false;

  const expected = crc16Xmodem(decoded.subarray(0, STRKEY_CONTRACT_BYTES - 2));
  const actual = decoded[33] | (decoded[34] << 8); // checksum is little-endian
  return expected === actual;
}

/**
 * Validate `CONTRACT_ID`. The indexer streams events for exactly one contract,
 * so an absent or malformed address makes every subsequent RPC call useless;
 * both cases fail here rather than after the process reports itself ready.
 */
export function parseContractId(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") {
    throw new ConfigError([
      "CONTRACT_ID is required — set it to the deployed Kovara contract address " +
        "(a 56-character Stellar address beginning with C)",
    ]);
  }

  if (!isValidContractId(value)) {
    throw new ConfigError([
      `CONTRACT_ID is not a valid Stellar contract address: "${value}". ` +
        "Expected a 56-character strkey beginning with C (for example " +
        "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75).",
    ]);
  }

  return value;
}

// ── START_LEDGER ─────────────────────────────────────────────────────────────

/** Ledger sequence used when `START_LEDGER` is not set: stream from genesis. */
export const DEFAULT_START_LEDGER = 0;

/**
 * Parse `START_LEDGER` as a ledger sequence number.
 *
 * `parseInt` is deliberately not used on its own: it yields `NaN` for "abc" and
 * silently truncates "12abc" to 12, and the stream configuration accepts both
 * without complaint. Only a finite, non-negative, safe integer is allowed; an
 * unset value falls back to {@link DEFAULT_START_LEDGER}, which is a genuine
 * default rather than a stand-in for a missing value.
 */
export function parseStartLedger(
  raw: string | undefined,
  name = "START_LEDGER"
): number {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_START_LEDGER;

  if (!/^\d+$/.test(value)) {
    throw new ConfigError([
      `${name} must be a non-negative integer ledger sequence, but was "${raw}"`,
    ]);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ConfigError([
      `${name} is outside the supported range of ledger sequences: "${raw}"`,
    ]);
  }

  return parsed;
}

// ── STELLAR_RPC_URL ──────────────────────────────────────────────────────────

/** Public Soroban RPC used when `STELLAR_RPC_URL` is not set. */
export const DEFAULT_STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";

/** Validate `STELLAR_RPC_URL` as an http(s) endpoint, defaulting to testnet. */
export function parseStellarRpcUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_STELLAR_RPC_URL;

  let scheme: string;
  try {
    scheme = new URL(value).protocol.toLowerCase();
  } catch {
    throw new ConfigError([`STELLAR_RPC_URL is not a valid URL: "${value}"`]);
  }

  if (scheme !== "http:" && scheme !== "https:") {
    throw new ConfigError([
      `STELLAR_RPC_URL must be an http or https endpoint, but was "${value}"`,
    ]);
  }

  return value;
}

// ── Database pool ────────────────────────────────────────────────────────────

/** Default maximum pool size (pg default: 10). */
export const DEFAULT_DB_POOL_MAX = 10;

/** Default connection timeout in ms (pg default: 0 = no timeout; we use 5s to fail fast). */
export const DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS = 5_000;

/** Default idle timeout in ms before a client is closed (pg default: 10_000; we use 30s). */
export const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 30_000;

/** Default per-query statement timeout in ms. */
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Parse a positive integer env var with a default and range validation.
 * Empty/undefined → default. Non-integer, out-of-range, or NaN → ConfigError.
 */
function parsePositiveIntEnv(
  raw: string | undefined,
  name: string,
  defaultValue: number,
  opts: { min?: number; max?: number } = {}
): number {
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return defaultValue;
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError([`${name} must be a non-negative integer (milliseconds or count), but was "${raw}"`]);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError([`${name} must be an integer between ${min} and ${max}, but was "${raw}"`]);
  }
  return parsed;
}

export function parseDbPoolMax(raw: string | undefined): number {
  return parsePositiveIntEnv(raw, "DB_POOL_MAX", DEFAULT_DB_POOL_MAX, { min: 1, max: 100 });
}

export function parseDbPoolConnectionTimeoutMs(raw: string | undefined): number {
  // Allow 0 to mean "no timeout" (pg semantics) but default to 5s.
  const v = raw?.trim() ?? "";
  if (v === "") return DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS;
  if (!/^\d+$/.test(v)) {
    throw new ConfigError([`DB_POOL_CONNECTION_TIMEOUT_MS must be a non-negative integer (milliseconds), but was "${raw}"`]);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0 || n > 600_000) {
    throw new ConfigError([`DB_POOL_CONNECTION_TIMEOUT_MS must be between 0 and 600000, but was "${raw}"`]);
  }
  return n;
}

export function parseDbPoolIdleTimeoutMs(raw: string | undefined): number {
  const v = raw?.trim() ?? "";
  if (v === "") return DEFAULT_DB_POOL_IDLE_TIMEOUT_MS;
  if (!/^\d+$/.test(v)) {
    throw new ConfigError([`DB_POOL_IDLE_TIMEOUT_MS must be a non-negative integer (milliseconds), but was "${raw}"`]);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0 || n > 600_000) {
    throw new ConfigError([`DB_POOL_IDLE_TIMEOUT_MS must be between 0 and 600000, but was "${raw}"`]);
  }
  return n;
}

export function parseDbStatementTimeoutMs(raw: string | undefined): number {
  const v = raw?.trim() ?? "";
  if (v === "") return DEFAULT_DB_STATEMENT_TIMEOUT_MS;
  if (!/^\d+$/.test(v)) {
    throw new ConfigError([`DB_STATEMENT_TIMEOUT_MS must be a non-negative integer (milliseconds), but was "${raw}"`]);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0 || n > 600_000) {
    throw new ConfigError([`DB_STATEMENT_TIMEOUT_MS must be between 0 and 600000, but was "${raw}"`]);
  }
  return n;
}

/**
 * Resolve the database pool config from env, supporting both the new
 * `DB_*` names and the legacy `QUERY_TIMEOUT_MS` alias for the statement timeout.
 * `DB_STATEMENT_TIMEOUT_MS` takes precedence over `QUERY_TIMEOUT_MS`.
 */
export function parseDatabasePoolConfig(env: EnvSource = process.env): DatabasePoolConfig {
  const max = parsePositiveIntEnv(env.DB_POOL_MAX ?? env.DATABASE_POOL_MAX, "DB_POOL_MAX", DEFAULT_DB_POOL_MAX, {
    min: 1,
    max: 100,
  });
  const connectionTimeoutMillis = parseDbPoolConnectionTimeoutMs(
    env.DB_POOL_CONNECTION_TIMEOUT_MS ?? env.DATABASE_CONNECTION_TIMEOUT_MS
  );
  const idleTimeoutMillis = parseDbPoolIdleTimeoutMs(
    env.DB_POOL_IDLE_TIMEOUT_MS ?? env.DATABASE_IDLE_TIMEOUT_MS
  );
  // Statement timeout: prefer DB_STATEMENT_TIMEOUT_MS, fallback to legacy QUERY_TIMEOUT_MS.
  const statementRaw = env.DB_STATEMENT_TIMEOUT_MS ?? env.QUERY_TIMEOUT_MS;
  const statementTimeoutMillis = parseDbStatementTimeoutMs(statementRaw);

  return { max, connectionTimeoutMillis, idleTimeoutMillis, statementTimeoutMillis };
}

// ── Aggregate ────────────────────────────────────────────────────────────────

/**
 * Validate every startup-critical variable and return the resulting config.
 *
 * All problems are collected before throwing so a misconfigured deployment is
 * reported in one message instead of one restart per mistake.
 */
export function loadConfig(env: EnvSource = process.env): IndexerConfig {
  const problems: string[] = [];

  const collect = <T>(parse: () => T): T | undefined => {
    try {
      return parse();
    } catch (err) {
      if (err instanceof ConfigError) {
        problems.push(...err.problems);
        return undefined;
      }
      throw err;
    }
  };

  const databaseUrl = collect(() => parseDatabaseUrl(env.DATABASE_URL));
  const stellarRpcUrl = collect(() => parseStellarRpcUrl(env.STELLAR_RPC_URL));
  const contractId = collect(() => parseContractId(env.CONTRACT_ID));
  const startLedger = collect(() => parseStartLedger(env.START_LEDGER));
  const dbPool = collect(() => parseDatabasePoolConfig(env));

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    databaseUrl: databaseUrl as string,
    stellarRpcUrl: stellarRpcUrl as string,
    contractId: contractId as string,
    startLedger: startLedger as number,
    dbPool: dbPool as DatabasePoolConfig,
  };
}
