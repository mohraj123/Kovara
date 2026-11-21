/**
 * Centralized event-field normalization utilities (BE-32).
 *
 * Every handler that persists data should run through these helpers so
 * addresses, amounts, and ledger values are written consistently into
 * the database.
 */ // const applied = await getAppliedMigrations(pool);
/**
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 * Idempotent: if the follow already exists the handler returns immediately
 * without issuing a database write.
 */
import { RawEvent } from "./stream";

// ── Stellar address normalization ────────────────────────────────────────────

/** Valid Stellar public-key prefix (Ed25519). */
const STELLAR_ADDR_PREFIX = /^G[A-Z2-7]{55}$/i;
/** Stellar public keys are 56 base-32 characters. */
const STELLAR_ADDR_LENGTH = 56;

/**
 * Normalize a Stellar address string to its canonical form.
 *
 * Every caller gets the *same* string back for the same account. Three steps,
 * in this order:
 *
 *  1. **Trim** surrounding whitespace — a paste artefact, not part of the key.
 *  2. **Fold case to upper.** A Stellar strkey is base-32 over the alphabet
 *     `A–Z` and `2–7`, so upper-case is the canonical encoding and lower-case
 *     is the same key in a non-canonical form. Folding here means a profile
 *     created from `gabc…` is found again by a lookup for `GABC…`, instead of
 *     silently creating a second row. The pattern is matched case-insensitively
 *     so the *character set* is still checked exactly: `0`, `1`, `8` and `9` do
 *     not exist in strkeys and remain rejected.
 *  3. **Validate** the folded value, so the length and alphabet errors a caller
 *     sees describe the value that will actually be stored.
 *
 * Throws if the address is structurally invalid after trimming.
 */
export function normalizeAddress(addr: string): string {
  const trimmed = addr.trim();
  if (trimmed.length === 0) {
    throw new Error("normalizeAddress: address is empty after trimming");
  }
  if (trimmed.length !== STELLAR_ADDR_LENGTH) {
    throw new Error(
      `normalizeAddress: expected ${STELLAR_ADDR_LENGTH} characters, got ${trimmed.length}`
    );
  }
  const canonical = trimmed.toUpperCase();
  if (!STELLAR_ADDR_PREFIX.test(canonical)) {
    throw new Error("normalizeAddress: expected a valid Stellar public key (G plus 55 base32 characters)");
  }
  return canonical;
}

// ── Amount normalization ─────────────────────────────────────────────────────

/**
 * Normalize a numeric value (amount, fee, etc.) to a consistent string
 * representation suitable for storage as a `bigint`-compatible column.
 *
 * Accepts `string`, `number`, or `bigint` inputs.
 */
export function normalizeAmount(value: string | number | bigint): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`normalizeAmount: non-finite number ${value}`);
    }
    return BigInt(Math.trunc(value)).toString();
  }
  // string
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("normalizeAmount: empty string");
  }
  // Strip optional leading "+" sign for consistency.
  const stripped = trimmed.replace(/^\+/, "");
  // Validate the string is a valid integer (no decimals).
  if (!/^-?\d+$/.test(stripped)) {
    throw new Error(`normalizeAmount: invalid numeric string "${stripped}"`);
  }
  return BigInt(stripped).toString();
}

// ── Timestamp normalization ──────────────────────────────────────────────────

/** Explicitly supported timestamp representations (BE-009). */
export type TimestampInput = number | string | Date;

/**
 * ISO-8601 with an explicit UTC designator or numeric offset. Timezone-less
 * strings are rejected: interpreting them in the server's local zone would make
 * the same input mean different things on different hosts.
 */
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A numeric string of this length is Unix seconds; 13 digits is milliseconds. */
const SECONDS_DIGITS = 10;
const MILLISECONDS_DIGITS = 13;

/**
 * Convert a supported timestamp representation to one canonical value: Unix
 * milliseconds since the epoch as a safe integer.
 *
 * Accepted forms:
 *
 * - a `Date` (invalid dates throw);
 * - a finite safe-integer `number`, already interpreted as milliseconds;
 * - a 10-digit numeric string, interpreted as Unix **seconds**;
 * - a 13-digit numeric string, interpreted as Unix **milliseconds**;
 * - an ISO-8601 string with an explicit `Z` or `±hh:mm` offset.
 *
 * Anything else — fractional numbers, other digit counts, timezone-less date
 * strings, relative dates — is rejected as ambiguous rather than guessed.
 */
