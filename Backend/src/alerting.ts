/**
 * Production alerting for the Kovara indexer (issue #683).
 *
 * The structured logger (BA-039/BA-042) already redacts, deduplicates and
 * counts errors, but everything it produces stays inside the process: an
 * operator learns about a production failure only if they happen to be reading
 * stdout. This module adds the missing half — a hook that turns critical
 * failures into something that pages a human.
 *
 * Three acceptance criteria drive the design:
 *
 * 1. **Critical failures trigger alerts.** `AlertManager.capture()` hands a
 *    fully-formed {@link AlertEvent} to every registered {@link AlertSink}.
 *    Two sinks ship in-tree: {@link SentrySink} (Sentry's `store` endpoint,
 *    driven straight from a DSN, so there is no SDK dependency) and
 *    {@link WebhookSink} for anything Slack/PagerDuty-shaped.
 *
 * 2. **Metadata carries enough context to investigate.** Every event carries a
 *    stable id, severity, the error code, a bounded stack, the originating
 *    logger's bindings (correlation id, ledger, subsystem…) and an explicit
 *    fingerprint. Values pass through the logger's existing redactors, so
 *    Stellar addresses and opaque payloads never reach an external service.
 *
 * 3. **Noise is filtered.** Four independent mechanisms, because alerting that
 *    cries wolf gets muted and then misses the real outage:
 *      - a severity threshold (`warning` events are not delivered by default);
 *      - an ignore-list of expected error codes (client mistakes, 4xx);
 *      - per-fingerprint suppression inside a rolling window;
 *      - a global delivery budget per window, with an explicit drop counter.
 *
 * Sinks are untrusted: a sink that throws, hangs or returns garbage is counted
 * and swallowed. Alerting must never take down the request or indexing path
 * that reported the original failure.
 */

import { randomUUID } from "crypto";
import { redact, redactValue, setErrorHook } from "./logger";
import type { LoggerBindings } from "./logger";
import { outboundRequestHeaders } from "./request-context";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Alert severities, ordered. `critical` is reserved for failures that make the
 * indexer unable to do its job; `error` is a real failure worth a page during
 * business hours; `warning` is context that is usually not worth interrupting
 * anyone for.
 */
export type AlertSeverity = "critical" | "error" | "warning";

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 3,
  error: 2,
  warning: 1,
};

/** A single alert, as delivered to sinks. */
export interface AlertEvent {
  /** Stable id for this occurrence, used to correlate with logs. */
  id: string;
  /** ISO timestamp of first capture for this fingerprint. */
  timestamp: string;
  severity: AlertSeverity;
  /** Short, human-readable summary. Already redacted. */
  message: string;
  /** Application error code (`err.code`) when present. */
  errorCode?: string;
  /** Error class name, e.g. `TypeError`. */
  errorName?: string;
  /** Bounded stack trace. */
  stack?: string;
  /** Correlation id / ledger / subsystem from the originating logger. */
  context: Record<string, unknown>;
  /**
   * Stable identity for grouping. Two occurrences of the same failure share a
   * fingerprint even when their ids differ, which is what makes suppression
   * and triage possible.
   */
  fingerprint: string;
  /** How many identical occurrences have been suppressed for this fingerprint. */
  suppressedCount: number;
}

/** Why a captured failure was not delivered. Surfaced for debugging and tests. */
export type DropReason =
  | "no-sinks"
  | "below-severity-threshold"
  | "ignored-code"
  | "sampled-out"
  | "duplicate"
  | "rate-limited"
  | "sink-failed";

/** The outcome of one `capture()` call. */
export interface CaptureResult {
  delivered: boolean;
  reason?: DropReason;
  event?: AlertEvent;
  /** Number of sinks that accepted the event. */
  deliveredTo: number;
}

