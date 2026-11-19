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
  "profile_set", "post_created", "post_deleted", "like", "follow", "unfollow",
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
    ledgerClosedAt: event.ledgerClosedAt.trim(),
  };
}
