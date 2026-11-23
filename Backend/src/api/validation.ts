import { Response } from "express";

/**
 * Centralized request validation for the public HTTP API (issue #665).
 *
 * Before this module every route carried its own ad-hoc `if` chain, which
 * produced three problems:
 *
 *   1. **Drift** — the same field was checked differently in different routes.
 *      A Stellar address was `[A-Z0-9]` in `routes/profiles.ts`,
 *      `[A-Z2-7]` in `routes/activity.ts`, and not checked at all in
 *      `routes/follows.ts`.
 *   2. **Late rejection** — checks lived inside handlers, so a malformed
 *      request could reach a database call before it was refused.
 *   3. **Inconsistent errors** — the same failure returned `INVALID_QUERY` on
 *      one endpoint and `INVALID_PAGINATION` on another.
 *
 * This module is the single place that decides whether a request field is
 * well-formed. Routes describe *which* fields they accept and at what bounds;
 * the parsers here decide *what* is valid and produce the error envelope. A
 * validation failure is therefore impossible to express in a route-specific
 * shape, because routes never construct one.
 *
 * The error envelope is exactly `ApiErrorResponse` (`{ error, code }`), the
 * contract the rest of the API already publishes, so no client contract
 * changes.
 *
 * ## Security-sensitive fields
 *
 * Wallet addresses are treated as security-sensitive: they are matched against
 * the strict Stellar public-key alphabet (`G` followed by 55 base-32
 * characters, `A–Z` and `2–7`) rather than the looser `[A-Z0-9]` that admits
 * the characters `0`, `1`, `8` and `9` — none of which exist in Stellar
 * strkeys. Identifiers are parsed as `bigint` so a value larger than
 * `Number.MAX_SAFE_INTEGER` is never silently rounded, and every bounded
 * numeric field has an explicit ceiling rather than relying on `parseInt`.
 */

// ── Results ──────────────────────────────────────────────────────────────────

/** Machine-readable validation failure codes, shared by every endpoint. */
export type ValidationCode =
  | "INVALID_ADDRESS"
  | "INVALID_QUERY"
  | "INVALID_ID"
  | "INVALID_CURSOR"
  | "INVALID_CONTENT"
  | "INVALID_FIELD"
  | "LIMIT_EXCEEDED";

/**
 * A single validation failure.
 *
 * `status` is always `400`, but it is carried on the issue rather than assumed
 * at the call site so that a future non-400 rejection (e.g. `413` for an
 * oversized body) does not require every route to change.
 */
export interface ValidationIssue {
  status: number;
  code: ValidationCode;
  /** Human-readable, safe to return to the client. */
  error: string;
  /** The request field that failed; never contains the submitted value. */
  field: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issue: ValidationIssue };

function fail(code: ValidationCode, error: string, field: string): ValidationResult<never> {
  return { ok: false, issue: { status: 400, code, error, field } };
}

// ── Shared bounds ────────────────────────────────────────────────────────────

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;
export const DEFAULT_OFFSET = 0;

/** Longest cursor we will accept; cursors are opaque keys, not documents. */
export const MAX_CURSOR_LENGTH = 128;

// ── Stellar addresses (security-sensitive) ───────────────────────────────────

/**
 * A Stellar public key ("strkey"): `G` followed by 55 base-32 characters.
 *
 * Base-32 here is the Stellar alphabet — `A–Z` and `2–7`. The excluded digits
 * (`0`, `1`, `8`, `9`) never appear in a real strkey, so accepting them (as the
 * previous `[A-Z0-9]` checks did) would let a malformed value through to a
 * database lookup.
 */
export const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

export function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && STELLAR_ADDRESS_PATTERN.test(value);
}

/**
 * Parse a required Stellar address.
 *
 * Empty/whitespace input is reported as "required" rather than "invalid" so a
 * caller missing the field gets a message that says so.
 */
