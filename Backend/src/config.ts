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

/** The validated configuration the indexer starts from. */
export interface IndexerConfig {
  databaseUrl: string;
  stellarRpcUrl: string;
  contractId: string;
  startLedger: number;
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

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    databaseUrl: databaseUrl as string,
    stellarRpcUrl: stellarRpcUrl as string,
    contractId: contractId as string,
    startLedger: startLedger as number,
  };
}
