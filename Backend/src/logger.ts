/**
 * Structured logger for the Kovara indexer.
 *
 * BA-039: Centralizes logging so filtering is consistent and sensitive
 * data is never written raw:
 *   - Structured fields are emitted alongside a human-readable message.
 *   - Correlation context can be attached via `bind`/`child` so log lines
 *     from the same request, stream cycle, or replay run are groupable.
 *   - Redaction masks Stellar addresses and opaque event payloads before they
 *     reach the console, preventing sensitive values from leaking into logs.
 *
 * BA-042: Error telemetry — every `error()`/`warn()` line carries a bounded
 * stack trace and error code (when present), and all error/warn events are
 * counted into in-memory metrics (`getErrorMetrics()`) keyed by error code
 * and message, for debugging production issues without a log aggregator.
 *
 * Backwards-compatible with the previous `logger.info/warn/error/always`
 * surface, so existing call sites keep working without modification.
 */

// ── Deduplication (preserved from previous behaviour) ───────────────────────

const recentLogs = new Map<string, number>();
const DEDUP_WINDOW_MS = 60_000;

function logKey(level: string, message: string): string {
  return `${level}:${message}`;
}

function shouldLog(key: string): boolean {
  const now = Date.now();
  const lastLog = recentLogs.get(key);
  if (lastLog && now - lastLog < DEDUP_WINDOW_MS) {
    return false;
  }
  recentLogs.set(key, now);
  if (recentLogs.size > 1000) {
    const oldest = now - 120_000;
    for (const [k, t] of recentLogs.entries()) {
      if (t < oldest) recentLogs.delete(k);
    }
  }
  return true;
}

// ── Redaction helpers (BA-039) ──────────────────────────────────────────────

/** How many leading characters of an address to keep visible. */
const ADDRESS_KEEP_HEAD = 6;
/** How many trailing characters of an address to keep visible. */
const ADDRESS_KEEP_TAIL = 4;
/** Opaque payloads longer than this are truncated to avoid leaking the body. */
const PAYLOAD_MAX_LEN = 64;
/** Maximum stack-trace length kept in a log line (BA-042). */
const STACK_MAX_LEN = 2048;
/** Maximum distinct message keys tracked by error metrics (BA-042). */
const METRICS_MAX_KEYS = 100;

/**
 * Mask a Stellar-style address (e.g. `GABCDE...WXYZ`) so its identity is
 * omitted from logs while remaining attributable.
 */
export function redactAddress(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (raw.length <= ADDRESS_KEEP_HEAD + ADDRESS_KEEP_TAIL + 3) {
    return "***";
  }
  return `${raw.slice(0, ADDRESS_KEEP_HEAD)}...${raw.slice(-ADDRESS_KEEP_TAIL)}`;
}

/**
 * Redact an opaque/structured value. Fixed-length opaque payloads (values,
 * signatures, hashes) are truncated; nested string fields that look like
 * addresses are masked.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    const s = value.trim();
    // Stellar addresses (56-char, start with G) are masked as addresses.
    if (s.length === 56 && /^[G]/.test(s)) return redactAddress(s);
    // Long opaque payloads (hex/base64 values, values) are truncated.
    if (s.length > PAYLOAD_MAX_LEN) {
      return `${s.slice(0, 8)}...redacted...(${s.length} chars)`;
    }
    return s;
  }
  return value;
}

/**
 * Deeply redact a log argument: array/object containers are walked, and any
 * string that is a Stellar address or long opaque payload is masked. This is
 * applied to free-form arguments passed to the logger.
 */
export function redact(arg: unknown, depth = 0): unknown {
  if (depth > 6) return "<max-depth>";
  if (arg instanceof Error) {
    // Keep the essential, bounded error context without dumping sensitive
    // payload fields that might be stashed on the error object.
    // BA-042: the stack IS kept (bounded) so production failures are debuggable.
    const message = String(arg.message);
    const bounded =
      message.length > 256 ? `${message.slice(0, 256)}...(truncated)` : message;
    const code = (arg as Error & { code?: unknown }).code;
    const stack = arg.stack ? boundStack(arg.stack) : undefined;
    return {
      name: arg.name,
      message: redactValue(bounded),
      ...(code !== undefined ? { code: redactValue(code) } : {}),
      ...(stack !== undefined ? { stack } : {}),
    };
  }
  if (typeof arg === "string") return redactValue(arg);
  if (Array.isArray(arg)) return arg.map((item) => redact(item, depth + 1));
  if (arg && typeof arg === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(arg as Record<string, unknown>)) {
      out[key] = redact(value, depth + 1);
    }
    return out;
  }
  return arg;
}

/**
 * Bound a stack trace to a fixed maximum length (BA-042): keep the head
 * (error type + message + first frames) and mark the truncation.
 */
