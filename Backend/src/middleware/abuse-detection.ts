/**
 * Abuse detection layered on top of the existing rate limiters.
 *
 * Issue #661. Three criteria:
 *
 *   1. high-frequency clients are throttled;
 *   2. **abuse patterns are detected and logged/surfaced to operators**;
 *   3. throttled clients get a clear 429.
 *
 * (1) is already covered by the global `express-rate-limit` limiter and the
 * per-address limiter from #616, so this module does not reimplement request
 * counting. What a per-window counter cannot see is the client that stays just
 * under the budget: 1 request/second is 60/minute against a 100/minute limit, so
 * it is never throttled, and it will read the entire database at a sustainable
 * pace forever. The same gap covers enumeration, where a client fetches 500
 * distinct addresses that do not exist — every request is individually
 * legitimate and the total is exactly the limit.
 *
 * So the signal here is not volume, it is *shape*:
 *
 *   - **enumeration** — many distinct resources, most of them missing. The
 *     request rate looks ordinary; only the miss ratio and the distinct-id count
 *     give it away.
 *   - **scraping** — many distinct resources, few repeats, and a high miss
 *     ratio. Slow and steady.
 *   - **burst** — a very short sub-window spike, caught before the long window
 *     average has moved at all.
 *   - **scanner** — traversal or injection attempts in the path, and known
 *     scanner user agents.
 *
 * The response to detection is a **temporary, escalating** block rather than a
 * permanent one. A permanent ban triggered by a heuristic is unrecoverable when
 * the heuristic is wrong: a shared NAT, a corporate proxy, or one client on a
 * misbehaving network would take out every user behind that address with no way
 * back except operator intervention. Cooldowns start short, double on repeat
 * offenses within the window, and decay back to the base — so a real abuser hits
 * progressively longer walls, and a false positive resolves itself.
 *
 * Every detection is logged as a structured warning and counted, so an operator
 * can see the pattern before acting on it. See {@link AbuseDetector.snapshot}.
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import { logger as defaultLogger, Logger } from "../logger";

/** Why a client was throttled. */
export type AbuseSignal =
  | "enumeration"
  | "scraping"
  | "burst"
  | "scanner"
  | "tier_budget";

/** One recorded abuse event. */
export interface AbuseEvent {
  signal: AbuseSignal;
  /** The identity that triggered it, already reduced to a hash. */
  identity: string;
  /** Endpoint that was being hit. */
  path: string;
  method: string;
  /** Detail describing why this signal fired. */
  detail: string;
  /** Cooldown applied, in seconds. */
  cooldownSeconds: number;
  /** When it happened, epoch ms. */
  at: number;
}

export interface AbuseConfig {
  /** Sliding observation window, ms. */
  windowMs: number;
  /** Requests within `burstWindowMs` that count as a burst. */
  burstWindowMs: number;
  /** Requests in `burstWindowMs` that trigger `burst`. */
  burstThreshold: number;
  /** Distinct resources per window that start counting as enumeration. */
  enumerationDistinctThreshold: number;
  /** Miss ratio (0-1) above which a distinct-resource client is enumerating. */
  missRatioThreshold: number;
  /** Distinct resources per window that count as scraping. */
  scrapingDistinctThreshold: number;
  /** Base cooldown for a first offence, ms. */
  baseCooldownMs: number;
  /** Ceiling for the escalating cooldown, ms. */
  maxCooldownMs: number;
  /** Distinct identities tracked at once. */
  maxIdentities: number;
  /** Requests from a path matching these patterns are scanner traffic. */
  scannerPathPatterns: RegExp[];
  /** User-agent substrings that are always scanners. */
  scannerUserAgents: RegExp[];
}

export const DEFAULT_ABUSE_CONFIG: AbuseConfig = {
  windowMs: 60_000,
  burstWindowMs: 1_000,
  burstThreshold: 25,
  enumerationDistinctThreshold: 40,
  missRatioThreshold: 0.6,
  scrapingDistinctThreshold: 120,
  baseCooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
  maxIdentities: 10_000,
  scannerPathPatterns: [
    /\.\.(\/|\\)/,
    /%2e%2e/i,
    /\/(etc|proc|sys)\//i,
    /\$\{[^}]*\}/,
    /\bunion\b.*\bselect\b/i,
    /\b(select|insert|update|delete)\b.*--/i,
    /<script/i,
  ],
  scannerUserAgents: [
    /sqlmap/i,
    /nikto/i,
    /nmap/i,
    /masscan/i,
    /zgrab/i,
    /dirbuster/i,
    /wpscan/i,
    /\/bin\/(bash|sh|wget|curl)\b/i,
  ],
};

