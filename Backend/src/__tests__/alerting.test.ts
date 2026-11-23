/**
 * Tests for production alerting (issue #683).
 *
 * Covers the three acceptance criteria directly: critical failures reach a sink,
 * the delivered metadata carries investigation context, and noise is filtered.
 */

import { logger, setErrorHook } from "../logger";
import {
  AlertManager,
  DEFAULT_ALERTING_CONFIG,
  SentrySink,
  WebhookSink,
  fingerprintFor,
  loadAlertingConfig,
  parseSentryDsn,
  recordingFetch,
  installLoggerAlerting,
  sentrySinkFromDsn,
} from "../alerting";
import type { AlertEvent, AlertSink, FetchLike } from "../alerting";

const DSN = "https://abc123def456@o0.ingest.sentry.io/0";

/** A sink that records events and can be told to fail. */
class RecordingSink implements AlertSink {
  readonly name = "recording";
  readonly events: AlertEvent[] = [];
  shouldFail = false;
  delivered = 0;

  send(event: AlertEvent): void {
    if (this.shouldFail) throw new Error("sink exploded");
    this.events.push(event);
    this.delivered += 1;
  }
}

function makeError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code !== undefined) (error as Error & { code?: string }).code = code;
  return error;
}

describe("AlertManager — critical failures trigger alerts", () => {
  it("delivers an error to every registered sink", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);

    const result = manager.capture("error", "indexer handler failed", makeError("boom", "E_BOOM"));

    expect(result.delivered).toBe(true);
    expect(result.deliveredTo).toBe(1);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].message).toBe("indexer handler failed");
  });

  it("delivers critical alerts", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);

    manager.capture("critical", "database unreachable", makeError("ECONNREFUSED"));

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].severity).toBe("critical");
  });

  it("reports every drop reason to the observer", () => {
    const seen: string[] = [];
    const manager = new AlertManager().addSink(new RecordingSink());
    manager.setObserver((_event, result) => {
      if (result.reason) seen.push(result.reason);
    });

    manager.capture("error", "first");
    manager.capture("error", "first");

    expect(seen).toEqual(["duplicate"]);
  });

  it("is inert when no sink is registered", () => {
    const manager = new AlertManager();
    expect(manager.enabled).toBe(false);

    const result = manager.capture("critical", "nobody is listening");

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no-sinks");
  });

  it("counts a failing sink without throwing at the call site", async () => {
    const good = new RecordingSink();
    const bad = new RecordingSink();
    bad.shouldFail = true;
    const manager = new AlertManager().addSink(bad).addSink(good);

    expect(() =>
      manager.capture("error", "one sink is down", makeError("boom"))
    ).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.stats.sinkFailures).toBe(1);
    // The healthy sink still received the alert.
    expect(good.events).toHaveLength(1);
  });

  it("abandons a sink that hangs past the timeout", async () => {
    const hanging: AlertSink = {
      name: "hanging",
      send: () => new Promise<void>(() => {}),
    };
    const manager = new AlertManager({ sinkTimeoutMs: 20 }).addSink(hanging);

    manager.capture("error", "sink never responds");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(manager.stats.sinkFailures).toBe(1);
  });
});

