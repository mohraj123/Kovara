/**
 * Retry and backoff for transient processing failures.
 *
 * Issue #649. The indexer talks to two unreliable dependencies — a Postgres
 * connection pool and a Soroban RPC endpoint — and a naive "retry everything"
 * loop is actively harmful in both directions:
 *
 *   - Retrying a *permanent* failure (a malformed payload, a constraint
 *     violation, a 4xx from the provider) burns the retry budget on work that
 *     can never succeed, delays the dead-letter signal, and hides the real
 *     error behind a wall of identical log lines.
 *   - Retrying a *transient* failure (a dropped socket, a statement timeout)
 *     only once turns a blip into an outage.
 *
 * This module therefore draws the line explicitly:
 *
 *   - {@link classifyFailure} sorts an error into `transient` or `permanent`
 *     from its `code`, its HTTP status when present, and its message.
 *   - {@link withRetry} consults that classification, so a permanent error
 *     fails fast on the first attempt while a transient one is retried up to
 *     `maxAttempts`.
 *   - {@link isTransientError} and {@link isPermanentError} are exported so the
 *     stream and handler layers can make the same decision without duplicating
 *     the classification rules.
 *
 * Backoff is exponential with full jitter, capped at {@link MAX_BACKOFF_MS}.
 * Full jitter (`random() * backoff`) rather than a fixed delay matters here:
 * when a provider restarts, every in-flight replica fails at the same instant,
 * and a deterministic schedule would have all of them retry in lockstep and
 * reproduce the overload that caused the failure. Jitter spreads the retries
 * across the window.
 *
 * Every attempt boundary is logged, including the final give-up, so "how many
 * attempts did this get before it was dead-lettered" is answerable from logs
 * alone — the durable record only keeps the last error, not the history.
 */

/** Upper bound on any single backoff delay, in ms. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * BE-004: Parse a Retry-After header (delta-seconds or HTTP-date) into ms,
 * capped at MAX_BACKOFF_MS so polling can still shut down promptly. Returns
 * undefined for a missing or invalid value.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
}

/** Default total attempts (the first try plus two retries). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Default delay before the first retry, in ms. */
export const DEFAULT_BASE_DELAY_MS = 300;

/** Multiplier applied to the delay after each failure. */
export const DEFAULT_BACKOFF_MULTIPLIER = 2;

/**
 * Postgres SQLSTATEs that describe a condition a retry can plausibly fix.
 *
 * 40001 serialization_failure and 40P01 deadlock_detected are the two a
 * transaction may lose and simply re-run. The 08xxx and 57P0x class codes are
 * the operational ones (connection failure, admin shutdown, crash shutdown,
 * cannot connect now, too many connections, out of memory, disk full). Note
 * what is deliberately absent: `23505` (unique_violation) and the rest of the
 * 23xxx integrity class. Those are permanent — retrying them just re-runs a
 * statement that will fail identically — and their absence is the point.
 */
const RETRYABLE_PG_CODES: ReadonlySet<string> = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "55006", // object_in_use
  "55P03", // lock_not_available
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "58000", // system_error
  "58030", // io_error
  "08P01", // protocol_violation
  "08000", "08003", "08006", "08001", "08004", "08007", "08P01", // connection exceptions
]);

/**
 * Node socket-level error codes. `ECONNRESET`/`ECONNREFUSED`/`EAI_AGAIN` mean
 * the peer dropped or was unreachable; `ETIMEDOUT` means we waited too long.
 * `EPIPE` is a write to a closed socket. All are safe to retry.
 */
const RETRYABLE_SYSCALL_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EBUSY",
  "ESOCKETTIMEDOUT",
]);

/**
 * Substrings that mark a message as describing a transient condition. Matched
 * case-insensitively against the lowercased message. These cover the HTTP
 * status codes and socket errors that surface as plain `Error` instances with
 * no `code` property — the common case, because most of this code throws
 * `new Error("RPC request failed: 503 Service Unavailable")`.
 */
const TRANSIENT_MESSAGE_PATTERNS: readonly string[] = [
  "econnreset",
  "econnrefused",
  "econnaborted",
  "econnaborted",
  "etimedout",
  "epipe",
  "eai_again",
  "enotfound",
  "enotfound",
  "socket hang up",
  "connection reset",
  "connection refused",
  "connection terminated",
  "connection closed",
  "server closed",
  "client network socket disconnected",
  "timeout",
  "timed out",
  "temporarily unavailable",
  "too many connections",
  "deadlock",
  "serialization failure",
  "pool exhausted",
  "pool is draining",
  "terminating connection",
  "failed to fetch",
  "network error",
  "network",
  "502",
  "503",
  "504",
  "429",
  "rate limit",
  "throttl",
];

/**
 * Substrings that mark a message as describing a permanent condition.
 *
 * Checked *before* the transient patterns so a message carrying both signals
 * ("invalid payload: field `topic` is malformed") is classified correctly.
 * The 4xx codes listed here are the ones the indexer actually provokes: a
 * `400` from the RPC endpoint is a request this indexer built incorrectly, and
 * re-sending the identical body will not change the answer.
 */