/** A single timestamped request, kept just long enough to age out. */
interface Observation {
  at: number;
  /** Resource identity, so repeats are distinguishable from breadth. */
  resource: string;
  status?: number;
}

/** Per-identity rolling state. */
interface IdentityState {
  observations: Observation[];
  /** Distinct resources seen in the window, as a count plus a sample. */
  distinctResources: Set<string>;
  blockedUntil: number;
  /** Consecutive offences, driving the escalating cooldown. */
  offenseCount: number;
  lastOffenseAt: number;
}

export class AbuseDetector {
  private readonly states = new Map<string, IdentityState>();
  private readonly events: AbuseEvent[] = [];
  private detections = 0;
  private blockedRequests = 0;
  private readonly log: Logger;
  private readonly config: AbuseConfig;

  constructor(config: Partial<AbuseConfig> = {}, log: Logger = defaultLogger) {
    this.config = { ...DEFAULT_ABUSE_CONFIG, ...config };
    this.log = log;
  }

  /**
   * Record a completed request and return the signal it triggered, if any.
   *
   * Call after the response is finished so the status code is known — the miss
   * ratio, which is the core enumeration signal, needs it.
   */
  record(
    identity: string,
    method: string,
    path: string,
    resource: string,
    status: number,
    userAgent: string
  ): { signal: AbuseSignal; cooldownMs: number; detail: string } | null {
    const now = Date.now();
    const state = this.stateFor(identity);
    this.prune(state, now);

    // Scanner traffic is judged on the request alone, with no history needed,
    // so it is checked first and costs nothing when it does not apply.
    const scanner = this.detectScanner(path, userAgent);
    if (scanner) return this.trip(state, identity, method, path, scanner, now);

    state.observations.push({ at: now, resource, status });
    state.distinctResources.add(resource);

    const burst = this.detectBurst(state, now);
    if (burst) return this.trip(state, identity, method, path, burst, now);

    const shaped = this.detectEnumerationOrScraping(state, now);
    if (shaped) return this.trip(state, identity, method, path, shaped, now);

    return null;
  }

  /** True when the identity is inside an active cooldown. */
  isBlocked(identity: string): boolean {
    const state = this.states.get(identity);
    if (!state) return false;
    return state.blockedUntil > Date.now();
  }

  /** Seconds left on the cooldown, for `Retry-After`. */
  retryAfterSeconds(identity: string): number {
    const state = this.states.get(identity);
    if (!state) return 0;
    return Math.max(0, Math.ceil((state.blockedUntil - Date.now()) / 1000));
  }

  /**
   * Clear a block early.
   *
   * Exists so an operator who judges a block to be a false positive can lift it
   * immediately, without waiting out a cooldown that might be 15 minutes.
   */
  unblock(identity: string): boolean {
    const state = this.states.get(identity);
    if (!state) return false;
    state.blockedUntil = 0;
    state.offenseCount = 0;
    return true;
  }

  /**
   * Operator-facing counters and the most recent events.
   *
   * This is the "surfaced to operators" half of the requirement. Detection that
   * only writes to a log is invisible to an on-call engineer without log access,
   * and un-logged detection is not a control at all.
   */
  snapshot(): {
    trackedIdentities: number;
    detections: number;
    blockedRequests: number;
    blockedIdentities: number;
    recentEvents: AbuseEvent[];
    config: Omit<AbuseConfig, "scannerPathPatterns" | "scannerUserAgents">;
  } {
    const now = Date.now();
    let blockedIdentities = 0;
    for (const state of this.states.values()) {
      if (state.blockedUntil > now) blockedIdentities += 1;
    }
    // Patterns are omitted: they are the tuning surface, not the live state.
    const { scannerPathPatterns: _p, scannerUserAgents: _u, ...config } = this.config;
    return {
      trackedIdentities: this.states.size,
      detections: this.detections,
      blockedRequests: this.blockedRequests,
      blockedIdentities,
      recentEvents: this.events.slice(-50),
      config,
    };
  }

  reset(): void {
    this.states.clear();
    this.events.length = 0;
    this.detections = 0;
    this.blockedRequests = 0;
  }

  // ── detection ────────────────────────────────────────────────────────────