/** A destination for alerts. Implementations must not throw. */
export interface AlertSink {
  /** Stable name, used in logs and in the failure counter. */
  readonly name: string;
  /** Deliver one alert. Rejections are caught and counted by the manager. */
  send(event: AlertEvent): Promise<void> | void;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Alerting configuration. Alerting is disabled unless at least one sink exists. */
export interface AlertingConfig {
  /** Minimum severity that is delivered. */
  severityThreshold: AlertSeverity;
  /** Error codes that never alert (expected failures such as validation). */
  ignoreCodes: string[];
  /**
   * How long an identical fingerprint is suppressed after it fires, in ms.
   * `0` disables suppression.
   */
  dedupWindowMs: number;
  /** Maximum alerts delivered per {@link rateLimitWindowMs}, across all events. */
  maxAlertsPerWindow: number;
  /** Length of the delivery-budget window, in ms. */
  rateLimitWindowMs: number;
  /**
   * Fraction of would-be alerts actually delivered, in [0, 1]. `1` sends
   * everything. Applied *before* the budget so sampling is predictable.
   */
  sampleRate: number;
  /** Per-sink timeout, in ms. A sink that exceeds it is abandoned. */
  sinkTimeoutMs: number;
}

export const DEFAULT_ALERTING_CONFIG: AlertingConfig = {
  severityThreshold: "error",
  ignoreCodes: [],
  dedupWindowMs: 5 * 60_000,
  maxAlertsPerWindow: 20,
  rateLimitWindowMs: 60_000,
  sampleRate: 1,
  sinkTimeoutMs: 5_000,
};

/** Ingestion-lag alert settings (BE-60). */
export interface LagAlertConfig {
  /** Lag, in ledgers, above which ingestion counts as behind. */
  thresholdLedgers: number;
  /** How long the lag must stay above the threshold before alerting, in ms. */
  sustainedMs: number;
}

export const DEFAULT_LAG_ALERT_CONFIG: LagAlertConfig = {
  thresholdLedgers: 100,
  sustainedMs: 5 * 60_000,
};

/** Raw environment values consumed by {@link loadAlertingConfig}. */
export type AlertingEnv = Record<string, string | undefined>;

function parseNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseSeverity(raw: string | undefined, fallback: AlertSeverity): AlertSeverity {
  if (raw === "critical" || raw === "error" || raw === "warning") return raw;
  return fallback;
}

/**
 * Parse alerting configuration from the environment.
 *
 * Every value is optional and falls back to a documented default; alerting is
 * simply inert when no sink is configured, so a deployment that does not opt in
 * behaves exactly as before. Out-of-range values fall back rather than throwing
 * so a typo in one alert setting can never stop the indexer from booting.
 */
export function loadAlertingConfig(env: AlertingEnv = process.env): AlertingConfig {
  return {
    severityThreshold: parseSeverity(
      env.ALERT_SEVERITY_THRESHOLD,
      DEFAULT_ALERTING_CONFIG.severityThreshold
    ),
    ignoreCodes: parseList(env.ALERT_IGNORE_CODES),
    dedupWindowMs: parseNumber(
      env.ALERT_DEDUP_WINDOW_MS,
      DEFAULT_ALERTING_CONFIG.dedupWindowMs,
      0,
      24 * 60 * 60_000
    ),
    maxAlertsPerWindow: parseNumber(
      env.ALERT_MAX_PER_WINDOW,
      DEFAULT_ALERTING_CONFIG.maxAlertsPerWindow,
      0,
      10_000
    ),
    rateLimitWindowMs: parseNumber(
      env.ALERT_RATE_LIMIT_WINDOW_MS,
      DEFAULT_ALERTING_CONFIG.rateLimitWindowMs,
      1_000,
      24 * 60 * 60_000
    ),
    sampleRate: parseNumber(
      env.ALERT_SAMPLE_RATE,
      DEFAULT_ALERTING_CONFIG.sampleRate,
      0,
      1
    ),
    sinkTimeoutMs: parseNumber(
      env.ALERT_SINK_TIMEOUT_MS,
      DEFAULT_ALERTING_CONFIG.sinkTimeoutMs,
      100,
      120_000
    ),
  };
}

/**
 * Read the lag alert settings from `INGESTION_LAG_THRESHOLD_LEDGERS` and
 * `INGESTION_LAG_SUSTAIN_MS`. Like the other alert settings, out-of-range or
 * malformed values fall back to the default instead of blocking startup.
 */
export function loadLagAlertConfig(env: AlertingEnv = process.env): LagAlertConfig {
  return {
    thresholdLedgers: Math.floor(
      parseNumber(env.INGESTION_LAG_THRESHOLD_LEDGERS, DEFAULT_LAG_ALERT_CONFIG.thresholdLedgers, 1, 10_000_000)
    ),
    sustainedMs: Math.floor(
      parseNumber(env.INGESTION_LAG_SUSTAIN_MS, DEFAULT_LAG_ALERT_CONFIG.sustainedMs, 0, 24 * 60 * 60_000)
    ),
  };
}

// ── Fingerprinting ───────────────────────────────────────────────────────────

/**
 * Derive a stable identity for a failure.
 *
 * Prefers the application error code, because that is what a human triages on;
 * falls back to the error class and first line of the message. Deliberately
 * excludes correlation ids, timestamps and stack frames — those differ on every
 * occurrence and would defeat suppression.
 */
export function fingerprintFor(
  message: string,
  errorCode: string | undefined,
  errorName: string | undefined
): string {
  const head = message.split("\n", 1)[0].trim().slice(0, 120);
  return [errorCode ?? "<no-code>", errorName ?? "<no-name>", head].join("|");
}

// ── Sinks ────────────────────────────────────────────────────────────────────

/**
 * #684: The request id the originating failure was logged under, if any.
 *
 * `installLoggerAlerting` folds the logger bindings into the alert context, so
 * an alert raised while handling an HTTP request carries its request id and can
 * forward it to the sink. Failures with no request (streaming, boot) simply
 * have no id to propagate.
 */
function requestIdFromContext(event: AlertEvent): string | undefined {
  const candidate = event.context?.correlationId ?? event.context?.requestId;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

/** Minimal shape of a Sentry DSN we depend on. */
export interface SentryDsn {
  publicKey: string;
  host: string;
  projectId: string;
  path: string;
}

/**
 * Parse a Sentry DSN (`<protocol>://<key>@<host>[/<path>]/<projectId>`).
 *
 * Returns `undefined` for anything unparsable so a bad DSN disables Sentry
 * rather than throwing during startup.
 */
export function parseSentryDsn(dsn: string): SentryDsn | undefined {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }
  const publicKey = url.username;
  const projectId = url.pathname.replace(/^\/+/, "").split("/").pop() ?? "";
  if (!publicKey || !url.hostname || !projectId) return undefined;
  const path = url.pathname.replace(/\/[^/]*$/, "");
  return { publicKey, host: url.hostname, projectId, path };
}

/** The subset of `fetch` this module needs, so tests can inject a stub. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{ ok: boolean; status: number }>;

/**
 * Reports alerts to Sentry over its `store` HTTP endpoint.
 *
 * Sentry's own SDK is deliberately not used: this backend has no runtime
 * dependencies beyond `express`/`pg`, and the store endpoint accepts a plain
 * JSON event authenticated with the DSN's public key. That keeps the alerting
 * feature dependency-free, which matters for an indexer that must boot in
 * constrained environments.
 */
export class SentrySink implements AlertSink {
  readonly name = "sentry";

