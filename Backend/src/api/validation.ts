/**
 * Centralized request validation (#665).
 *
 * Every public endpoint previously re-implemented the same checks inline —
 * Stellar addresses, pagination bounds, numeric ids, enum fields — and each
 * copy drifted slightly: one route accepted a lowercase address, another
 * truncated a fractional limit, a third only checked that a value was present.
 * That is a security problem, not just an ergonomics one, because a check that
 * exists in only some handlers is a check an attacker can route around.
 *
 * This module is the single gate. Each validator is *pure*: it takes raw,
 * untrusted input and returns either the normalized value or a
 * {@link ValidationFailure} carrying the HTTP code and client-facing message.
 * The route layer turns a failure into a 400 before any business logic (and
 * therefore any database call) runs, and the same failure shape is returned by
 * every endpoint.
 *
 * Security-sensitive fields are validated explicitly rather than incidentally:
 * wallet addresses are shape-checked, amounts are bound-checked as integers,
 * and text is length-capped so an oversized payload is rejected at the edge
 * instead of reaching the database.
 */

import { Response } from "express";

// ── Result types ─────────────────────────────────────────────────────────────

/** A client-facing validation error: HTTP status is always 400. */
export interface ValidationFailure {
  error: string;
  code: string;
}

/** The outcome of validating one field or group of fields. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ValidationFailure };

/** Build a failure result. */
export function invalid(error: string, code: string): ValidationResult<never> {
  return { ok: false, failure: { error, code } };
}

/** Build a success result. */
export function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

/**
 * Narrow a `ValidationResult` to its failure branch.
 *
 * Written as a type guard so callers can `if (isFailure(result))` and get the
 * failure typed, rather than relying on `"ok" in result` (which does not narrow
 * the union for the compiler).
 */
export function isFailure<T>(
  result: ValidationResult<T>
): result is { ok: false; failure: ValidationFailure } {
  return result.ok === false;
}

/**
 * Send a failure as the standard 400 body and return `null`, so a handler can
 * short-circuit with `const value = settle(...); if (value === null) return;`.
 */
export function settle<T>(res: Response, result: ValidationResult<T>): T | null {
  if (isFailure(result)) {
    res.status(400).json(result.failure);
    return null;
  }
  return result.value;
}

// ── Stellar addresses ────────────────────────────────────────────────────────

/**
 * Stellar public keys are 56 characters, base32, and start with `G`. The
 * character class is intentionally `[A-Z0-9]` (matching the address rate
 * limiter and the profiles route) rather than the stricter Crockford base32
 * alphabet: the API's job is to reject malformed input, and rejecting a
 * technically-valid key because of the alphabet used here would be a
 * compatibility hazard.
 */
const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** True when `value` looks like a Stellar public key. */
export function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && STELLAR_ADDRESS_RE.test(value);
}

/** Validate an address field, trimming surrounding whitespace. */
export function validateStellarAddress(
  value: unknown,
  field = "address"
): ValidationResult<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${field} is required`, "INVALID_ADDRESS");
  }
  const address = value.trim();
  if (!isStellarAddress(address)) {
    return invalid(
      `${field} must be a valid Stellar address: starts with 'G', 56 alphanumeric characters`,
      "INVALID_ADDRESS"
    );
  }
  return valid(address);
}

// ── Strings and enums ────────────────────────────────────────────────────────

/** Validate a required, non-empty string with an optional length cap. */
export function validateString(
  value: unknown,
  field: string,
  options: { maxLength?: number; code?: string } = {}
): ValidationResult<string> {
  const { maxLength, code = "INVALID_QUERY" } = options;
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${field} is required`, code);
  }
  const text = value.trim();
  if (maxLength !== undefined && text.length > maxLength) {
    return invalid(`${field} cannot exceed ${maxLength} characters`, code);
  }
  return valid(text);
}

/** Validate that `value` is one of a fixed set of allowed strings. */
export function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  code = "INVALID_QUERY"
): ValidationResult<T> {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return invalid(`${field} must be one of: ${allowed.join(", ")}`, code);
  }
  return valid(value as T);
}

// ── Numbers and integers ─────────────────────────────────────────────────────