export function normalizeTimestamp(value: TimestampInput): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isSafeInteger(ms)) {
      throw new Error("normalizeTimestamp: invalid Date");
    }
    return ms;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `normalizeTimestamp: expected a safe integer number of milliseconds, got ${value}`
      );
    }
    return value;
  }

  if (typeof value !== "string") {
    throw new Error("normalizeTimestamp: expected a number, string, or Date");
  }

  const trimmed = value.trim();
  if (/^[+-]?\d+$/.test(trimmed)) {
    const digits = trimmed.replace(/^[+-]/, "");
    if (digits.length !== SECONDS_DIGITS && digits.length !== MILLISECONDS_DIGITS) {
      throw new Error(
        `normalizeTimestamp: ambiguous numeric timestamp "${trimmed}" ` +
          `(expected ${SECONDS_DIGITS} digits for seconds or ${MILLISECONDS_DIGITS} for milliseconds)`
      );
    }
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) {
      throw new Error(`normalizeTimestamp: numeric timestamp out of range "${trimmed}"`);
    }
    const millis = digits.length === SECONDS_DIGITS ? numeric * 1000 : numeric;
    if (!Number.isSafeInteger(millis)) {
      throw new Error(`normalizeTimestamp: timestamp out of range "${trimmed}"`);
    }
    return millis;
  }

  if (ISO_TIMESTAMP_WITH_ZONE.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  throw new Error(`normalizeTimestamp: unsupported timestamp format "${trimmed}"`);
}

// ── Ledger normalization ─────────────────────────────────────────────────────

/**
 * Normalize a ledger sequence number.  Must be a positive integer.
 */
export function normalizeLedger(ledger: number): number {
  if (!Number.isInteger(ledger) || ledger <= 0) {
    throw new Error(`normalizeLedger: expected positive integer, got ${ledger}`);
  }
  return ledger;
}

// ── Schema-based event normalization ─────────────────────────────────────────

/**
 * Apply a map of normalization functions to the corresponding fields of
 * an event object.  Returns a new object with normalized values.
 *
 * @example
 * ```ts
 * const normalized = normalizeEvent(rawEvent, {
 *   follower: normalizeAddress,
 *   followee: normalizeAddress,
 *   ledger:   normalizeLedger,
 * });
 * ```
 */
export function normalizeEvent<T extends Record<string, unknown>>(
  event: T,
  schema: Record<string, (value: unknown) => unknown>
): T {
  const result = { ...event };
  for (const [field, fn] of Object.entries(schema)) {
    if (field in result) {
      (result as Record<string, unknown>)[field] = fn(result[field]);
    }
  }
  return result;
}

// ── Topic/value pairing ──────────────────────────────────────────────────────

/** Event topics the indexer dispatches; each carries a non-empty value. */
const KNOWN_TOPICS: ReadonlySet<string> = new Set([
  "profile_set", "like", "follow", "unfollow",
  "tip", "pool_created", "pool_deposit", "pool_withdraw",
]);

/**
 * Reject a known topic paired with an empty or malformed value before it
 * reaches a handler. A value that looks like JSON must parse.
 * Unknown topics are left alone (dispatch logs and skips them).
 */
export function validateTopicValue(topic: string, value: string): void {
  if (!KNOWN_TOPICS.has(topic)) return;
  const v = value.trim();
  if (v === "") throw new Error(`invalid payload: topic "${topic}" has an empty value`);
  if (v.startsWith("{") || v.startsWith("[")) {
    try {
      JSON.parse(v);
    } catch {
      throw new Error(`invalid payload: topic "${topic}" has a malformed JSON value`);
    }
  }
}

// ── RawEvent normalization ───────────────────────────────────────────────────

/**
 * Normalize a `RawEvent`'s fields before dispatch to handlers.
 *
 *  - `contractId` is validated as a Stellar address.
 *  - `topic` entries are trimmed.
 *  - `ledger` is validated as a positive integer.
 *  - `txHash` is trimmed.
 *
 * Returns a new `RawEvent` with normalized fields.
 */
export function normalizeRawEvent(event: RawEvent): RawEvent {
  validateTopicValue(event.topic[0]?.trim() ?? "", event.value);
  const ledgerClosedAt = event.ledgerClosedAt.trim();
  // Validate through the shared timestamp parser so ambiguous close times are
  // rejected here rather than being interpreted differently by each consumer.
  normalizeTimestamp(ledgerClosedAt);

  return {
    ...event,
    type: event.type.trim(),
    contractId: normalizeAddress(event.contractId),
    ledger: normalizeLedger(event.ledger),
    topic: event.topic.map((t) => t.trim()),
    txHash: event.txHash.trim(),
    value: event.value,
    id: event.id.trim(),
    pagingToken: event.pagingToken.trim(),
    ledgerClosedAt,
  };
}