  constructor(
    private readonly dsn: SentryDsn,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly environment?: string,
    private readonly release?: string
  ) {}

  /** URL of the store endpoint for this DSN. */
  get endpoint(): string {
    const prefix = this.dsn.path ? `${this.dsn.path}/api` : "/api";
    return `https://${this.dsn.host}${prefix}/${this.dsn.projectId}/store/`;
  }

  async send(event: AlertEvent): Promise<void> {
    const payload = {
      event_id: event.id.replace(/-/g, "").slice(0, 32),
      timestamp: new Date(event.timestamp).getTime() / 1000,
      platform: "node",
      level: event.severity === "critical" ? "fatal" : "error",
      logger: "kovara.alerting",
      culprit: event.message,
      message: { formatted: event.message },
      fingerprint: [event.fingerprint],
      exception: {
        values: [
          {
            type: event.errorName ?? "Error",
            value: event.message,
            ...(event.stack ? { stacktrace: { frames: parseFrames(event.stack) } } : {}),
          },
        ],
      },
      extra: {
        errorCode: event.errorCode,
        context: event.context,
        suppressedCount: event.suppressedCount,
      },
      ...(this.environment ? { environment: this.environment } : {}),
      ...(this.release ? { release: this.release } : {}),
      tags: {
        severity: event.severity,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      },
    };

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: outboundRequestHeaders(
        {
          "Content-Type": "application/json",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=kovara-indexer/1.0, sentry_key=${this.dsn.publicKey}`,
        },
        requestIdFromContext(event)
      ),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Sentry rejected alert: HTTP ${response.status}`);
    }
  }
}

/** Convert a V8 stack string into Sentry's frame shape. */
function parseFrames(stack: string): Array<{ filename: string; function?: string; lineno?: number }> {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => {
      const match = line.trim().match(/^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (!match) return { filename: line.trim() };
      return {
        function: match[1],
        filename: match[2],
        lineno: Number.parseInt(match[3], 10),
      };
    })
    .filter((frame) => frame.filename.length > 0);
}

/** POSTs each alert as JSON to an arbitrary URL (Slack, PagerDuty, etc.). */
export class WebhookSink implements AlertSink {
  readonly name: string;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    name = "webhook"
  ) {
    this.name = name;
  }