export function parseStellarAddress(raw: unknown, field = "address"): ValidationResult<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fail("INVALID_ADDRESS", `${field} is required`, field);
  }
  if (!isStellarAddress(raw)) {
    return fail(
      "INVALID_ADDRESS",
      `${field} must be a valid Stellar public key (G followed by 55 base-32 characters)`,
      field
    );
  }
  return { ok: true, value: raw };
}

/**
 * Parse an optional Stellar address. Absent/empty input yields `undefined`;
 * anything else must be a valid address.
 */
export function parseOptionalStellarAddress(
  raw: unknown,
  field = "address"
): ValidationResult<string | undefined> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  return parseStellarAddress(raw, field);
}

// ── Numeric fields ───────────────────────────────────────────────────────────

/**
 * Build a `limit` parser with an explicit ceiling.
 *
 * A value that is not a positive integer is `INVALID_QUERY`; a value above the
 * endpoint's ceiling is `LIMIT_EXCEEDED`, because "too small" and "too large"
 * are different client mistakes.
 */
export function parseLimit(
  maxLimit: number = MAX_LIMIT,
  defaultLimit: number = DEFAULT_LIMIT
): (raw: unknown, field?: string) => ValidationResult<number> {
  return (raw: unknown, field = "limit"): ValidationResult<number> => {
    if (raw === undefined || raw === null) return { ok: true, value: defaultLimit };
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail("INVALID_QUERY", "limit must be a positive integer", field);
    }
    if (parsed > maxLimit) {
      return fail("LIMIT_EXCEEDED", `limit cannot exceed ${maxLimit}`, field);
    }
    return { ok: true, value: parsed };
  };
}

/** Parse a `limit` capped at the API-wide {@link MAX_LIMIT}. */
export const parseStandardLimit = parseLimit(MAX_LIMIT, DEFAULT_LIMIT);

/** Parse an optional non-negative `offset`, defaulting to `0`. */
export function parseOffset(raw: unknown, field = "offset"): ValidationResult<number> {
  if (raw === undefined || raw === null) return { ok: true, value: DEFAULT_OFFSET };
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fail("INVALID_QUERY", "offset must be a non-negative integer", field);
  }
  return { ok: true, value: parsed };
}

/**
 * Parse a numeric resource identifier as `bigint`.
 *
 * `bigint` is used rather than `number` so identifiers above
 * `Number.MAX_SAFE_INTEGER` survive intact — post and submission ids are
 * contract-scoped and can exceed that bound.
 */
export function parseNumericId(raw: unknown, field = "id"): ValidationResult<bigint> {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return fail("INVALID_ID", `${field} must be a non-negative integer`, field);
  }
  const text = String(raw).trim();
  if (text === "" || !/^\d+$/.test(text)) {
    return fail("INVALID_ID", `${field} must be a non-negative integer`, field);
  }
  try {
    return { ok: true, value: BigInt(text) };
  } catch {
    return fail("INVALID_ID", `${field} must be a non-negative integer`, field);
  }
}

// ── Cursors ──────────────────────────────────────────────────────────────────

/**
 * Parse an optional pagination cursor.
 *
 * A cursor is an opaque key, so its *content* is not interpreted here; only its
 * type and length are bounded. Rejecting oversized cursors prevents an
 * arbitrarily long string from being handed to the store as a comparison key.
 */
export function parseCursor(raw: unknown, field = "cursor"): ValidationResult<string | undefined> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return fail("INVALID_CURSOR", "cursor must be a string", field);
  }
  if (raw.length > MAX_CURSOR_LENGTH) {
    return fail("INVALID_CURSOR", `cursor cannot exceed ${MAX_CURSOR_LENGTH} characters`, field);
  }
  return { ok: true, value: raw };
}

// ── Free-text fields ─────────────────────────────────────────────────────────

/**
 * Longest post body the API accepts, in UTF-16 code units.
 *
 * The bound is applied at the API edge so an oversized body is refused before
 * it reaches the database: `posts.content` is a plain `TEXT` column with no
 * length constraint, so without this check an oversized post is stored happily
 * and only fails later — when a client renders it, or when a list endpoint
 * serializes it. The limit matches the 280-character cap the web client
 * enforces, so a post the UI accepts is never rejected by the API (BE-04).
 */
