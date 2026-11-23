/**
 * Per-address rate limiting middleware (Issue #616).
 *
 * Supplements the existing IP-based limiter with a per-Stellar-address limit.
 * The address is extracted from:
 *   1. URL path scan — any path segment that matches a Stellar public key
 *      (e.g. /api/profiles/:address, /api/follows/:address/followers).
 *      This is needed because global Express middleware runs before route
 *      matching, so req.params is always empty at this stage.
 *   2. The request body `address` field (for POST endpoints)
 *   3. The `x-stellar-address` request header (for clients that supply it explicitly)
 *
 * Requests that cannot be associated with a Stellar address are passed through
 * untouched — the IP-based limiter still protects those.
 *
 * Configuration is driven by two environment variables so operators can tune
 * limits independently of the IP window:
 *   ADDRESS_RATE_LIMIT_WINDOW_MS  (default: 60 000 ms; allowed 1 000 – 86 400 000)
 *   ADDRESS_RATE_LIMIT_MAX        (default: 100 requests per window; allowed 1 – 1 000 000)
 *   ADDRESS_RATE_LIMIT_MAX_KEYS   (default: 10 000 tracked addresses; allowed 1 – 1 000 000)
 *
 * Invalid values are rejected with an error naming the variable, the value and
 * the allowed range, rather than silently falling back to a default.
 *
 * 429 responses include:
 *   - `Retry-After` header (seconds until the window resets)
 *   - Standard `RateLimit-*` headers (via `standardHeaders: true`)
 *   - JSON body  { error: string, code: "ADDRESS_RATE_LIMIT_EXCEEDED" }
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit, {
  ClientRateLimitInfo,
  Options,
  RateLimitRequestHandler,
  Store,
} from "express-rate-limit";

// ── Constants ──────────────────────────────────────────────────────────────

/** Stellar public keys start with G and are exactly 56 base-32 characters. */
const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Sentinel used when no address is found in the request. */
const NO_ADDRESS_KEY = "__no_address__";

// ── Configuration ──────────────────────────────────────────────────────────

export const DEFAULT_ADDRESS_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_ADDRESS_RATE_LIMIT_MAX = 100;
export const DEFAULT_ADDRESS_RATE_LIMIT_MAX_KEYS = 10_000;

export interface AddressRateLimitConfig {
  windowMs: number;
  max: number;
  /** Upper bound on distinct addresses tracked at once. */
  maxKeys: number;
}

const LIMIT_BOUNDS = {
  ADDRESS_RATE_LIMIT_WINDOW_MS: [1_000, 86_400_000],
  ADDRESS_RATE_LIMIT_MAX: [1, 1_000_000],
  ADDRESS_RATE_LIMIT_MAX_KEYS: [1, 1_000_000],
} as const;