  async send(event: AlertEvent): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: outboundRequestHeaders(
        { "Content-Type": "application/json" },
        requestIdFromContext(event)
      ),
      body: JSON.stringify({
        text: `[${event.severity}] ${event.message}`,
        event,
      }),
    });
    if (!response.ok) {
      throw new Error(`Webhook rejected alert: HTTP ${response.status}`);
    }
  }
}

// ── Manager ──────────────────────────────────────────────────────────────────

/** A clock seam so tests can control dedup and rate-limit windows. */
export type NowFn = () => number;

/** Hook invoked for every delivered alert; used to bridge into the logger. */
export type AlertObserver = (event: AlertEvent, result: CaptureResult) => void;

/**
 * Owns filtering, suppression, the delivery budget and sink dispatch.
 *
 * Construct one per process; it is cheap and holds no I/O of its own.
 */
export class AlertManager {
  private readonly sinks: AlertSink[] = [];
  private config: AlertingConfig;
  private readonly lastFiredAt = new Map<string, number>();
  private windowStartedAt: number;
  private deliveredInWindow = 0;
  private readonly now: NowFn;
  private observer?: AlertObserver;

  /** Counters for every drop reason, for health endpoints and tests. */
  readonly stats = {
    captured: 0,
    delivered: 0,
    dropped: 0,
    suppressed: 0,
    sinkFailures: 0,
    byReason: new Map<DropReason, number>(),
  };

  constructor(config: Partial<AlertingConfig> = {}, now: NowFn = Date.now) {
    this.config = { ...DEFAULT_ALERTING_CONFIG, ...config };
    this.now = now;
    this.windowStartedAt = now();
  }

  /** Register a sink. Returns `this` so calls can be chained at startup. */
  addSink(sink: AlertSink): this {
    this.sinks.push(sink);
    return this;
  }