const PERMANENT_MESSAGE_PATTERNS: readonly string[] = [
  "malformed",
  "invalid",
  "unprocessable",
  "unauthorized",
  "unauthenticated",
  "forbidden",
  "not found",
  "unsupported",
  "not implemented",
  "schema violation",
  "constraint",
  "duplicate key",
  "unique_violation",
  "foreign key",
  "check constraint",
  "out of range",
  "assertion",
  "payload",
  "400",
  "401",
  "403",
  "404",
  "409",
  "422",
];

/** How an error is classified for retry purposes. */
export type FailureKind = "transient" | "permanent";

/** The result of inspecting an error, with the reason for the decision. */
export interface FailureClassification {
  kind: FailureKind;
  /** Short machine-readable reason, surfaced in logs to explain the decision. */
  reason: string;
}

/** Extract a `code` property from an unknown thrown value, if it has one. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    // Database drivers/ORMs often wrap the driver error (e.g. a pg
    // ECONNRESET or 57P01) as `cause`; look one level down for its code.
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === "string") return causeCode;
    }
  }
  return undefined;
}

/** Extract an HTTP status from `status`, `statusCode` or `response.status`, if present. */
function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate < 600) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * HTTP statuses worth retrying: request timeout, too early, rate limited, and
 * the gateway/availability 5xx family. Every other 4xx, and 501/505, describe a
 * request that will fail the same way again.
 */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Extract a lowercased message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.toLowerCase();
  if (typeof err === "string") return err.toLowerCase();
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message.toLowerCase();
  }
  return String(err).toLowerCase();
}

/**
 * Sort a thrown value into `transient` or `permanent`.
 *
 * Order of precedence, which matters because the same error often carries
 * several signals:
 *
 *   1. An explicit `code` — most precise. A retryable SQLSTATE or syscall code
 *      wins outright; a known-integrity SQLSTATE (`23505`, `23503`, `22P02`, …)
 *      is permanent even if the message reads like a timeout.
 *   2. An HTTP status (`status`, `statusCode` or `response.status`): 408, 425,
 *      429, 500, 502, 503 and 504 are transient; every other 4xx/5xx is
 *      permanent.
 *   3. Permanent message markers, checked before transient ones so that
 *      "invalid payload" is not mistaken for something worth retrying.
 *   4. Transient message markers.
 *   5. Default: permanent. An unrecognised error is not retried, because
 *      retrying an error we do not understand cannot fix it and the
 *      dead-letter path exists precisely so a human can look at it.
 */
export function classifyFailure(err: unknown): FailureClassification {
  const code = errorCode(err);
  if (code) {
    if (RETRYABLE_PG_CODES.has(code)) {
      return { kind: "transient", reason: `retryable_sqlstate_${code}` };
    }
    if (RETRYABLE_SYSCALL_CODES.has(code)) {
      return { kind: "transient", reason: `retryable_socket_${code}` };
    }
    // Postgres class 23 (integrity_constraint_violation) is permanent: a
    // unique/foreign-key/check violation is a property of the data, not of
    // the moment, and re-running the statement cannot change the outcome.
    if (/^23/.test(code) || code === "22P02" || code === "22007" || code === "22012") {
      return { kind: "permanent", reason: `integrity_violation_${code}` };
    }
    // Postgres class 08 (connection_exception) and 53/57/58 (operational) are
    // transient by definition even when the `code` is a variant we do not list.
    if (/^(08|53|54|55|57|58)/.test(code)) {
      return { kind: "transient", reason: `operational_sqlstate_${code}` };
    }
  }

  // An explicit HTTP status is more reliable than text in the message.
  const status = errorStatus(err);
  if (status !== undefined && status >= 400) {
    return RETRYABLE_HTTP_STATUSES.has(status)
      ? { kind: "transient", reason: `retryable_http_status_${status}` }
      : { kind: "permanent", reason: `http_status_${status}` };
  }

  const message = errorMessage(err);

  for (const pattern of PERMANENT_MESSAGE_PATTERNS) {
    if (message.includes(pattern)) {
      return { kind: "permanent", reason: `permanent_message:${pattern}` };
    }
  }
  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (message.includes(pattern)) {
      return { kind: "transient", reason: `transient_message:${pattern}` };
    }
  }

  return { kind: "permanent", reason: "unclassified" };
}

/** True when the error is worth retrying. See {@link classifyFailure}. */
export function isTransientError(err: unknown): boolean {
  return classifyFailure(err).kind === "transient";
}

/** True when the error can never succeed on a retry. */
export function isPermanentError(err: unknown): boolean {
  return classifyFailure(err).kind === "permanent";
}