export const MAX_POST_CONTENT_LENGTH = 280;

/** Longest accepted profile username. Mirrors the on-chain profile limit. */
export const MAX_USERNAME_LENGTH = 32;

/**
 * Parse post content submitted to the API.
 *
 * Unlike the other parsers this one measures the value *as submitted* rather
 * than a trimmed copy, because content is stored verbatim: trimming here would
 * silently rewrite a post. Only the emptiness and the length are checked, both
 * before persistence.
 */
export function parsePostContent(
  raw: unknown,
  field = "content"
): ValidationResult<string> {
  if (typeof raw !== "string") {
    return fail("INVALID_CONTENT", `${field} must be a string`, field);
  }
  if (raw.trim() === "") {
    return fail("INVALID_CONTENT", `${field} cannot be empty`, field);
  }
  if (raw.length > MAX_POST_CONTENT_LENGTH) {
    return fail(
      "INVALID_CONTENT",
      `${field} cannot exceed ${MAX_POST_CONTENT_LENGTH} characters (received ${raw.length})`,
      field
    );
  }
  return { ok: true, value: raw };
}

/**
 * Parse a profile username.
 *
 * Length and emptiness are checked here rather than relying on the database
 * constraints (`chk_profile_username_not_empty`, `uq_profile_username`), so a
 * rejected username comes back as a field-specific 400 instead of a unique
 * violation raised from inside a write (BE-06).
 */
export function parseUsername(raw: unknown, field = "username"): ValidationResult<string> {
  if (typeof raw !== "string") {
    return fail("INVALID_FIELD", `${field} must be a string`, field);
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fail("INVALID_FIELD", `${field} cannot be empty`, field);
  }
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return fail(
      "INVALID_FIELD",
      `${field} cannot exceed ${MAX_USERNAME_LENGTH} characters`,
      field
    );
  }
  return { ok: true, value: trimmed };
}

// ── Generic schema entry point ───────────────────────────────────────────────

export type Parser<T> = (raw: unknown, field: string) => ValidationResult<T>;

export interface FieldRule<T> {
  parse: Parser<T>;
  /** When `false`, a missing value is accepted. Defaults to `true`. */
  required?: boolean;
  /** Value used when the field is absent and optional. */
  default?: T;
}

/**
 * Validate a set of named fields from one request source.
 *
 * This is the entry point routers use: they describe the fields they accept,
 * and receive either the parsed, narrowed values or the single issue to return.
 * Fields are checked in declaration order, so the first failure is the one
 * reported — deterministic ordering matters because a client fixing errors one
 * at a time should not see the message change between identical requests.
 */
export function validate<T extends object>(
  schema: Record<string, FieldRule<unknown>>,
  source: Record<string, unknown>
): ValidationResult<T> {
  const out: Record<string, unknown> = {};

  for (const [field, rule] of Object.entries(schema)) {
    const raw = source[field];
    const absent = raw === undefined || raw === null;
    const required = rule.required ?? true;

    if (absent) {
      if (required) {
        // Let the parser own the "required" message so its code is correct
        // (an address is INVALID_ADDRESS, not INVALID_QUERY).
        const parsed = rule.parse(undefined, field);
        if (!parsed.ok) return parsed;
        out[field] = parsed.value;
        continue;
      }
      if (rule.default !== undefined) out[field] = rule.default;
      continue;
    }

    const parsed = rule.parse(raw, field);
    if (!parsed.ok) return parsed;
    out[field] = parsed.value;
  }

  return { ok: true, value: out as unknown as T };
}

// ── Response helper ──────────────────────────────────────────────────────────

/**
 * Send a validation issue using the shared `ApiErrorResponse` envelope.
 *
 * Every endpoint funnels failures through here, which is what makes the error
 * shape consistent across the API by construction rather than by convention.
 */
export function sendValidationError(res: Response, issue: ValidationIssue): void {
  res.status(issue.status).json({ error: issue.error, code: issue.code });
}