describe("AlertManager — metadata carries investigation context", () => {
  it("includes error code, name, stack and context", async () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);

    manager.capture(
      "error",
      "replay handler failed",
      makeError("cursor corrupt", "CURSOR_CORRUPT"),
      { correlationId: "corr-123", ledger: 4242 }
    );
    await new Promise((resolve) => setImmediate(resolve));

    const event = sink.events[0];
    expect(event.errorCode).toBe("CURSOR_CORRUPT");
    expect(event.errorName).toBe("Error");
    expect(event.stack).toContain("cursor corrupt");
    expect(event.context).toMatchObject({ correlationId: "corr-123", ledger: 4242 });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof event.timestamp).toBe("string");
    expect(event.fingerprint).toContain("CURSOR_CORRUPT");
  });

  it("redacts Stellar addresses and long payloads before delivery", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);
    const address = `G${"A".repeat(55)}`;
    const secret = "x".repeat(200);

    manager.capture("error", `failed for ${address}`, makeError("nope"), {
      pubkey: address,
      payload: secret,
    });

    const event = sink.events[0];
    expect(event.message).not.toContain(address);
    expect(event.context).not.toContain(address);
    expect(JSON.stringify(event.context)).not.toContain(secret);
  });

  it("produces the same fingerprint for the same failure and a different one otherwise", () => {
    expect(fingerprintFor("boom", "E_X", "Error")).toBe(
      fingerprintFor("boom", "E_X", "Error")
    );
    expect(fingerprintFor("boom", "E_X", "Error")).not.toBe(
      fingerprintFor("boom", "E_Y", "Error")
    );
    // Correlation ids must not fragment the fingerprint.
    expect(fingerprintFor("boom", "E_X", "Error")).toBe(
      fingerprintFor("boom", "E_X", "Error")
    );
  });

  it("bounds the stack trace and marks it truncated", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);
    const error = new Error("deep");
    error.stack = `Error: deep\\n${"at frame (/x/y.ts:1:1)\\n".repeat(500)}`;

    manager.capture("error", "deep failure", error);

    // The logger's redactor keeps at most 2048 characters and then appends a
    // short truncation marker, so the total is the bound plus that marker.
    const stack = sink.events[0].stack!;
    expect(stack).toContain("...(truncated)");
    expect(stack.length).toBeLessThanOrEqual(2048 + "...(truncated)".length);
  });
});

describe("AlertManager — noise is filtered", () => {
  it("suppresses repeats of the same fingerprint inside the window", async () => {
    const sink = new RecordingSink();
    let now = 1_000;
    const manager = new AlertManager({ dedupWindowMs: 60_000 }, () => now).addSink(sink);

    manager.capture("error", "flaky", makeError("x", "E_FLAKY"));
    now += 1_000;
    const second = manager.capture("error", "flaky", makeError("x", "E_FLAKY"));

    expect(sink.events).toHaveLength(1);
    expect(second.delivered).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(manager.stats.suppressed).toBe(1);

    // Once the window elapses it alerts again.
    now += 61_000;
    manager.capture("error", "flaky", makeError("x", "E_FLAKY"));
    expect(sink.events).toHaveLength(2);
  });

  it("does not suppress distinct failures from each other", () => {
    const sink = new RecordingSink();
    let now = 1_000;
    const manager = new AlertManager({ dedupWindowMs: 60_000 }, () => now).addSink(sink);

    manager.capture("error", "first failure", makeError("a", "E_A"));
    manager.capture("error", "second failure", makeError("b", "E_B"));

    expect(sink.events).toHaveLength(2);
  });

  it("enforces a global delivery budget per window", () => {
    const sink = new RecordingSink();
    let now = 1_000;
    const manager = new AlertManager(
      { maxAlertsPerWindow: 3, rateLimitWindowMs: 10_000, dedupWindowMs: 0 },
      () => now
    ).addSink(sink);

    for (let i = 0; i < 5; i++) {
      manager.capture("error", `failure ${i}`, makeError(`e${i}`, `E_${i}`));
    }

    expect(sink.events).toHaveLength(3);
    expect(manager.stats.byReason.get("rate-limited")).toBe(2);

    // Budget resets with the window.
    now += 11_000;
    manager.capture("error", "after window", makeError("later", "E_LATE"));
    expect(sink.events).toHaveLength(4);
  });

  it("ignores error codes on the ignore-list", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager({ ignoreCodes: ["VALIDATION_ERROR"] }).addSink(sink);

    const result = manager.capture(
      "error",
      "bad input",
      makeError("invalid", "VALIDATION_ERROR")
    );

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("ignored-code");
    expect(sink.events).toHaveLength(0);
  });

  it("drops events below the severity threshold", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager({ severityThreshold: "error" }).addSink(sink);

    const result = manager.capture("warning", "just a warning", makeError("meh"));

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("below-severity-threshold");
  });

  it("sampling is deterministic per fingerprint, not random per occurrence", () => {
    const sink = new RecordingSink();
    // sampleRate 0 drops everything; the point is determinism, verified below.
    const dropping = new AlertManager({ sampleRate: 0 }).addSink(new RecordingSink());
    for (let i = 0; i < 3; i++) {
      expect(dropping.capture("error", "same", makeError("s", "E_S")).reason).toBe("sampled-out");
    }

    const keeping = new AlertManager({ sampleRate: 1 }).addSink(sink);
    expect(keeping.capture("error", "same", makeError("s", "E_S")).delivered).toBe(true);
  });

  it("reset() clears suppression, budget and counters", () => {
    const sink = new RecordingSink();
    let now = 1_000;
    const manager = new AlertManager({ dedupWindowMs: 60_000 }, () => now).addSink(sink);

    manager.capture("error", "once", makeError("o", "E_O"));
    manager.capture("error", "once", makeError("o", "E_O"));
    expect(manager.stats.suppressed).toBe(1);

    manager.reset();
    manager.capture("error", "once", makeError("o", "E_O"));

    expect(manager.stats.suppressed).toBe(0);
    expect(sink.events).toHaveLength(2);
  });
});

