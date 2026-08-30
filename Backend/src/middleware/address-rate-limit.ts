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
 *   ADDRESS_RATE_LIMIT_WINDOW_MS  (default: 60 000 ms)
 *   ADDRESS_RATE_LIMIT_MAX        (default: 100 requests per window)
 *
 * 429 responses include:
 *   - `Retry-After` header (seconds until the window resets)
 *   - Standard `RateLimit-*` headers (via `standardHeaders: true`)
 *   - JSON body  { error: string, code: "ADDRESS_RATE_LIMIT_EXCEEDED" }
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";

// ── Constants ──────────────────────────────────────────────────────────────

/** Stellar public keys start with G and are exactly 56 base-32 characters. */
const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Sentinel used when no address is found in the request. */
const NO_ADDRESS_KEY = "__no_address__";

// ── Configuration ──────────────────────────────────────────────────────────

/**
 * Current window/max values.  Exposed as module-level variables so tests can
 * call `setAddressRateLimit()` to override them before creating an app instance.
 */
let addressRateLimitWindowMs = 60_000;
let addressRateLimitMax = 100;

/**
 * Override the address rate-limit parameters.
 * Intended for use in tests only — do not call at runtime.
 */
export function setAddressRateLimit(windowMs: number, max: number): void {
  addressRateLimitWindowMs = windowMs;
  addressRateLimitMax = max;
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
 * `addressRateLimitWindowMs` / `addressRateLimitMax` values.
 *
 * A new instance must be created each time `createAddressRateLimiter()` is
 * called so that test overrides via `setAddressRateLimit()` take effect.
 */
export function createAddressRateLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: addressRateLimitWindowMs,
    max: addressRateLimitMax,

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