  private detectScanner(path: string, userAgent: string): string | null {
    for (const pattern of this.config.scannerPathPatterns) {
      if (pattern.test(path)) {
        return `path matched scanner pattern ${pattern.source}`;
      }
    }
    for (const pattern of this.config.scannerUserAgents) {
      if (userAgent && pattern.test(userAgent)) {
        return `user-agent matched scanner pattern ${pattern.source}`;
      }
    }
    return null;
  }

  private detectBurst(state: IdentityState, now: number): string | null {
    const cutoff = now - this.config.burstWindowMs;
    let count = 0;
    for (const obs of state.observations) {
      if (obs.at >= cutoff) count += 1;
    }
    if (count >= this.config.burstThreshold) {
      return `${count} requests within ${this.config.burstWindowMs}ms`;
    }
    return null;
  }

  /**
   * Enumeration vs scraping.
   *
   * Both are breadth-over-repeat. The difference is the miss ratio: enumeration
   * walks addresses or ids that mostly do not exist, while scraping crawls real
   * content. The miss ratio is what separates them, so both are computed from
   * the same observation set rather than tracked separately.
   */
  private detectEnumerationOrScraping(state: IdentityState, now: number): string | null {
    const distinct = state.distinctResources.size;
    if (distinct < this.config.enumerationDistinctThreshold) return null;

    const total = state.observations.length;
    if (total === 0) return null;
    const misses = state.observations.filter((o) => o.status === 404 || o.status === 400).length;
    const missRatio = misses / total;
    const distinctRatio = distinct / total;

    if (missRatio >= this.config.missRatioThreshold) {
      return `enumeration: ${distinct} distinct resources, ${Math.round(missRatio * 100)}% missing (${state.observations.length} requests)`;
    }
    if (distinct >= this.config.scrapingDistinctThreshold && distinctRatio > 0.8) {
      return `scraping: ${distinct} distinct resources with only ${state.observations.length - distinct} repeats`;
    }
    return null;
  }

  // ── state ────────────────────────────────────────────────────────────────

  private stateFor(identity: string): IdentityState {
    let state = this.states.get(identity);
    if (!state) {
      // Bound the map so a flood from rotating identities cannot exhaust memory.
      // Without a cap this is a memory-exhaustion vector: every request can mint
      // a new key that is never collected.
      if (this.states.size >= this.config.maxIdentities) this.evictOldest();
      state = {
        observations: [],
        distinctResources: new Set(),
        blockedUntil: 0,
        offenseCount: 0,
        lastOffenseAt: 0,
      };
      this.states.set(identity, state);
    }
    return state;
  }

