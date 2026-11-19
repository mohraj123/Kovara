import {
  classifyFailure,
  computeBackoffMs,
  isPermanentError,
  isTransientError,
  parseRetryAfterMs,
  withRetry,
} from "../retry";

/** Collects log lines so a test can assert on what operators would see. */
function makeLog() {
  const lines: { level: string; message: string; args: unknown[] }[] = [];
  return {
    lines,
    warn: (message: string, ...args: unknown[]) => lines.push({ level: "warn", message, args }),
    error: (message: string, ...args: unknown[]) => lines.push({ level: "error", message, args }),
  };
}

const noSleep = async () => {};

describe("classifyFailure", () => {
  it("treats transient socket and operational SQLSTATE errors as retryable", () => {
    expect(classifyFailure({ code: "ECONNRESET" }).kind).toBe("transient");
    expect(classifyFailure({ code: "ETIMEDOUT" }).kind).toBe("transient");
    expect(classifyFailure({ code: "40001" }).kind).toBe("transient");
    expect(classifyFailure({ code: "40P01" }).kind).toBe("transient");
    expect(classifyFailure({ code: "53300" }).kind).toBe("transient");
    expect(classifyFailure({ code: "57P01" }).kind).toBe("transient");
  });

  it("treats integrity violations as permanent", () => {
    // The point of the split: re-running a statement that violates a unique
    // constraint produces the same violation, so retrying only wastes budget.
    expect(classifyFailure({ code: "23505" }).kind).toBe("permanent");
    expect(classifyFailure({ code: "23503" }).kind).toBe("permanent");
    expect(classifyFailure({ code: "22P02" }).kind).toBe("permanent");
  });

  it("classifies provider status codes from the message", () => {
    expect(isTransientError(new Error("RPC request failed: 503 Service Unavailable"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("connection terminated unexpectedly"))).toBe(true);
    expect(isPermanentError(new Error("RPC request failed: 400 Bad Request"))).toBe(true);
  });

  it("prefers a permanent marker over a transient one in the same message", () => {
    // "invalid payload ... timeout" carries both signals; the data problem wins.
    const classification = classifyFailure(
      new Error("invalid payload: field is malformed after timeout")
    );
    expect(classification.kind).toBe("permanent");
  });

  it("lets an explicit code win over a misleading message", () => {
    expect(classifyFailure(Object.assign(new Error("invalid input"), { code: "ECONNRESET" })).kind).toBe(
      "transient"
    );
  });

  it("defaults an unrecognised error to permanent", () => {
    // Retrying an error we do not understand cannot fix it, and the
    // dead-letter path exists so a human can look at it.
    expect(classifyFailure(new Error("something unfamiliar happened")).kind).toBe("permanent");
  });

  it("handles non-Error throwables without throwing", () => {
    expect(isTransientError("ECONNRESET")).toBe(true);
    expect(isPermanentError(42)).toBe(true);
    expect(isPermanentError(null)).toBe(true);
    expect(isPermanentError(undefined)).toBe(true);
  });
});

describe("computeBackoffMs", () => {
  it("grows exponentially and respects the cap", () => {
    const opts = { baseDelayMs: 100, backoffMultiplier: 2, maxBackoffMs: 500, jitter: false };
    expect(computeBackoffMs(1, opts)).toBe(100);
    expect(computeBackoffMs(2, opts)).toBe(200);
    expect(computeBackoffMs(3, opts)).toBe(400);
    expect(computeBackoffMs(4, opts)).toBe(500);
    expect(computeBackoffMs(10, opts)).toBe(500);
  });

  it("applies full jitter within the computed window", () => {
    const opts = { baseDelayMs: 1000, backoffMultiplier: 2, jitter: true };
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffMs(1, opts);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1000);
    }
  });
});

describe("withRetry", () => {
  it("returns the result without retrying when the first attempt succeeds", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const log = makeLog();

    await expect(withRetry(fn, { log })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.lines).toHaveLength(0);
  });

  it("retries a transient failure and succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue("recovered");
    const log = makeLog();

    await expect(
      withRetry(fn, { maxAttempts: 3, log, sleep: noSleep, jitter: false })
    ).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(log.lines[0].level).toBe("warn");
    expect(log.lines[0].message).toContain("transiently");
  });

  it("fails fast on a permanent failure without spending the budget", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("RPC request failed: 400 Bad Request"));
    const log = makeLog();

    await expect(withRetry(fn, { maxAttempts: 5, log, sleep: noSleep })).rejects.toThrow(
      /400 Bad Request/
    );
    // One attempt only: a permanent error is not retried at all.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.lines[0].message).toContain("permanently");
  });

  it("stops at maxAttempts and logs the give-up", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("connection terminated"));
    const log = makeLog();

    await expect(
      withRetry(fn, { maxAttempts: 3, log, sleep: noSleep, jitter: false })
    ).rejects.toThrow(/connection terminated/);
    expect(fn).toHaveBeenCalledTimes(3);
    const last = log.lines[log.lines.length - 1];
    expect(last.level).toBe("error");
    expect(last.message).toContain("failed after 3 attempt(s)");
  });

  it("honours an explicit isRetryable override", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("always fails"));
    const log = makeLog();

    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        log,
        sleep: noSleep,
        isRetryable: () => true,
      })
    ).rejects.toThrow(/always fails/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the signal aborts", async () => {
    const controller = new AbortController();
    const fn = jest.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("socket hang up"));
    });
    const log = makeLog();

    await expect(
      withRetry(fn, { maxAttempts: 5, log, sleep: noSleep, signal: controller.signal })
    ).rejects.toThrow(/socket hang up/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clamps a zero or negative attempt budget to a single attempt", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("connection terminated"));
    const log = makeLog();

    await expect(
      withRetry(fn, { maxAttempts: 0, log, sleep: noSleep })
    ).rejects.toThrow(/connection terminated/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the abort signal through to a non-retryable caller without throwing early", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = jest.fn().mockResolvedValue("never called");
    const log = makeLog();

    await expect(
      withRetry(fn, { log, signal: controller.signal })
    ).rejects.toThrow(/aborted before attempt 1/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("Retry-After handling", () => {
  it("parses seconds and dates, and caps excessive values", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("999999")).toBe(60_000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("waits at least the provider hint before retrying a 429", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const err = Object.assign(new Error("RPC request failed: 429"), { status: 429, retryAfterMs: 5000 });
    const fn = jest.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");

    await expect(
      withRetry(fn, { sleep, jitter: false, baseDelayMs: 10, log: makeLog() })
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});