export interface RetryOptions {
  /** Total attempts including the first. Default: {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Delay before the first retry, in ms. Default: {@link DEFAULT_BASE_DELAY_MS}. */
  baseDelayMs?: number;
  /** Multiplier applied per attempt. Default: {@link DEFAULT_BACKOFF_MULTIPLIER}. */
  backoffMultiplier?: number;
  /** Ceiling on any single delay, in ms. Default: {@link MAX_BACKOFF_MS}. */
  maxBackoffMs?: number;
  /**
   * When true, each delay is `random() * backoff` rather than `backoff`.
   * Default: true. Full jitter is the right default for a fleet of replicas
   * that failed together; disable it only in tests that assert on timing.
   */
  jitter?: boolean;
  /**
   * Override the classification. Receives the error and returns true when it
   * should be retried. When omitted, {@link isTransientError} decides.
   *
   * An explicit override also suppresses the transient/permanent split: if you
   * claim an error is retryable, this function will retry it.
   */
  isRetryable?: (error: unknown) => boolean;
  /** Label identifying the operation, included in every log line. */
  operationLabel?: string;
  /** Structured log sink. Defaults to the process logger. */
  log?: RetryLogger;
  /** Abort signal; rejects the wait between attempts when aborted. */
  signal?: AbortSignal;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The subset of the logger this module needs. */
export interface RetryLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Render a thrown value for a log line. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compute the delay before attempt `attempt + 1`, given the attempt that just
 * failed. Attempt 1 yields the base delay, and each subsequent failure
 * multiplies it, never exceeding `maxBackoffMs`. With jitter the result is scaled
 * into `[0, backoff)`, so the cap holds for every attempt.
 */
export function computeBackoffMs(
  attempt: number,
  opts: { baseDelayMs?: number; backoffMultiplier?: number; maxBackoffMs?: number; jitter?: boolean } = {}
): number {
  const {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
    maxBackoffMs = MAX_BACKOFF_MS,
    jitter = true,
  } = opts;

  // Sanitise inputs so a bad option can never produce NaN/Infinity (which
  // `setTimeout` treats as "fire immediately") or a delay above the cap.
  const cap = Number.isFinite(maxBackoffMs) && maxBackoffMs >= 0 ? maxBackoffMs : MAX_BACKOFF_MS;
  const base = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 0;
  const multiplier =
    Number.isFinite(backoffMultiplier) && backoffMultiplier >= 1
      ? backoffMultiplier
      : DEFAULT_BACKOFF_MULTIPLIER;

  // Grow step by step and stop as soon as the cap is reached, so a very large
  // attempt number cannot overflow `Math.pow` before the cap is applied.
  let backoff = base;
  for (let i = 1; i < attempt && backoff < cap; i++) backoff *= multiplier;
  backoff = Math.min(backoff, cap);
  return jitter ? Math.floor(Math.random() * backoff) : backoff;
}

/**
 * Execute `fn` with bounded retries.
 *
 * Behaviour:
 *   - A `transient` failure is retried until `maxAttempts` is reached, sleeping
 *     a jittered exponential backoff between attempts.
 *   - A `permanent` failure fails fast on the first attempt; no backoff is
 *     spent, and the error is reported as permanent so the caller can route it
 *     straight to the dead-letter path.
 *   - When attempts are exhausted the last error is rethrown, having logged the
 *     give-up with the attempt count.
 *
 * @throws the last error when attempts are exhausted or the failure is permanent.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
    maxBackoffMs = MAX_BACKOFF_MS,
    jitter = true,
    isRetryable,
    operationLabel = "operation",
    log = console,
    signal,
    sleep: sleepFn = sleep,
  } = opts;

  // A retry budget below 1 would mean "never attempt", which cannot return a
  // value and has no error to rethrow. Clamp to 1 and let the call fail
  // normally on the single attempt.
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw lastError ?? new Error(`${operationLabel} aborted before attempt ${attempt}`);
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Without an explicit override, the transient/permanent split decides:
      // a permanent error is never retried, so the caller learns about it
      // immediately instead of after the full backoff schedule.
      const retryable = isRetryable ? isRetryable(err) : isTransientError(err);
      const isLastAttempt = attempt >= attempts;

      if (!retryable) {
        log.warn(`${operationLabel} failed permanently (attempt ${attempt}/${attempts}), not retrying`, {
          operation: operationLabel,
          attempt,
          maxAttempts: attempts,
          classification: classifyFailure(err),
          err,
        });
        throw err;
      }

      if (isLastAttempt) break;

      // BE-004: honour a provider Retry-After hint (never below the computed
      // backoff, never above the cap).
      const hint = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
      const computed = computeBackoffMs(attempt, {
        baseDelayMs,
        backoffMultiplier,
        maxBackoffMs,
        jitter,
      });
      const delay =
        typeof hint === "number" && Number.isFinite(hint) && hint > 0
          ? Math.min(Math.max(computed, hint), maxBackoffMs)
          : computed;

      log.warn(`${operationLabel} failed transiently (attempt ${attempt}/${attempts}), retrying in ${delay}ms`, {
        operation: operationLabel,
        attempt,
        maxAttempts: attempts,
        delayMs: delay,
        classification: classifyFailure(err),
        err,
      });

      if (signal?.aborted) throw err;
      await sleepFn(delay);
    }
  }

  log.error(`${operationLabel} failed after ${attempts} attempt(s): ${describe(lastError)}`, {
    operation: operationLabel,
    attempts,
    classification: classifyFailure(lastError),
    err: lastError,
  });
  throw lastError;
}