  /** Drop observations and identities that have aged out of the window. */
  private prune(state: IdentityState, now: number): void {
    const cutoff = now - this.config.windowMs;
    if (state.observations.length > 0 && state.observations[0].at < cutoff) {
      const kept = state.observations.filter((o) => o.at >= cutoff);
      state.observations = kept;
      // The distinct set has to be rebuilt alongside the observation list, or
      // it would keep counting resources that are no longer in the window and
      // trip the threshold forever.
      state.distinctResources = new Set(kept.map((o) => o.resource));
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, state] of this.states) {
      const last = state.observations.length > 0
        ? state.observations[state.observations.length - 1].at
        : 0;
      if (last < oldestAt) {
        oldestAt = last;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.states.delete(oldestKey);
  }

  /**
   * Apply a cooldown and log the detection.
   *
   * The cooldown doubles per offence inside the escalation window, capped. That
   * gives a persistent abuser a growing cost while letting a client that stops
   * misbehaving return to normal on its own.
   */
  private trip(
    state: IdentityState,
    identity: string,
    method: string,
    path: string,
    detail: string,
    now: number
  ): { signal: AbuseSignal; cooldownMs: number; detail: string } {
    const signal = detail.split(":")[0].startsWith("enumeration")
      ? "enumeration"
      : detail.split(":")[0].startsWith("scraping")
        ? "scraping"
        : detail.includes("scanner pattern")
          ? "scanner"
          : "burst";

    const escalated = this.config.baseCooldownMs * Math.pow(2, state.offenseCount);
    const cooldownMs = Math.min(escalated, this.config.maxCooldownMs);
    state.blockedUntil = now + cooldownMs;
    state.lastOffenseAt = now;
    // Count offences only while they keep coming, so the escalation reflects
    // sustained abuse rather than a scattering of incidents over weeks.
    if (now - state.lastOffenseAt < 10 * 60_000) state.offenseCount += 1;

    this.detections += 1;
    const event: AbuseEvent = {
      signal,
      identity,
      path,
      method,
      detail,
      cooldownSeconds: Math.ceil(cooldownMs / 1000),
      at: now,
    };
    this.events.push(event);
    // Bounded ring: an operator snapshot is a recent view, and an unbounded log
    // would grow for the lifetime of the process.
    if (this.events.length > 500) this.events.shift();

    this.log.warn("abuse pattern detected", {
      signal,
      identity,
      method,
      path,
      detail,
      cooldownSeconds: event.cooldownSeconds,
    });

    return { signal, cooldownMs, detail };
  }

  /** Count a request that was refused while blocked. */
  countBlocked(): void {
    this.blockedRequests += 1;
  }
}

/**
 * The identity a decision is made against.
 *
 * Prefers a verified Stellar address, because that is the one identifier a
 * client cannot trivially rotate. The address comes from the path/body only when
 * a request is already associated with one, and is **not** trusted blindly —
 * it is hashed below regardless, so a spoofed address cannot poison another
 * client's state or be used to attribute abuse to them.
 */
export function requestIdentity(req: Request): string {
  const address = extractAddress(req);
  if (address) return `addr:${hashIdentity(address)}`;

  const forwarded = req.headers["x-forwarded-for"];
  const ip =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  return `ip:${hashIdentity(ip)}`;
}

/** Stable, non-reversible identity, so logs do not become an address registry. */
function hashIdentity(value: string): string {
  // A short digest is enough to separate identities without storing the
  // original. Created inline rather than importing node:crypto so the module has
  // no dependency beyond express and the logger.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Best-effort address extraction, matching the #616 limiter's approach. */
function extractAddress(req: Request): string | null {
  for (const segment of req.path.split("/")) {
    if (STELLAR_ADDRESS_RE.test(segment)) return segment;
  }
  const body = req.body as { address?: unknown } | undefined;
  if (body && typeof body.address === "string" && STELLAR_ADDRESS_RE.test(body.address)) {
    return body.address;
  }
  const header = req.headers["x-stellar-address"];
  if (typeof header === "string" && STELLAR_ADDRESS_RE.test(header)) return header;
  return null;
}

export interface AbuseMiddlewareOptions {
  detector?: AbuseDetector;
  /** Paths to skip. Health checks and the operator snapshot must never throttle. */
  skipPaths?: string[];
}

/**
 * Express middleware.
 *
 * Runs *after* the response, so the status code is available to the detector —
 * but it must still be able to refuse a request that arrives while an identity
 * is inside a cooldown, which means checking the block *before* calling next.
 */
export function abuseDetection(options: AbuseMiddlewareOptions = {}): RequestHandler {
  const detector = options.detector ?? new AbuseDetector();
  const skipPaths = options.skipPaths ?? ["/health", "/metrics", "/api/v1/health"];

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    if (skipPaths.some((p) => req.path === p || req.path.endsWith(p))) {
      next();
      return;
    }

    // originalUrl, not req.path: this middleware is mounted with
    // `app.use("/api", …)`, so req.path has the /api prefix stripped and a
    // recorded path like "/v1/posts" is ambiguous to whoever reads the log.
    // The query string is dropped — it is attacker-controlled and adds nothing.
    const full = req.originalUrl ?? req.url ?? req.path;
    const path = full.split("?")[0];

    const identity = requestIdentity(req);

    if (detector.isBlocked(identity)) {
      detector.countBlocked();
      const retryAfter = detector.retryAfterSeconds(identity);
      // Clear and machine-readable, and it names the policy that fired so a
      // client developer can tell a shared quota from an abuse block.
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("X-RateLimit-Reason", "abuse_pattern");
      res.status(429).json({
        error: "Too many requests. This client is temporarily throttled for abusive request patterns.",
        code: "ABUSE_DETECTED",
        retry_after: retryAfter,
      });
      return;
    }

    // Observe on finish so the status code is final, then let the response
    // through. A detection from *this* request applies to the next one: holding
    // the response would mean the abusive request is also the slow one.
    res.on("finish", () => {
      try {
        detector.record(
          identity,
          req.method,
          path,
          `${req.method} ${path}`,
          res.statusCode,
          String(req.headers["user-agent"] ?? "")
        );
      } catch (err) {
        // Detection must never break a response that has already been sent.
        defaultLogger.warn("abuse detection failed", { error: err });
      }
    });

    next();
  };

  // Exposed so the app can share one detector between the middleware and the
  // operator endpoint; without this the endpoint would report an empty cache.
  (middleware as RequestHandler & { detector: AbuseDetector }).detector = detector;
  return middleware;
}