/** Parse a non-negative integer from a number or numeric string. */
function tryBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isInteger(value) && Number.isFinite(value) ? BigInt(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Validate an integer amount in the token's smallest unit. Amounts are
 * `bigint` end to end, so a value that does not fit the type is rejected here
 * rather than silently truncated to a `Number` and rounded at the database.
 */
export function validateInteger(
  value: unknown,
  field: string,
  options: { min?: bigint; max?: bigint; code?: string } = {}
): ValidationResult<bigint> {
  const { min = 0n, max, code = "INVALID_AMOUNT" } = options;
  const parsed = tryBigInt(value);
  if (parsed === null) {
    return invalid(`${field} must be an integer`, code);
  }
  if (parsed < min) {
    return invalid(`${field} must be at least ${min}`, code);
  }
  if (max !== undefined && parsed > max) {
    return invalid(`${field} cannot exceed ${max}`, code);
  }
  return valid(parsed);
}

/** Validate a positive (strictly greater than zero) integer. */
export function validatePositiveInteger(
  value: unknown,
  field: string,
  options: { max?: bigint; code?: string } = {}
): ValidationResult<bigint> {
  const parsed = validateInteger(value, field, { min: 1n, ...options });
  return parsed;
}

/** Validate a numeric path parameter (e.g. a post id) as a non-negative integer. */
export function validateId(value: unknown, field = "id"): ValidationResult<bigint> {
  if (typeof value !== "string" || value.trim() === "" || !/^\d+$/.test(value.trim())) {
    return invalid(`${field} must be a non-negative integer`, "INVALID_ID");
  }
  try {
    return valid(BigInt(value.trim()));
  } catch {
    return invalid(`${field} must be a non-negative integer`, "INVALID_ID");
  }
}

// ── Pagination ───────────────────────────────────────────────────────────────

/** A validated, bounded page window. */
export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Validate `limit`/`offset` query parameters.
 *
 * Bounds are enforced here so a client cannot request an unbounded page: an
 * unbounded `limit` is both a denial-of-service vector and a way to
 * accidentally read a whole table into memory.
 */
export function validatePagination(
  query: Record<string, unknown>,
  options: { defaultLimit?: number; maxLimit?: number; defaultOffset?: number } = {}
): ValidationResult<Pagination> {
  const { defaultLimit = 20, maxLimit = 100, defaultOffset = 0 } = options;

  // Only a number or a numeric string is a valid count. `Number()` alone would
  // coerce `true` to 1 and `[]` to 0, silently accepting a malformed parameter
  // as a meaningful page window — exactly the kind of coercion #665 removes.
  const asCount = (value: unknown): number => {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return NaN;
  };

  const rawLimit = query.limit !== undefined && query.limit !== null ? asCount(query.limit) : defaultLimit;
  const rawOffset =
    query.offset !== undefined && query.offset !== null ? asCount(query.offset) : defaultOffset;

  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    return invalid("limit must be a positive integer", "INVALID_QUERY");
  }
  if (rawLimit > maxLimit) {
    return invalid(`limit cannot exceed ${maxLimit}`, "LIMIT_EXCEEDED");
  }
  if (!Number.isInteger(rawOffset) || rawOffset < 0) {
    return invalid("offset must be a non-negative integer", "INVALID_QUERY");
  }

  return valid({ limit: rawLimit, offset: rawOffset });
}

// ── Transaction hashes ───────────────────────────────────────────────────────

/**
 * Validate a Stellar transaction hash: 32 bytes of hex, optionally 0x-prefixed.
 * Length-bounded so an oversized value cannot be used to bloat a row.
 */
export function validateTransactionHash(
  value: unknown,
  field = "tx_hash"
): ValidationResult<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${field} is required`, "INVALID_TRANSACTION_HASH");
  }
  const hash = value.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) {
    return invalid(`${field} must be a 64-character hex string`, "INVALID_TRANSACTION_HASH");
  }
  return valid(hash);
}

// ── Query normalization ──────────────────────────────────────────────────────

/**
 * Collapse internal whitespace and trim, and enforce a maximum length, so a
 * search term is normalized once before it reaches the database.
 */
export function validateSearchQuery(
  value: unknown,
  options: { maxLength?: number } = {}
): ValidationResult<string> {
  const { maxLength = 500 } = options;
  if (typeof value !== "string") {
    return invalid("query is required", "INVALID_QUERY");
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized === "") {
    return invalid("query is required", "INVALID_QUERY");
  }
  if (normalized.length > maxLength) {
    return invalid(`query cannot exceed ${maxLength} characters`, "QUERY_TOO_LONG");
  }
  return valid(normalized);
}