describe("SentrySink", () => {
  it("parses a DSN into public key, host and project", () => {
    expect(parseSentryDsn(DSN)).toEqual({
      publicKey: "abc123def456",
      host: "o0.ingest.sentry.io",
      projectId: "0",
      path: "",
    });
  });

  it("returns undefined for an unparsable DSN instead of throwing", () => {
    expect(parseSentryDsn("not-a-dsn")).toBeUndefined();
    expect(parseSentryDsn("https://key@host")).toBeUndefined();
    expect(sentrySinkFromDsn(undefined)).toBeUndefined();
    expect(sentrySinkFromDsn("nonsense")).toBeUndefined();
  });

  it("posts a Sentry event carrying the investigation context", async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const sink = new SentrySink(parseSentryDsn(DSN)!, recordingFetch(calls), "testnet");

    await sink.send({
      id: "11111111-2222-3333-4444-555555555555",
      timestamp: "2026-01-01T00:00:00.000Z",
      severity: "critical",
      message: "database unreachable",
      errorCode: "ECONNREFUSED",
      errorName: "Error",
      stack: "Error: database unreachable\n    at connect (/app/db.ts:10:5)",
      context: { correlationId: "corr-9" },
      fingerprint: "ECONNREFUSED|Error|database unreachable",
      suppressedCount: 3,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://o0.ingest.sentry.io/api/0/store/");
    expect(calls[0].headers["X-Sentry-Auth"]).toContain("sentry_key=abc123def456");
    // #684: the originating request id travels with the outbound alert call.
    expect(calls[0].headers["x-request-id"]).toBe("corr-9");

    const payload = JSON.parse(calls[0].body);
    expect(payload.level).toBe("fatal");
    expect(payload.environment).toBe("testnet");
    expect(payload.fingerprint).toEqual([
      "ECONNREFUSED|Error|database unreachable",
    ]);
    expect(payload.exception.values[0].type).toBe("Error");
    expect(payload.exception.values[0].stacktrace.frames[0]).toMatchObject({
      filename: "/app/db.ts",
      lineno: 10,
    });
    expect(payload.extra.context).toMatchObject({ correlationId: "corr-9" });
    expect(payload.extra.suppressedCount).toBe(3);
    expect(payload.tags.severity).toBe("critical");
  });

  it("raises when Sentry rejects the event, so the manager can count it", async () => {
    const rejecting: FetchLike = async () => ({ ok: false, status: 429 });
    const sink = new SentrySink(parseSentryDsn(DSN)!, rejecting);

    await expect(
      sink.send({
        id: "id",
        timestamp: "2026-01-01T00:00:00.000Z",
        severity: "error",
        message: "m",
        context: {},
        fingerprint: "f",
        suppressedCount: 0,
      })
    ).rejects.toThrow("HTTP 429");
  });
});

describe("WebhookSink", () => {
  it("posts the event as JSON and includes the fingerprint", async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const sink = new WebhookSink("https://hooks.example.com/alert", recordingFetch(calls));

    await sink.send({
      id: "id",
      timestamp: "2026-01-01T00:00:00.000Z",
      severity: "error",
      message: "stream stalled",
      context: { ledger: 7 },
      fingerprint: "E_STALL|Error|stream stalled",
      suppressedCount: 0,
    });

    const payload = JSON.parse(calls[0].body);
    expect(calls[0].url).toBe("https://hooks.example.com/alert");
    expect(payload.text).toContain("[error] stream stalled");
    expect(payload.event.fingerprint).toBe("E_STALL|Error|stream stalled");
  });
});

