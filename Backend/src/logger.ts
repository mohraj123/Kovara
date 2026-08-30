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
 *   - Enhanced observability: stack traces, error codes, and metrics for
 *     production debugging (BA-040).
 *
 * Backwards-compatible with the previous `logger.info/warn/error/always`
 * surface, so existing call sites keep working without modification.
 */

// ── Error metrics tracking ───────────────────────────────────────────────────

interface ErrorMetric {
  count: number;
  lastOccurrence: number;
  firstOccurrence: number;
  lastStackTrace?: string;
}

const errorMetrics = new Map<string, ErrorMetric>();

/**
 * Track error occurrence with metrics (count, timestamps).
 * Used for observability to detect error rate patterns.
 */
function recordErrorMetric(errorCode: string, stackTrace?: string): void {
  const existing = errorMetrics.get(errorCode);
  const now = Date.now();

  if (existing) {
    existing.count++;
    existing.lastOccurrence = now;
    if (stackTrace) existing.lastStackTrace = stackTrace;
  } else {
    errorMetrics.set(errorCode, {
      count: 1,
      firstOccurrence: now,
      lastOccurrence: now,
      lastStackTrace: stackTrace,
    });
  }
}

/**
 * Get error metrics for a specific error code. Useful for dashboards
 * and monitoring integrations.
 */
export function getErrorMetrics(errorCode: string): ErrorMetric | undefined {
  return errorMetrics.get(errorCode);
}

/**
 * Get all error metrics. Useful for periodic reporting.
 */
export function getAllErrorMetrics(): Record<string, ErrorMetric> {
  const result: Record<string, ErrorMetric> = {};
  for (const [key, value] of errorMetrics.entries()) {
    result[key] = value;
  }
  return result;
}

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
 * Extract and sanitize stack trace from an error.
 * BA-040: Include stack traces for production debugging while filtering
 * out potentially sensitive file paths beyond the project root.
 */
export function extractStackTrace(error: Error): string[] | undefined {
  if (!error.stack) return undefined;

  const lines = error.stack.split("\n").slice(1); // Skip "Error: message" line
  const sanitized: string[] = [];

  for (const line of lines) {
    if (sanitized.length >= 5) break; // Limit stack depth to top 5 frames
    if (!line.trim()) continue;

    // Remove absolute paths and keep only relative paths/function info
    const sanitizedLine = line
      .replace(/\s*at\s+/, "at ")
      .replace(/\/[a-zA-Z0-9_/\-\.]+\//g, "./") // Collapse long paths
      .trim();

    if (sanitizedLine) sanitized.push(sanitizedLine);
  }

  return sanitized.length > 0 ? sanitized : undefined;
}

/**
 * Extract error code and category from an error.
 * BA-040: Categorize errors for better observability and debugging.
 */
export interface ErrorContext {
  code?: string;
  category?: string;
  duration?: number;
  retries?: number;
  [key: string]: unknown;
}

export function extractErrorContext(error: unknown): ErrorContext {
  if (!(error instanceof Error)) return {};

  const ctx: ErrorContext = {};
  const errorObj = error as Error & Record<string, unknown>;

  // Extract error code (common patterns)
  if (errorObj.code) {
    ctx.code = String(errorObj.code);
  }

  // Categorize by error type or message patterns
  if (error instanceof SyntaxError) {
    ctx.category = "syntax_error";
  } else if (error instanceof TypeError) {
    ctx.category = "type_error";
  } else if (error instanceof RangeError) {
    ctx.category = "range_error";
  } else if (errorObj.code === "ECONNREFUSED" || errorObj.code === "ECONNRESET") {
    ctx.category = "connection_error";
  } else if (errorObj.code === "ETIMEDOUT" || error.message.toLowerCase().includes("timeout")) {
    ctx.category = "timeout_error";
  } else if (error.message.toLowerCase().includes("pool")) {
    ctx.category = "pool_error";
  } else if (error.message.toLowerCase().includes("query")) {
    ctx.category = "query_error";
  }

  // Extract common fields set by handlers
  if (errorObj.duration !== undefined) ctx.duration = errorObj.duration;
  if (errorObj.retries !== undefined) ctx.retries = errorObj.retries;

  return ctx;
}

/**
 * Deeply redact a log argument: array/object containers are walked, and any
 * string that is a Stellar address or long opaque payload is masked. This is
 * applied to free-form arguments passed to the logger.
 *
 * BA-040: Enhanced to extract stack traces and error codes for observability.
 */
export function redact(
  arg: unknown,
  depth = 0,
  options: { includeStackTrace?: boolean; includeCode?: boolean } = {}
): unknown {
  const { includeStackTrace = true, includeCode = true } = options;

  if (depth > 6) return "<max-depth>";
  if (arg instanceof Error) {
    // Keep the essential, bounded error context with stack trace and code.
    const message = String(arg.message);
    const bounded =
      message.length > 256 ? `${message.slice(0, 256)}...(truncated)` : message;
    const code = (arg as Error & { code?: unknown }).code;
    const errorCtx = extractErrorContext(arg);

    const result: Record<string, unknown> = {
      name: arg.name,
      message: redactValue(bounded),
    };

    if (includeCode && (code !== undefined || errorCtx.code)) {
      result.code = redactValue(code ?? errorCtx.code);
    }

    if (includeStackTrace) {
      const stackTrace = extractStackTrace(arg);
      if (stackTrace) {
        result.stack = stackTrace;
      }
    }

    // Include additional error context if present
    if (errorCtx.category) result.category = errorCtx.category;
    if (errorCtx.duration !== undefined) result.duration = errorCtx.duration;
    if (errorCtx.retries !== undefined) result.retries = errorCtx.retries;

    return result;
  }
  if (typeof arg === "string") return redactValue(arg);
  if (Array.isArray(arg)) return arg.map((item) => redact(item, depth + 1, options));
  if (arg && typeof arg === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(arg as Record<string, unknown>)) {
      out[key] = redact(value, depth + 1, options);
    }
    return out;
  }
  return arg;
}