  /** Replace the active configuration, e.g. after a config reload. */
  configure(config: Partial<AlertingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Observe every capture, delivered or not. Used for logging the decisions. */
  setObserver(observer: AlertObserver | undefined): void {
    this.observer = observer;
  }

  /** Current configuration (a copy — the manager's internals stay private). */
  getConfig(): AlertingConfig {
    return { ...this.config, ignoreCodes: [...this.config.ignoreCodes] };
  }

  /** True when at least one sink is registered. */
  get enabled(): boolean {
    return this.sinks.length > 0;
  }

  /** Reset suppression, budget and counters. Intended for tests. */
  reset(): void {
    this.lastFiredAt.clear();
    this.windowStartedAt = this.now();
    this.deliveredInWindow = 0;
    this.stats.captured = 0;
    this.stats.delivered = 0;
    this.stats.dropped = 0;
    this.stats.suppressed = 0;
    this.stats.sinkFailures = 0;
    this.stats.byReason.clear();
  }

  private drop(reason: DropReason, event?: AlertEvent): CaptureResult {
    this.stats.dropped += 1;
    this.stats.byReason.set(reason, (this.stats.byReason.get(reason) ?? 0) + 1);
    const result: CaptureResult = { delivered: false, reason, event, deliveredTo: 0 };
    this.observer?.(event as AlertEvent, result);
    return result;
  }

  private rollWindowIfNeeded(): void {
    const now = this.now();
    if (now - this.windowStartedAt >= this.config.rateLimitWindowMs) {
      this.windowStartedAt = now;
      this.deliveredInWindow = 0;
    }
  }

  /**
   * Capture a production failure.
   *
   * @param severity  How bad this is. Defaults to `error`.
   * @param message   Short summary. Redacted before it leaves the process.
   * @param error     The originating error, when there is one. Its `code`, name
   *                  and bounded stack become part of the alert.
   * @param context   Investigation context (correlation id, ledger, …).
   */
  capture(
    severity: AlertSeverity,
    message: string,
    error?: unknown,
    context: LoggerBindings = {}
  ): CaptureResult {
    this.stats.captured += 1;
    this.rollWindowIfNeeded();

    const err = error instanceof Error ? error : undefined;
    const rawCode = err ? (err as Error & { code?: unknown }).code : undefined;
    const errorCode = rawCode === undefined ? undefined : String(rawCode);
    const errorName = err?.name;

    // Filtering happens before any work is done on the payload.
    if (this.sinks.length === 0) {
      return this.drop("no-sinks");
    }
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[this.config.severityThreshold]) {
      return this.drop("below-severity-threshold");
    }
    if (errorCode !== undefined && this.config.ignoreCodes.includes(errorCode)) {
      return this.drop("ignored-code");
    }
    if (this.config.sampleRate < 1) {
      // Deterministic per fingerprint, so every occurrence of the same failure
      // makes the same decision instead of a fraction trickling through.
      const hash = fnv1a32(this.fingerprintFor(message, errorCode, errorName));
      if (hash / 0xffffffff > this.config.sampleRate) {
        return this.drop("sampled-out");
      }
    }

    const fingerprint = this.fingerprintFor(message, errorCode, errorName);

    // Per-fingerprint suppression: report once per window, then stay quiet but
    // keep counting so the alert can say how noisy it was.
    const lastFired = this.lastFiredAt.get(fingerprint);
    const now = this.now();
    if (this.config.dedupWindowMs > 0 && lastFired !== undefined && now - lastFired < this.config.dedupWindowMs) {
      this.stats.suppressed += 1;
      return this.drop("duplicate", this.buildEvent(severity, message, error, context, fingerprint, this.stats.suppressed));
    }

    if (this.deliveredInWindow >= this.config.maxAlertsPerWindow) {
      return this.drop("rate-limited", this.buildEvent(severity, message, error, context, fingerprint, 0));
    }

    this.lastFiredAt.set(fingerprint, now);
    const event = this.buildEvent(severity, message, error, context, fingerprint, 0);
    this.deliveredInWindow += 1;

    void this.dispatch(event);
    return { delivered: true, event, deliveredTo: this.sinks.length };
  }

