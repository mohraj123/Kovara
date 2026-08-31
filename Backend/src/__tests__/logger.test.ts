import {
  StructuredLogger,
  redact,
  getErrorMetrics,
  resetErrorMetrics,
} from "../logger";

describe("BA-042 error telemetry", () => {
  beforeEach(() => {
    resetErrorMetrics();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("stack traces", () => {
    it("includes stack, name, message, and code for Error args", () => {
      const log = new StructuredLogger("test");
      const err = new Error("boom");
      (err as Error & { code?: string }).code = "E_TEST";

      log.error("stack_ok", { err });

      const output = (console.error as jest.Mock).mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.err.name).toBe("Error");
      expect(parsed.err.message).toBe("boom");
      expect(parsed.err.code).toBe("E_TEST");
      expect(typeof parsed.err.stack).toBe("string");
      expect(parsed.err.stack).toContain("Error: boom");
    });

    it("truncates oversized stacks to a bounded tail", () => {
      const log = new StructuredLogger("test");
      const err = new Error("big");
      err.stack = "E".repeat(10000);

      log.error("stack_big", { err });

      const parsed = JSON.parse((console.error as jest.Mock).mock.calls[0][0]);
      expect(parsed.err.stack.length).toBe(2048 + "...(truncated)".length);
      expect(parsed.err.stack.startsWith("E")).toBe(true);
      expect(parsed.err.stack.endsWith("...(truncated)")).toBe(true);
    });

    it("omits stack when the Error has none", () => {
      const log = new StructuredLogger("test");
      const err = new Error("no stack");
      err.stack = undefined;

      log.error("stack_none", { err });

      const parsed = JSON.parse((console.error as jest.Mock).mock.calls[0][0]);
      expect(parsed.err.stack).toBeUndefined();
    });
  });

  describe("error metrics", () => {
    it("counts error and warn events by code and message key", () => {
      const log = new StructuredLogger("test");
      const errA = new Error("a");
      (errA as Error & { code?: string }).code = "E_A";
      const errB = new Error("b");

      log.error("first_failure", { err: errA });
      log.error("second_failure", { err: errA });
      log.error("third_failure", { err: errB });
      log.warn("fourth_warning", { err: errA });

      const metrics = getErrorMetrics();
      expect(metrics.total).toBe(4);
      expect(metrics.byCode["E_A"]).toBe(3); // 2 errors + 1 warn
      expect(metrics.byCode["<unknown>"]).toBe(1);
      expect(metrics.byMessage.first_failure).toBe(1);
      expect(metrics.byMessage.second_failure).toBe(1);
      expect(metrics.byMessage.third_failure).toBe(1);
      expect(metrics.byMessage.fourth_warning).toBe(1);
    });

    it("excludes always() and info() from metrics", () => {
      const log = new StructuredLogger("test");
      log.always("info_line", { err: new Error("x") });
      log.info("info_line2");

      expect(getErrorMetrics().total).toBe(0);
    });

    it("resets cleanly", () => {
      const log = new StructuredLogger("test");
      log.error("reset_check", { err: new Error("x") });
      resetErrorMetrics();
      expect(getErrorMetrics().total).toBe(0);
    });

    it("caps tracked message keys to prevent unbounded growth", () => {
      const log = new StructuredLogger("test");
      for (let i = 0; i < 150; i++) {
        log.error(`msg_key_${i}`);
      }
      const metrics = getErrorMetrics();
      expect(Object.keys(metrics.byMessage).length).toBeLessThanOrEqual(100);
      expect(metrics.byMessage.msg_key_0).toBeUndefined(); // oldest evicted
      expect(metrics.byMessage.msg_key_149).toBe(1);
    });

    it("does not double-count deduplicated (suppressed) lines", () => {
      const log = new StructuredLogger("test");
      log.error("dedup_check", { err: new Error("x") });
      log.error("dedup_check", { err: new Error("x") }); // suppressed by dedup window

      expect(getErrorMetrics().total).toBe(1);
    });
  });

  describe("existing redaction behaviour (regression)", () => {
    it("still redacts nested values and keeps bounded messages", () => {
      const err = new Error("x");
      err.stack = "at f ()";
      const out = redact({ err, address: "G".repeat(56) }) as Record<
        string,
        unknown
      >;
      expect((out.err as { stack?: string }).stack).toBe("at f ()");
      expect(out.address).not.toBe("G".repeat(56));
    });
  });
});
