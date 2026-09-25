/**
 * Tiered rate limits for endpoints that are not all equally expensive.
 *
 * Issue #661, part (1). The global limiter applies one budget to every request,
 * which is the right default and the wrong shape here: a `POST /tips` costs a
 * transaction and a `GET /api/v1/health` costs nothing, yet they share a
 * 100/minute budget. A client integrating a UI hits both, so the expensive
 * calls the client actually cares about get throttled by the cheap ones.
 *
 * Search is the clearest case. A full-text query with a trigram fallback is the
 * most expensive read in the service, and it is a read a browser issues on every
 * keystroke if the caller is not careful. It needs its own, tighter budget.
 *
 * Three tiers, applied by path, each independently configurable and all
 * defaulting off when `ENABLE_TIERED_RATE_LIMITS=false` — so enabling this cannot
 * surprise a deployment that was relying on the flat limit alone.
 *
 * Tier headers use the `X-RateLimit-Tier` name rather than overwriting the
 * standard `RateLimit-*` headers, so a client still sees exactly one set of
 * standard headers from whichever limiter rejected it.
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import { logger as defaultLogger, Logger } from "../logger";

export interface TierConfig {
  /** Expensive reads: search, leaderboard, history. */
  search: { windowMs: number; max: number };
  /** Writes: posts, tips, likes, follows. */
  write: { windowMs: number; max: number };
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  search: { windowMs: 60_000, max: 30 },
  write: { windowMs: 60_000, max: 20 },
};

/** Path fragments that select a tier. Matched as substrings against the path. */
const SEARCH_PATHS = ["/search", "/leaderboard", "/index", "/analytics", "/history"];
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let tierConfig: TierConfig = { ...DEFAULT_TIER_CONFIG };

/** Override the tier budgets. Intended for tests. */
export function setTierConfig(config: Partial<TierConfig>): void {
  tierConfig = {
    search: config.search ?? tierConfig.search,
    write: config.write ?? tierConfig.write,
  };
}

export function getTierConfig(): TierConfig {
  return tierConfig;
}

/**
 * The path a classification should use.
 *
 * `req.path` is relative to the mount point, so inside a router mounted with
 * `app.use("/search", …)` it is `/` rather than `/api/v1/search` — and a
 * classification reading it would silently never match, disabling the tier
 * entirely rather than erroring. `originalUrl` is the full path including the
 * mount prefix, so it is the only reliable source. The query string is stripped
 * because it is attacker-controlled and irrelevant to routing.
 */
export function effectivePath(req: Request): string {
  const full = req.originalUrl ?? req.url ?? "";
  const queryStart = full.indexOf("?");
  return queryStart >= 0 ? full.slice(0, queryStart) : full;
}

/** Which tier a request falls into, or null for the default budget. */
export function tierFor(method: string, path: string): keyof TierConfig | null {
  if (WRITE_METHODS.has(method.toUpperCase())) return "write";
  const lower = path.toLowerCase();
  if (SEARCH_PATHS.some((fragment) => lower.includes(fragment))) return "search";
  return null;
}

/** Classify a request, using the full path. */
export function tierForRequest(req: Request): keyof TierConfig | null {
  return tierFor(req.method, effectivePath(req));
}

function build(tier: keyof TierConfig): RateLimitRequestHandler {
  const { windowMs, max } = tierConfig[tier];
  // The options object is built untyped and cast at the call site. `Options` is
  // not imported deliberately: the limiter's option type is internal to
  // express-rate-limit, and naming it here would couple this file to a
  // particular minor version's type surface for no benefit.
  const options = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // A request only counts against this tier once it belongs to the tier. The
    // dispatcher below already checks the same predicate, so this is
    // belt-and-braces: it keeps a mis-dispatched request from double-counting.
    // Classified from originalUrl, not req.path, for the mount-point reason
    // documented on effectivePath().
    skip: (req: Request): boolean => tierForRequest(req) !== tier,
    handler: (req: Request, res: Response): void => {
      res.setHeader("X-RateLimit-Tier", tier);
      res.status(429).json({
        error: `Too many ${tier} requests. This endpoint has a tighter budget than the general API limit.`,
        code: "RATE_LIMIT_TIER_EXCEEDED",
        tier,
        retry_after: Math.max(1, Math.ceil(tierConfig[tier].windowMs / 1000)),
      });
    },
  };
  return rateLimit(options);
}

export interface TieredRateLimitOptions {
  config?: Partial<TierConfig>;
  log?: Logger;
}

export interface TieredRateLimitMiddleware extends RequestHandler {
  search: RateLimitRequestHandler;
  write: RateLimitRequestHandler;
}

/**
 * Build the tiered limiters.
 *
 * They are mounted on the router *after* routing, so `req.path` is the
 * full path and the skip predicate can classify accurately. Mounting them
 * globally before routing would classify on the pre-route path, which works but
 * double-counts against the flat limiter for requests both limiters see.
 */
export function tieredRateLimits(options: TieredRateLimitOptions = {}): TieredRateLimitMiddleware {
  if (options.config) setTierConfig(options.config);
  const log = options.log ?? defaultLogger;
  const enabled = process.env.ENABLE_TIERED_RATE_LIMITS !== "false";

  // Built before the dispatcher so the dispatcher can reference them as locals.
  // Referencing `dispatch.search` instead would not type-check: a bare function
  // expression has no such property.
  const noop = (): void => undefined;
  const search = enabled ? build("search") : (noop as unknown as RateLimitRequestHandler);
  const write = enabled ? build("write") : (noop as unknown as RateLimitRequestHandler);

  const dispatch = (req: Request, res: Response, next: NextFunction): void => {
    const tier = tierForRequest(req);
    if (tier === null) {
      next();
      return;
    }
    // A rejection here is a policy decision worth a line in the log, distinct
    // from the per-request debug noise the logger already emits.
    res.on("finish", () => {
      if (res.statusCode === 429) {
        log.warn("tiered rate limit exceeded", {
          tier,
          path: effectivePath(req),
          method: req.method,
        });
      }
    });
    (tier === "search" ? search : write)(req, res, next);
  };

  // Object.assign rather than a variable declared with the compound type: a
  // function literal is not assignable to an interface that also requires
  // properties, and the call sites need `.search`/`.write` for direct mounting.
  return Object.assign(dispatch, { search, write });
}