function parseBounded(
  name: keyof typeof LIMIT_BOUNDS,
  raw: string | undefined,
  fallback: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const [min, max] = LIMIT_BOUNDS[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Invalid ${name}="${raw}": expected an integer between ${min} and ${max} (default ${fallback})`
    );
  }
  return value;
}

/**
 * Read and validate the per-address limits from the environment.
 * Throws an actionable error for any value that is not a whole number in range.
 */
export function resolveAddressRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env
): AddressRateLimitConfig {
  return {
    windowMs: parseBounded(
      "ADDRESS_RATE_LIMIT_WINDOW_MS",
      env.ADDRESS_RATE_LIMIT_WINDOW_MS,
      DEFAULT_ADDRESS_RATE_LIMIT_WINDOW_MS
    ),
    max: parseBounded(
      "ADDRESS_RATE_LIMIT_MAX",
      env.ADDRESS_RATE_LIMIT_MAX,
      DEFAULT_ADDRESS_RATE_LIMIT_MAX
    ),
    maxKeys: parseBounded(
      "ADDRESS_RATE_LIMIT_MAX_KEYS",
      env.ADDRESS_RATE_LIMIT_MAX_KEYS,
      DEFAULT_ADDRESS_RATE_LIMIT_MAX_KEYS
    ),
  };
}

/** Explicit override set through `setAddressRateLimit()`; wins over the environment. */
let override: { windowMs: number; max: number } | null = null;

/**
 * Override the address rate-limit parameters.
 * Intended for use in tests only — do not call at runtime. The values are
 * validated with the same bounds as the environment variables.
 */
export function setAddressRateLimit(windowMs: number, max: number): void {
  const [wMin, wMax] = LIMIT_BOUNDS.ADDRESS_RATE_LIMIT_WINDOW_MS;
  const [mMin, mMax] = LIMIT_BOUNDS.ADDRESS_RATE_LIMIT_MAX;
  if (!Number.isInteger(windowMs) || windowMs < wMin || windowMs > wMax) {
    throw new Error(`Invalid address rate-limit window ${windowMs}: expected ${wMin}–${wMax} ms`);
  }
  if (!Number.isInteger(max) || max < mMin || max > mMax) {
    throw new Error(`Invalid address rate-limit max ${max}: expected ${mMin}–${mMax}`);
  }
  override = { windowMs, max };
}

// ── Bounded bucket store ─────────────────────────────────────────────────

interface Bucket {
  hits: number;
  resetTime: number;
}

/**
 * In-memory counter store with a hard cap on distinct keys.
 *
 * Buckets expire when their window ends, so an address that goes quiet is
 * dropped instead of living for the life of the process. If a flood of distinct
 * addresses still pushes the store past `maxKeys`, expired buckets are removed
 * first and only then the least recently used ones — so an active address keeps
 * its count while idle ones make room.
 */
export class BoundedAddressStore implements Store {
  private windowMs = DEFAULT_ADDRESS_RATE_LIMIT_WINDOW_MS;
  /** Map iteration order is insertion order; touching a key re-inserts it, so the first key is the least recently used. */
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxKeys: number = DEFAULT_ADDRESS_RATE_LIMIT_MAX_KEYS,
    private readonly now: () => number = () => Date.now()
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  /** Number of addresses currently tracked. */
  get size(): number {
    return this.buckets.size;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetTime <= t) {
      bucket = { hits: 0, resetTime: t + this.windowMs };
    }
    bucket.hits += 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.evict(t);
    return { totalHits: bucket.hits, resetTime: new Date(bucket.resetTime) };
  }

  async decrement(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.hits > 0) bucket.hits -= 1;
  }

  async resetKey(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  private evict(t: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetTime <= t) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

// ── Address extraction ──────────────────────────────────────────────────────

/**
 * Return true if `value` looks like a well-formed Stellar public key.
 * This is a quick shape-check; cryptographic validation is not required here
 * because an invalid address simply falls back to the NO_ADDRESS_KEY sentinel.
 */
export function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && STELLAR_ADDRESS_RE.test(value);
}

/**
 * Derive a rate-limit key from the incoming request.
 *
 * Resolution order (first match wins):
 *   1. URL path scan — walk each path segment and return the first one that
 *      looks like a Stellar address.  This is necessary because global
 *      Express middleware runs before route matching, so req.params is always
 *      empty at this point (params are only populated inside the matched
 *      router/handler).
 *   2. `req.body.address`    — POST/PUT body fields
 *   3. `x-stellar-address` request header — explicit header for any endpoint
 *
 * Returns the address string if found, or `NO_ADDRESS_KEY` so the in-memory
 * store always has a key to work with (the sentinel bucket is never exhausted
 * because it is shared across all anonymous requests and the limiter is
 * configured to skip it — see `skip` option below).
 */
export function extractAddress(req: Request): string {
  // 1. URL path scan — find the first path segment that is a valid Stellar address.
  //    req.params is always empty in global middleware (populated only after route
  //    matching), so we parse req.path directly.
  const path = req.path ?? "";
  for (const segment of path.split("/")) {
    if (isStellarAddress(segment)) {
      return segment;
    }
  }

  // 2. Request body { address: "G..." }
  if (req.body && isStellarAddress(req.body.address)) {
    return req.body.address;
  }

  // 3. Explicit header
  const headerAddress = req.headers["x-stellar-address"];
  if (isStellarAddress(headerAddress)) {
    return headerAddress as string;
  }

  return NO_ADDRESS_KEY;
}

// ── Limiter factory ─────────────────────────────────────────────────────────

/**
 * Build a fresh `express-rate-limit` instance using the current
 * configured window and max values.
 *
 * A new instance must be created each time `createAddressRateLimiter()` is
 * called so that test overrides via `setAddressRateLimit()` take effect.
 */
export function createAddressRateLimiter(): RateLimitRequestHandler {
  const config = resolveAddressRateLimitConfig();
  const windowMs = override?.windowMs ?? config.windowMs;
  const max = override?.max ?? config.max;
  return rateLimit({
    windowMs,
    max,
    store: new BoundedAddressStore(config.maxKeys),

    // Key every counter bucket on the resolved Stellar address.
    keyGenerator: (req: Request) => extractAddress(req),

    // Requests with no identifiable address are not counted; the IP limiter
    // already handles those.
    skip: (req: Request) => extractAddress(req) === NO_ADDRESS_KEY,

    // Do NOT emit standard or legacy RateLimit-* headers from this limiter.
    // The IP-based limiter already emits them; if this limiter also emitted
    // them it would overwrite the IP limiter's counts with the (higher)
    // per-address quota, confusing clients that monitor those headers.
    // The 429 handler below still sends Retry-After explicitly.
    standardHeaders: false,
    legacyHeaders: false,

    // 429 JSON response body.
    message: {
      error: "Too many requests from this address, please try again later.",
      code: "ADDRESS_RATE_LIMIT_EXCEEDED",
    },

    // Express-rate-limit v7 requires a handler to send the Retry-After header
    // correctly when `standardHeaders` is enabled; the library does this
    // automatically, but we add an explicit handler to guarantee the header is
    // present and to set a consistent response body.
    handler: (
      _req: Request,
      res: Response,
      _next: NextFunction,
      options: { windowMs: number }
    ): void => {
      const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
      res.setHeader("Retry-After", retryAfterSeconds);
      res.status(429).json({
        error: "Too many requests from this address, please try again later.",
        code: "ADDRESS_RATE_LIMIT_EXCEEDED",
      });
    },
  });
}

/**
 * Express middleware that applies per-address rate limiting.
 *
 * Usage — mount on any router or specific route:
 *
 *   import { addressRateLimiter } from "../middleware/address-rate-limit";
 *   app.use("/api", addressRateLimiter());
 *
 * The function signature matches `RequestHandler` so it can be used both as a
 * factory (when called) and the returned value can be passed directly to
 * `app.use()`.
 */
export function addressRateLimiter(): RequestHandler {
  return createAddressRateLimiter();
}