// ── Logger ──────────────────────────────────────────────────────────────────

export interface LoggerBindings {
  [key: string]: unknown;
}

/**
 * Options for error logging with enhanced observability (BA-040).
 */
export interface ErrorLogOptions {
  errorCode?: string;
  skipStackTrace?: boolean;
  duration?: number;
  retries?: number;
  [key: string]: unknown;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /**
   * Enhanced error logging with automatic error code detection, stack traces,
   * and metrics tracking (BA-040).
   */
  errorWithContext(message: string, error: Error, options?: ErrorLogOptions): void;
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
  private write(level: string, message: string, args: unknown[], errorCode?: string): void {
    // Redact free-form arguments so sensitive payloads never reach the log.
    const safeArgs = args.map((a) => redact(a));

    const structured: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      logger: this.id,
      msg: message,
      ...this.bindings,
    };

    // Include error code for better observability
    if (errorCode) {
      structured.errorCode = errorCode;
    }

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
    if (shouldLog(logKey("warn", message))) this.write("warn", message, args);
  }

  error(message: string, ...args: unknown[]): void {
    if (shouldLog(logKey("error", message))) {
      // Extract error code from arguments if present
      let errorCode: string | undefined;
      const processedArgs = args.map((arg) => {
        if (arg instanceof Error) {
          const ctx = extractErrorContext(arg);
          if (ctx.code) errorCode = String(ctx.code);
          else if (ctx.category) errorCode = ctx.category;
        }
        return arg;
      });
      this.write("error", message, processedArgs, errorCode);
      if (errorCode) recordErrorMetric(errorCode, undefined);
    }
  }

  /**
   * Enhanced error logging with automatic error code detection, stack traces,
   * and metrics tracking (BA-040).
   */
  errorWithContext(message: string, error: Error, options?: ErrorLogOptions): void {
    if (shouldLog(logKey("error", message))) {
      const errorCode = options?.errorCode || extractErrorContext(error).code || extractErrorContext(error).category || "UNKNOWN_ERROR";

      const errorData: Record<string, unknown> = {
        error: redact(error, 0, { includeStackTrace: !options?.skipStackTrace, includeCode: true }),
      };

      // Add any additional options
      if (options) {
        const { errorCode: _code, skipStackTrace: _skip, ...rest } = options;
        Object.assign(errorData, rest);
      }

      if (shouldLog(logKey("error", message))) {
        this.write("error", message, [errorData], errorCode);
      }

      // Record metrics for observability
      const stackTrace = !options?.skipStackTrace ? extractStackTrace(error)?.join("\n") : undefined;
      recordErrorMetric(errorCode, stackTrace);
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
  /**
   * BA-040: Enhanced transaction rollback logging with error code,
   * stack trace, and metrics.
   */
  logRollback(transactionId: string, error: Error, duration: number): void {
    const errorCtx = extractErrorContext(error);
    const errorCode = errorCtx.code || errorCtx.category || "TX_ROLLBACK";

    const log = {
      timestamp: new Date(),
      transactionId: redactValue(transactionId),
      action: "ROLLBACK",
      error: redact(error, 0, { includeStackTrace: true, includeCode: true }),
      duration: duration + "ms",
    };

    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "transaction_rollback",
      errorCode,
      ...log,
    }));

    recordErrorMetric(errorCode, extractStackTrace(error)?.join("\n"));
  }

  logCommit(transactionId: string, duration: number): void {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      msg: "transaction_commit",
      action: "COMMIT",
      transactionId: redactValue(transactionId),
      duration: duration + "ms",
    }));
  }
}

/**
 * Default application logger. Imported and used across the codebase.
 */
export const logger: Logger = new StructuredLogger("indexer");