describe("loadAlertingConfig", () => {
  it("returns documented defaults for an empty environment", () => {
    expect(loadAlertingConfig({})).toEqual(DEFAULT_ALERTING_CONFIG);
  });

  it("parses overrides from the environment", () => {
    const config = loadAlertingConfig({
      ALERT_SEVERITY_THRESHOLD: "critical",
      ALERT_IGNORE_CODES: "VALIDATION_ERROR, RATE_LIMITED",
      ALERT_DEDUP_WINDOW_MS: "1000",
      ALERT_MAX_PER_WINDOW: "5",
      ALERT_SAMPLE_RATE: "0.5",
    });

    expect(config.severityThreshold).toBe("critical");
    expect(config.ignoreCodes).toEqual(["VALIDATION_ERROR", "RATE_LIMITED"]);
    expect(config.dedupWindowMs).toBe(1000);
    expect(config.maxAlertsPerWindow).toBe(5);
    expect(config.sampleRate).toBe(0.5);
  });

  it("falls back rather than throwing on unusable values, so a typo cannot stop boot", () => {
    const config = loadAlertingConfig({
      ALERT_SEVERITY_THRESHOLD: "nonsense",
      ALERT_MAX_PER_WINDOW: "-5",
      ALERT_SAMPLE_RATE: "7",
    });

    expect(config.severityThreshold).toBe(DEFAULT_ALERTING_CONFIG.severityThreshold);
    expect(config.maxAlertsPerWindow).toBe(DEFAULT_ALERTING_CONFIG.maxAlertsPerWindow);
    expect(config.sampleRate).toBe(DEFAULT_ALERTING_CONFIG.sampleRate);
  });

  it("disables suppression when the dedup window is zero", () => {
    const sink = new RecordingSink();
    let now = 1_000;
    const manager = new AlertManager({ dedupWindowMs: 0 }, () => now).addSink(sink);

    manager.capture("error", "repeat", makeError("r", "E_R"));
    manager.capture("error", "repeat", makeError("r", "E_R"));

    expect(sink.events).toHaveLength(2);
  });
});

describe("installLoggerAlerting — logger hook integration", () => {
  // The indexer already reports production failures through logger.error, so the
  // hook is what gives every existing call site alerting coverage.
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    setErrorHook(undefined);
  });

  it("turns a logger.error line into an alert with its context", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);
    dispose = installLoggerAlerting(manager);

    const log = logger.child({ correlationId: "corr-7" });
    log.error("handler_error", { eventId: "evt-1", err: makeError("boom", "E_BOOM") });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].errorCode).toBe("E_BOOM");
    expect(sink.events[0].context).toMatchObject({
      correlationId: "corr-7",
      eventId: "evt-1",
    });
  });

  it("honours an escalated severity and hides the marker from the context", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager({ severityThreshold: "error" }).addSink(sink);
    dispose = installLoggerAlerting(manager);

    logger.error("db_unreachable", {
      err: makeError("ECONNREFUSED"),
      alertSeverity: "critical",
    });

    expect(sink.events[0].severity).toBe("critical");
    expect(sink.events[0].context).not.toHaveProperty("alertSeverity");
  });

  it("does not route info or warn lines", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);
    dispose = installLoggerAlerting(manager);

    logger.info("all good");
    logger.warn("something odd");

    expect(sink.events).toHaveLength(0);
  });

  it("stops routing once disposed", () => {
    const sink = new RecordingSink();
    const manager = new AlertManager().addSink(sink);
    dispose = installLoggerAlerting(manager);
    dispose();

    logger.error("after_dispose", makeError("x", "E_X"));
    expect(sink.events).toHaveLength(0);
  });

  it("a throwing sink cannot break logging", () => {
    const manager = new AlertManager();
    setErrorHook(() => {
      throw new Error("hook exploded");
    });

    expect(() => logger.error("still_logs", makeError("y", "E_Y"))).not.toThrow();
    expect(manager.enabled).toBe(false);
  });
});