function boundStack(stack: string): string {
  if (stack.length <= STACK_MAX_LEN) return stack;
  return `${stack.slice(0, STACK_MAX_LEN)}...(truncated)`;
}

// ── Error metrics (BA-042) ──────────────────────────────────────────────────

interface ErrorMetricsSnapshot {
  /** Total error+warn events counted since process start (or last reset). */
  total: number;
  /** Events per error code (or "<unknown>" when the error has no code). */
  byCode: Record<string, number>;
  /** Events per log message key. */
  byMessage: Record<string, number>;
}

const errorMetrics = {
  total: 0,
  byCode: new Map<string, number>(),
  byMessage: new Map<string, number>(),
};

function bumpMetric(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
  // Bound memory: once over the cap, drop the oldest tracked key.
  if (map.size > METRICS_MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function recordErrorMetric(level: string, message: string, args: unknown[]): void {
  if (level !== "error" && level !== "warn") return;
  errorMetrics.total += 1;
  // Find the first Error arg (raw, before redaction) to read its code.
  // Errors are usually passed either directly or nested one level in an
  // object (e.g. `{ err }`), so check both shapes.
  let code;
  for (const arg of args) {
    if (arg instanceof Error) {
      code = (arg as Error & { code?: unknown }).code;
      break;
    }
    if (arg && typeof arg === "object" && !Array.isArray(arg)) {
      const nested = Object.values(arg as Record<string, unknown>)
        .find((v) => v instanceof Error) as Error | undefined;
      if (nested) {
        code = (nested as Error & { code?: unknown }).code;
        break;
      }
    }
  }
  bumpMetric(
    errorMetrics.byCode,
    code !== undefined ? String(code) : "<unknown>"
  );
  bumpMetric(errorMetrics.byMessage, message);
}

/**
 * Snapshot of in-memory error counters (BA-042). Exposed for health/debug
 * endpoints and tests; safe to call from any logger instance.
 */
export function getErrorMetrics(): ErrorMetricsSnapshot {
  return {
    total: errorMetrics.total,
    byCode: Object.fromEntries(errorMetrics.byCode),
    byMessage: Object.fromEntries(errorMetrics.byMessage),
  };
}

/** Reset error counters (used by tests; also handy for long-lived processes). */
export function resetErrorMetrics(): void {
  errorMetrics.total = 0;
  errorMetrics.byCode.clear();
  errorMetrics.byMessage.clear();
}

// ── Logger ──────────────────────────────────────────────────────────────────

export interface LoggerBindings {
  [key: string]: unknown;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  always(message: string, ...args: unknown[]): void;
  /** Return a child logger with extra structured context attached to every line. */
  child(bindings: LoggerBindings): Logger;
}

export class StructuredLogger implements Logger {
  constructor(
    private readonly id = "indexer",
    private readonly bindings: LoggerBindings = {}
  ) {}

  /** Emit a structured log line with optional JSON context. */
  private write(level: string, message: string, args: unknown[]): void {
    // Redact free-form arguments so sensitive payloads never reach the log.
    const safeArgs = args.map((a) => redact(a));

    const structured: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      logger: this.id,
      msg: message,
      ...this.bindings,
    };

    if (safeArgs.length === 1 && safeArgs[0] && typeof safeArgs[0] === "object") {
      Object.assign(structured, safeArgs[0]);
    } else if (safeArgs.length > 0) {
      structured.args = safeArgs;
    }

    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(JSON.stringify(structured));
  }

  info(message: string, ...args: unknown[]): void {
    if (shouldLog(logKey("info", message))) this.write("info", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog(logKey("warn", message))) {
      recordErrorMetric("warn", message, args);
      this.write("warn", message, args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (shouldLog(logKey("error", message))) {
      recordErrorMetric("error", message, args);
      this.write("error", message, args);
    }
  }

  always(message: string, ...args: unknown[]): void {
    this.write("info", message, args);
  }

  child(bindings: LoggerBindings): Logger {
    return new StructuredLogger(this.id, { ...this.bindings, ...bindings });
  }
}

export class TransactionLogger {
  logRollback(transactionId: string, error: Error, duration: number): void {
    const log = {
      timestamp: new Date(),
      transactionId: redactValue(transactionId),
      action: "ROLLBACK",
      error: redactValue(error.message),
      duration: duration + "ms",
    };
    console.log("Transaction:", log);
  }

  logCommit(transactionId: string, duration: number): void {
    console.log("Transaction:", { action: "COMMIT", transactionId: redactValue(transactionId), duration });
  }
}

/**
 * Default application logger. Imported and used across the codebase.
 */
export const logger: Logger = new StructuredLogger("indexer");