  private fingerprintFor(
    message: string,
    errorCode: string | undefined,
    errorName: string | undefined
  ): string {
    return fingerprintFor(String(redactValue(message)), errorCode, errorName);
  }

  private buildEvent(
    severity: AlertSeverity,
    message: string,
    error: unknown,
    context: LoggerBindings,
    fingerprint: string,
    suppressedCount: number
  ): AlertEvent {
    // The logger's redactor is the single source of truth for what may leave
    // the process, so alerts inherit its Stellar-address and payload masking.
    const safeMessage = String(redactValue(message));
    const safeContext = redact(context) as Record<string, unknown>;
    const safeError = error instanceof Error ? (redact(error) as Record<string, unknown>) : undefined;
    const rawCode = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;

    return {
      id: randomUUID(),
      timestamp: new Date(this.now()).toISOString(),
      severity,
      message: safeMessage,
      ...(rawCode === undefined ? {} : { errorCode: String(rawCode) }),
      ...(error instanceof Error ? { errorName: error.name } : {}),
      ...(typeof safeError?.stack === "string" ? { stack: safeError.stack } : {}),
      context: safeContext,
      fingerprint,
      suppressedCount,
    };
  }

  /** Deliver to every sink, isolating each one. Never rejects. */
  private async dispatch(event: AlertEvent): Promise<void> {
    const results = await Promise.allSettled(
      this.sinks.map(async (sink) => {
        await withTimeout(
          Promise.resolve(sink.send(event)),
          this.config.sinkTimeoutMs,
          sink.name
        );
      })
    );

    const failures = results.filter((r) => r.status === "rejected").length;
    if (failures > 0) {
      this.stats.sinkFailures += failures;
    }
    this.stats.delivered += 1;
    if (this.observer && failures > 0) {
      this.observer(event, { delivered: false, reason: "sink-failed", event, deliveredTo: this.sinks.length - failures });
    }
  }
}

/** Resolve after `ms`, rejecting so a hung sink cannot stall the process. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
    // Do not hold the event loop open for a timer that only guards a timeout.
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** FNV-1a 32-bit, so sampling decisions are stable across processes. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ── Process-wide wiring ──────────────────────────────────────────────────────

/** The manager the application uses. Inert until sinks are registered. */
export const alertManager = new AlertManager();

/** Where the lag monitor currently stands. */
export type IngestionLagState = "ok" | "breaching" | "alerting";

/**
 * Alerts when ingestion stays behind the chain for a sustained period (BE-60).
 *
 * Call {@link observe} each time the ingested and chain heads are known. A
 * single spike above the threshold is only `breaching`; the alert fires once
 * the lag has stayed above it continuously for `sustainedMs`, and fires once
 * per episode. Dropping back to the threshold or below clears the episode, so a
 * later breach starts a fresh timer and can alert again.
 */
export class IngestionLagMonitor {
  private breachedSince: number | null = null;
  private alerted = false;

  constructor(
    private readonly manager: Pick<AlertManager, "capture">,
    private readonly config: LagAlertConfig = DEFAULT_LAG_ALERT_CONFIG,
    private readonly now: NowFn = Date.now
  ) {}

  /** Lag in ledgers; never negative if the ingested head is momentarily ahead. */
  static lag(chainHeadLedger: number, ingestedLedger: number): number {
    return Math.max(0, chainHeadLedger - ingestedLedger);
  }

