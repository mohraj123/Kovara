import { AbuseDetector, DEFAULT_ABUSE_CONFIG, requestIdentity } from "../middleware/abuse-detection";
import { Logger } from "../logger";

/** A logger that records what was emitted, so "logged" is verifiable. */
function recordingLogger() {
  const lines: { level: string; message: string; args: unknown[] }[] = [];
  const log: Logger = {
    info: (m, ...a) => void lines.push({ level: "info", message: m, args: a }),
    warn: (m, ...a) => void lines.push({ level: "warn", message: m, args: a }),
    error: (m, ...a) => void lines.push({ level: "error", message: m, args: a }),
    always: (m, ...a) => void lines.push({ level: "always", message: m, args: a }),
    child: () => log,
  };
  return { log, lines };
}

describe("AbuseDetector (#661)", () => {
  const quiet = { warn: () => {}, info: () => {}, error: () => {}, always: () => {}, child: () => quiet } as unknown as Logger;

  describe("enumeration", () => {
    it("flags breadth-with-misses even at a modest request rate", () => {
      // The case a per-window counter cannot see: 50 requests in a minute is
      // half the 100/minute budget, yet 45 of them are 404s against distinct
      // ids. Volume looks fine; only the shape gives it away.
      const detector = new AbuseDetector({}, quiet);
      let signal: string | null = null;
      for (let i = 0; i < 50; i += 1) {
        const result = detector.record("id1", "GET", "/api/v1/profiles/GX", `/api/v1/profiles/GX${i}`, 404, "");
        if (result) signal = result.signal;
      }
      expect(signal).toBe("enumeration");
    });

    it("does not flag a normal client reading real content", async () => {
      // Same volume, but the resources exist and repeat. A client paging
      // through a feed must not be mistaken for an attacker.
      const detector = new AbuseDetector({}, quiet);
      for (let i = 0; i < 50; i += 1) {
        detector.record("id1", "GET", "/api/v1/posts", `/api/v1/posts/page/${i % 5}`, 200, "");
      }
      expect(detector.snapshot().detections).toBe(0);
    });
  });

  describe("scraping", () => {
    it("flags sustained breadth of real resources with few repeats", async () => {
      const detector = new AbuseDetector({}, quiet);
      let signal: string | null = null;
      for (let i = 0; i < DEFAULT_ABUSE_CONFIG.scrapingDistinctThreshold + 5; i += 1) {
        const result = detector.record("id1", "GET", "/api/v1/posts", `/api/v1/posts/${i}`, 200, "");
        if (result) signal = result.signal;
      }
      // All 200s, so the miss-ratio branch does not apply; the breadth branch
      // does. A crawler reading the whole database is exactly this.
      expect(signal).toBe("scraping");
    });
  });

  describe("burst", () => {
    it("flags a short-window spike before the long average moves", async () => {
      const detector = new AbuseDetector({}, quiet);
      let signal: string | null = null;
      for (let i = 0; i < DEFAULT_ABUSE_CONFIG.burstThreshold + 1; i += 1) {
        const result = detector.record("id1", "POST", "/api/v1/posts", `r${i}`, 201, "");
        if (result) signal = result.signal;
      }
      expect(signal).toBe("burst");
    });
  });

  describe("scanner detection", () => {
    it("flags a traversal attempt on the request alone", () => {
      const detector = new AbuseDetector({}, quiet);
      const result = detector.record("id1", "GET", "/api/v1/posts/../../etc/passwd", "r", 404, "");
      expect(result?.signal).toBe("scanner");
    });

    it("flags a known scanner user agent", () => {
      const detector = new AbuseDetector({}, quiet);
      const result = detector.record("id1", "GET", "/api/v1/posts", "r", 200, "sqlmap/1.7");
      expect(result?.signal).toBe("scanner");
    });

    it("flags an encoded traversal", () => {
      const detector = new AbuseDetector({}, quiet);
      const result = detector.record("id1", "GET", "/api/v1/posts/%2e%2e/secret", "r", 400, "");
      expect(result?.signal).toBe("scanner");
    });

    it("does not flag an ordinary user agent", () => {
      const detector = new AbuseDetector({}, quiet);
      expect(detector.record("id1", "GET", "/api/v1/posts", "r", 200, "Mozilla/5.0")).toBeNull();
    });
  });

  describe("cooldowns", () => {
    it("blocks after a detection and reports a retry hint", () => {
      const detector = new AbuseDetector({}, quiet);
      detector.record("id1", "GET", "/etc/passwd", "r", 404, "");
      expect(detector.isBlocked("id1")).toBe(true);
      expect(detector.retryAfterSeconds("id1")).toBeGreaterThan(0);
    });

    it("does not block a different identity", () => {
      const detector = new AbuseDetector({}, quiet);
      detector.record("bad", "GET", "/etc/passwd", "r", 404, "");
      // A shared NAT means one abuser must not take out everyone behind it.
      expect(detector.isBlocked("other")).toBe(false);
    });

    it("escalates the cooldown on repeat offences and caps it", () => {
      const detector = new AbuseDetector({}, quiet);
      const first = detector.record("id1", "GET", "/etc/passwd", "r", 404, "");
      const second = detector.record("id1", "GET", "/etc/passwd", "r", 404, "");
      const third = detector.record("id1", "GET", "/etc/passwd", "r", 404, "");
      expect(second!.cooldownMs).toBeGreaterThan(first!.cooldownMs);
      expect(third!.cooldownMs).toBeGreaterThan(second!.cooldownMs);
      // Never unbounded: an escalating wall that keeps growing is a denial of
      // service against a misidentified client.
      expect(third!.cooldownMs).toBeLessThanOrEqual(DEFAULT_ABUSE_CONFIG.maxCooldownMs);
    });

    it("can be unblocked early by an operator", () => {
      // A false positive on a shared NAT would otherwise last out the cooldown.
      const detector = new AbuseDetector({}, quiet);
      detector.record("id1", "GET", "/etc/passwd", "r", 404, "");
      expect(detector.unblock("id1")).toBe(true);
      expect(detector.isBlocked("id1")).toBe(false);
    });

    it("reports false when unblocking an unknown identity", () => {
      // An operator unblocking a typo must be able to tell nothing happened.
      expect(new AbuseDetector({}, quiet).unblock("nope")).toBe(false);
    });
  });

  describe("window expiry", () => {
    it("does not accumulate distinct resources across windows", async () => {
      // Without rebuilding the distinct set alongside the observation list, a
      // steady client would accumulate distinct resources forever and trip the
      // threshold permanently — a permanent ban earned by browsing.
      const detector = new AbuseDetector({ windowMs: 20 }, quiet);
      for (let i = 0; i < 30; i += 1) {
        detector.record("id1", "GET", "/api/v1/posts", `a${i}`, 200, "");
      }
      // Age out the first window.
      await new Promise((r) => setTimeout(r, 40));
      for (let i = 0; i < 30; i += 1) {
        detector.record("id1", "GET", "/api/v1/posts", `b${i}`, 200, "");
      }
      // 30 + 30 distinct would be 60 and would have tripped the threshold of 40
      // had the first window not been forgotten.
      expect(detector.snapshot().detections).toBe(0);
    });

    it("leaves a normal client unflagged across many requests", () => {
      const detector = new AbuseDetector({}, quiet);
      for (let i = 0; i < 35; i += 1) {
        detector.record("id1", "GET", "/api/v1/posts", `r${i % 5}`, 200, "");
      }
      expect(detector.snapshot().detections).toBe(0);
    });
  });

  describe("surfaces", () => {
    it("logs a structured warning on detection", () => {
      const { log, lines } = recordingLogger();
      const detector = new AbuseDetector({}, log);
      detector.record("id1", "GET", "/etc/passwd", "r", 404, "");
      const warn = lines.find((l) => l.level === "warn");
      expect(warn).toBeDefined();
      expect(warn!.message).toBe("abuse pattern detected");
      // The log line must carry the signal and the reason, or it is not
      // actionable.
      expect(warn!.args[0]).toMatchObject({ signal: "scanner", identity: "id1" });
    });

    it("exposes counters and recent events to operators", () => {
      const detector = new AbuseDetector({}, quiet);
      detector.record("id1", "GET", "/etc/passwd", "r", 404, "");
      const snap = detector.snapshot();
      expect(snap.detections).toBe(1);
      expect(snap.blockedIdentities).toBe(1);
      expect(snap.recentEvents[0].signal).toBe("scanner");
      expect(snap.recentEvents[0].cooldownSeconds).toBeGreaterThan(0);
    });

    it("omits the scanner patterns from the snapshot", () => {
      // They are the tuning surface, not live state, and a regex is not
      // meaningfully JSON-serialisable.
      const snap = new AbuseDetector({}, quiet).snapshot();
      expect(snap.config).not.toHaveProperty("scannerPathPatterns");
      expect(snap.config).not.toHaveProperty("scannerUserAgents");
    });

    it("bounds the retained event list", () => {
      const detector = new AbuseDetector({}, quiet);
      for (let i = 0; i < 600; i += 1) {
        detector.record(`id${i}`, "GET", "/etc/passwd", "r", 404, "");
      }
      expect(detector.snapshot().recentEvents.length).toBeLessThanOrEqual(50);
    });
  });

  describe("identity", () => {
    const fakeReq = (over: Record<string, unknown>) =>
      ({ path: "/api/v1/posts", headers: {}, body: undefined, socket: {}, ...over }) as never;

    it("prefers a verified address and hashes it", () => {
      const address = `G${"A".repeat(55)}`;
      const identity = requestIdentity(fakeReq({ path: `/api/v1/profiles/${address}` }));
      // Hashed, so logs do not become a registry of who was throttled.
      expect(identity).toMatch(/^addr:[0-9a-f]{16}$/);
      expect(identity).not.toContain(address);
    });

    it("separates distinct addresses", () => {
      const a = requestIdentity(fakeReq({ path: `/api/v1/profiles/G${"A".repeat(55)}` }));
      const b = requestIdentity(fakeReq({ path: `/api/v1/profiles/G${"B".repeat(55)}` }));
      expect(a).not.toBe(b);
    });

    it("falls back to the IP when no address is present", () => {
      const identity = requestIdentity(fakeReq({ socket: { remoteAddress: "10.0.0.5" } }));
      expect(identity).toMatch(/^ip:[0-9a-f]{16}$/);
    });

    it("does not trust a malformed address as an identity", () => {
      // A short or malformed "address" must not become an identity bucket an
      // attacker can trivially point at another client.
      const identity = requestIdentity(fakeReq({ path: "/api/v1/profiles/Gnotanaddress" }));
      expect(identity).toMatch(/^ip:/);
    });
  });
});
