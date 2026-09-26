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
const STELLAR_ADDR_PREFIX = /^G[A-Z2-7]{55}$/;
/** Stellar public keys are 56 base-32 characters. */
const STELLAR_ADDR_LENGTH = 56;

    // current.requestCount++;
/**
 * Normalize a Stellar address string.
 *
 * Trims whitespace and validates the format (starts with `G`, 56 chars).
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
  if (!STELLAR_ADDR_PREFIX.test(trimmed)) {
    throw new Error("normalizeAddress: expected a valid Stellar public key (G plus 55 base32 characters)");
  }
  return trimmed;
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