  observe(chainHeadLedger: number, ingestedLedger: number): IngestionLagState {
    const lag = IngestionLagMonitor.lag(chainHeadLedger, ingestedLedger);
    const t = this.now();

    if (lag <= this.config.thresholdLedgers) {
      if (this.alerted) {
        // Recovered; recorded at warning severity so it shows in logs and stats
        // without paging anyone.
        this.manager.capture("warning", "ingestion lag recovered", undefined, {
          lagLedgers: lag,
          thresholdLedgers: this.config.thresholdLedgers,
        });
      }
      this.breachedSince = null;
      this.alerted = false;
      return "ok";
    }

    if (this.breachedSince === null) this.breachedSince = t;
    const breachedForMs = t - this.breachedSince;

    if (breachedForMs >= this.config.sustainedMs) {
      if (!this.alerted) {
        this.alerted = true;
        this.manager.capture("error", "ingestion lag exceeded threshold for a sustained period", undefined, {
          lagLedgers: lag,
          thresholdLedgers: this.config.thresholdLedgers,
          breachedForMs,
          sustainedMs: this.config.sustainedMs,
        });
      }
      return "alerting";
    }
    return "breaching";
  }
}

/**
 * Key a caller can set on `logger.error` arguments to raise one alert's
 * severity above the default.
 *
 * @example
 *   logger.error("db_unreachable", { err, alertSeverity: "critical" });
 */
export const ALERT_SEVERITY_FIELD = "alertSeverity";

/**
 * Route every `logger.error` line into `manager`.
 *
 * The indexer already reports real production failures through `logger.error`
 * (stream handler errors, replay failures, schema drift…), so hooking the logger
 * gives alerting coverage of every existing and future error site without
 * touching each call site. Warnings are intentionally not hooked: at default
 * settings they sit below the severity threshold, and routing them would only
 * add cost.
 *
 * @returns A disposer that removes the hook, so tests can restore the logger.
 */
export function installLoggerAlerting(
  manager: AlertManager = alertManager
): () => void {
  setErrorHook((message, args, bindings) => {
    // A caller may escalate severity via the args bag; strip the marker so it
    // does not leak into the alert context.
    let severity: AlertSeverity = "error";
    let context: Record<string, unknown> = {};
    for (const arg of args) {
      if (arg && typeof arg === "object" && !Array.isArray(arg)) {
        const record = arg as Record<string, unknown>;
        const requested = record[ALERT_SEVERITY_FIELD];
        if (requested === "critical" || requested === "warning" || requested === "error") {
          severity = requested;
        }
        const { [ALERT_SEVERITY_FIELD]: _ignored, ...rest } = record;
        context = { ...context, ...rest };
      }
    }

    // Alert on the Error itself, not the object that carries it: the error's
    // `code` is what the manager reads for classification and the alert
    // metadata, and it is nested one level deep in the usual
    // `logger.error(msg, { err })` shape.
    const error = findError(args);

    manager.capture(severity, message, error, { ...bindings, ...context });
  });

  return () => setErrorHook(undefined);
}

/** Find the first `Error` in the log args, looking one level into objects. */
function findError(args: unknown[]): Error | undefined {
  for (const arg of args) {
    if (arg instanceof Error) return arg;
    if (arg && typeof arg === "object" && !Array.isArray(arg)) {
      for (const value of Object.values(arg as Record<string, unknown>)) {
        if (value instanceof Error) return value;
      }
    }
  }
  return undefined;
}

/**
 * Build a Sentry sink from a DSN, or `undefined` when the DSN is absent or
 * unparsable. Exported so startup code stays a single line per sink.
 */
export function sentrySinkFromDsn(
  dsn: string | undefined,
  fetchImpl?: FetchLike
): SentrySink | undefined {
  if (!dsn) return undefined;
  const parsed = parseSentryDsn(dsn);
  if (!parsed) return undefined;
  return fetchImpl ? new SentrySink(parsed, fetchImpl) : new SentrySink(parsed);
}

/** A fetch stub that records what would have been sent. Useful in tests. */
export function recordingFetch(
  calls: Array<{ url: string; body: string; headers: Record<string, string> }>
): FetchLike {
  return async (url, init) => {
    calls.push({ url, body: init?.body ?? "", headers: init?.headers ?? {} });
    return { ok: true, status: 200 };
  };
}

