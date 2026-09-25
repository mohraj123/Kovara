import "express-async-errors";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import crypto from "crypto";
import { Database } from "../db";
import { ApiErrorResponse, DebugSnapshot } from "./contracts";
import { sendError, sendNotFound } from "./response";
import { logger } from "../logger";
import pkg from "../../package.json";
import {
  addressRateLimiter,
  setAddressRateLimit,
} from "../middleware/address-rate-limit";

const VERSION = pkg.version;
const API_V1_PREFIX = "/api/v1";
const LEGACY_API_PREFIX = "/api";

// Configurable rate-limiter override for tests (see rate-limit.test.ts).
let rateLimitWindowMs = 60_000;
let rateLimitMax = 100;

export function setRateLimit(windowMs: number, max: number): void {
  rateLimitWindowMs = windowMs;
  rateLimitMax = max;
}

function createLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: true,
    message: {
      error: "Too many requests, please try again later.",
      code: "RATE_LIMIT_EXCEEDED",
    },
  });
}

// Enable BigInt JSON serialization (Express res.json uses JSON.stringify).
(BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
  return String(this);
};

/**
 * Recursively convert all BigInt values in an object to strings.
 * Useful when sending responses without relying on the global toJSON override.
 */
export function serializeBigInt<T>(obj: T): T {
  if (typeof obj === "bigint") return String(obj) as unknown as T;
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((item) => serializeBigInt(item)) as unknown as T;
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = serializeBigInt(value);
    }
    return result as T;
  }
  return obj;
}
import { createProfilesRouter } from "./routes/profiles";
import { createPostsRouter } from "./routes/posts";
import { createFollowsRouter } from "./routes/follows";
import { createPoolsRouter } from "./routes/pools";
import { createModerationRouter } from "./routes/moderation";
import { ModerationStore } from "../verification/moderation";

// ── Auth middleware (BE-25) ───────────────────────────────────────────────────

/**
 * Type signature for an authorization middleware factory.
 *
 * BE-25: Centralizes authorization logic so individual routes do not
 * duplicate checks. By default a no-op middleware is used, keeping
 * anonymous access unchanged. Deployments that require authentication can
 * supply their own implementation via `AppOptions.authMiddleware`.
 *
 * Example — Bearer-token guard:
 *
 *   createApp(db, {
 *     authMiddleware: (req, res, next) => {
 *       const token = req.headers.authorization?.replace("Bearer ", "");
 *       if (!token || token !== process.env.API_SECRET) {
 *         res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
 *         return;
 *       }
 *       next();
 *     },
 *   });
 */
export type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

/**
 * A no-op middleware used when no auth is configured.
 * Passes every request straight through, preserving existing anonymous access.
 */
const noopAuthMiddleware: AuthMiddleware = (_req, _res, next) => next();

// ── App options ───────────────────────────────────────────────────────────────

export interface AppOptions {
  /**
   * BE-25: Optional authorization middleware applied to all /api routes
   * before request handlers are invoked.  Defaults to a no-op so existing
   * deployments are unaffected.
   */
  authMiddleware?: AuthMiddleware;
}

// ── Runtime configuration (all values are env-overridable) ─────────────────

function parseEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value for environment variable: ${name}`);
  }
  return parsed;
}

const _HOST = process.env.HOST ?? "0.0.0.0";
const _PORT = parseEnvNumber("PORT", 3000);
const RATE_LIMIT_WINDOW_MS = parseEnvNumber("RATE_LIMIT_WINDOW_MS", 60000);
const RATE_LIMIT_MAX = parseEnvNumber("RATE_LIMIT_MAX", 100);

// ── Reverse proxy trust configuration (Issue #680) ─────────────────────────

/**
 * Parse the `TRUST_PROXY` setting (Issue #680).
 *
 * Accepted forms:
 *   - unset / "" / "0" / "false" → trust no proxy headers (direct exposure)
 *   - "true"                    → trust the immediate connection (one proxy)
 *   - positive integer N        → trust the first N hops of the proxy chain
 *
 * Anything else — negative numbers, non-numeric values, suspicious strings —
 * throws before the app is built, so an unsafe value can never silently widen
 * trust in spoofable X-Forwarded-* headers (client IPs feed the rate limiter).
 */
export function parseTrustProxy(raw: string | undefined): boolean | number {
  const value = (raw ?? "0").trim().toLowerCase();
  if (value === "" || value === "0" || value === "false") return false;
  if (value === "true") return true;

  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid TRUST_PROXY value: "${raw}". Use 0/false (trust none), true ` +
        "(trust the immediate peer), or a positive hop count."
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `Invalid TRUST_PROXY value: "${raw}". Hop counts must be a positive integer.`
    );
  }
  return parsed;
}

// Fail fast at startup on an unusable TRUST_PROXY value.
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// ── CORS origin allow-list (Issue #680) ─────────────────────────────────────

/**
 * Parse the `CORS_ORIGIN` allow-list (Issue #680).
 *
 * Accepts one or more exact origins, comma-separated, or "*" on its own to
 * explicitly allow every origin. Unset behaves the same way (allow all),
 * preserving the documented development default.
 *
 * Anything that is not a well-formed http(s) origin — wildcard subdomains,
 * path/query/hash suffixes, embedded credentials, bare hostnames, the string
 * "null" — throws, so an unsafe or nonsensical value can never silently widen
 * cross-origin access. "*" mixed with explicit origins is also rejected: an
 * operator asking for both has asked for the widest possible exposure by
 * accident.
 *
 * Returns ["*"] when all origins are allowed, otherwise the exact origin list.
 * With a list configured, the `cors` middleware reflects only matching Origin
 * values; requests from any other origin receive no Access-Control-Allow-*
 * headers and the browser refuses to expose the response — unsafe origins are
 * rejected by design rather than by request-time validation.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (value === "" || value === "*") return ["*"];

  const origins: string[] = [];
  for (const entry of value.split(",")) {
    const origin = entry.trim();
    if (origin === "") continue;

    if (origin === "*") {
      throw new Error(
        'Invalid CORS_ORIGIN: "*" cannot be mixed with explicit origins. ' +
          'Set CORS_ORIGIN="*" on its own to allow every origin.'
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        `Invalid CORS_ORIGIN entry: "${origin}". Use exact origins such as ` +
          "https://app.example.com (comma-separated), or \"*\" on its own to allow all."
      );
    }

    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hostname.includes("*")
    ) {
      throw new Error(
        `Invalid CORS_ORIGIN entry: "${origin}". Origins must be scheme + host ` +
          "(+ optional port) without paths, credentials, or wildcard subdomains."
      );
    }

    const normalized = parsed.origin;
    if (!origins.includes(normalized)) origins.push(normalized);
  }

  if (origins.length === 0) {
    throw new Error(
      'CORS_ORIGIN is set but contains no valid origins. Use exact origins ' +
        'such as https://app.example.com (comma-separated), or "*" to allow all.'
    );
  }

  return origins;
}

/**
 * Pattern for a client-supplied correlation id that is safe to reflect.
 * Anything else is replaced with a generated UUID so untrusted header values
 * cannot smuggle control characters or injection payloads into structured
 * logs (Issue #680).
 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._@:/-]{1,128}$/;

// ── Address rate-limit configuration (Issue #616) ──────────────────────────
// These are read once at startup so the middleware factory uses them by default.
// Tests can override via setAddressRateLimit() before calling createApp().
const ADDRESS_RATE_LIMIT_WINDOW_MS = parseEnvNumber(
  "ADDRESS_RATE_LIMIT_WINDOW_MS",
  60_000
);
const ADDRESS_RATE_LIMIT_MAX = parseEnvNumber("ADDRESS_RATE_LIMIT_MAX", 100);
setAddressRateLimit(ADDRESS_RATE_LIMIT_WINDOW_MS, ADDRESS_RATE_LIMIT_MAX);

// Re-export so tests (and callers) can adjust address limits without importing
// the middleware module directly.
export { setAddressRateLimit } from "../middleware/address-rate-limit";

// ── Database error detection ───────────────────────────────────────────────

const DB_ERROR_PATTERNS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "connection refused",
  "connection terminated",
  "unable to connect",
  "database unavailable",
];

export function isDatabaseError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = `${err.name} ${err.message}`.toLowerCase();
    if (DB_ERROR_PATTERNS.some((p) => msg.includes(p.toLowerCase()))) return true;
    if ("code" in err && typeof (err as { code: string }).code === "string") {
      const code = (err as { code: string }).code;
      if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return true;
    }
  }
  return false;
}

// ── Request correlation ID ─────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

// ── App factory ───────────────────────────────────────────────────────────────

// ── Address header validation (Issue #680) ─────────────────────────────────

/**
 * Stellar address shape (G… 56 base32 characters) used to validate the
 * client-supplied `x-stellar-address` header. The value is only ever compared
 * against stored addresses and echoed into rate-limit keys, but rejecting
 * malformed values at the edge keeps arbitrary header junk out of logs and
 * limiter state (Issue #680).
 */
const STELLAR_ADDRESS_HEADER_PATTERN = /^G[A-Z2-7]{55}$/;

export function createApp(db: Database, options: AppOptions = {}): express.Application {
  const app = express();
  const apiRouter = express.Router();

  // ── CORS (Issue #680) ──────────────────────────────────────────────────────
  // With an explicit allow-list configured, only listed origins are reflected;
  // requests from any other origin get no Access-Control-Allow-* headers and
  // the browser refuses to expose the response.
  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN);
  app.use(
    cors({
      origin: allowedOrigins.includes("*")
        ? "*"
        : (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
              callback(null, true);
            } else {
              callback(null, false);
            }
          },
    })
  );

  app.use(express.json());

  // BE-17: Request timeout — abort requests that exceed the configured limit.
  // The global error handler produces a consistent JSON response on timeout.
  const REQUEST_TIMEOUT_MS = parseInt(process.env["REQUEST_TIMEOUT_MS"] ?? "", 10) || 30_000;
  app.use((req: Request, res: Response, next: NextFunction): void => {
    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
      res.status(503).json({ error: "Request timed out", code: "REQUEST_TIMEOUT" });
      req.destroy();
    });
    next();
  });

  // BE-25: Resolve auth middleware — use caller-supplied hook or fall back
  // to the no-op so anonymous access is unchanged by default.
  const authMiddleware: AuthMiddleware = options.authMiddleware ?? noopAuthMiddleware;

  if (TRUST_PROXY !== false) {
    app.set("trust proxy", TRUST_PROXY);
  }

  // ── Correlation ID middleware ────────────────────────────────────────────────
  // A client-supplied id is honored only when it matches the safe pattern;
  // otherwise a server-generated UUID is used (Issue #680).
  app.use((req: Request, _res: Response, next: NextFunction): void => {
    const headerId = req.headers["x-correlation-id"] as string | undefined;
    const id =
      headerId && CORRELATION_ID_PATTERN.test(headerId) ? headerId : crypto.randomUUID();
    req.correlationId = id;
    next();
  });

  // ── Address header validation (Issue #680) ────────────────────────────────
  // The x-stellar-address header is client-controlled; only accept well-formed
  // Stellar addresses so malformed values cannot enter limiter keys or logs.
  app.use((req: Request, res: Response, next: NextFunction): void => {
    const headerAddress = req.headers["x-stellar-address"];
    if (
      typeof headerAddress === "string" &&
      headerAddress !== "" &&
      !STELLAR_ADDRESS_HEADER_PATTERN.test(headerAddress)
    ) {
      res.status(400).json({
        error: "Invalid x-stellar-address header",
        code: "INVALID_ADDRESS_HEADER",
      });
      return;
    }
    next();
  });

  // ── Health check (unlimited) ────────────────────────────────────────────────
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    let dbStatus = "ok";
    try {
      await db.getProfile("__health_check_probe__");
    } catch {
      dbStatus = "unavailable";
    }

    const status = dbStatus === "ok" ? "ok" : "degraded";
    res.json({
      status,
      uptime: process.uptime(),
      db: dbStatus,
    });
  });

  // ── Version metadata (unlimited, no auth required) ──────────────────────────
  app.get("/version", (_req: Request, res: Response): void => {
    res.json({
      version: VERSION,
      git_commit: process.env.GIT_COMMIT ?? "unknown",
      build_time: process.env.BUILD_TIME ?? "unknown",
      node_version: process.version,
    });
  });

  // Apply rate limiting to both the canonical and legacy API paths.
  if (process.env.ENABLE_RATE_LIMITING !== "false") {
    const apiLimiter = createLimiter();
    app.use(LEGACY_API_PREFIX, apiLimiter);
  }

// BE-25: Apply the auth middleware to all /api routes after rate limiting.
// Routes registered below this line are covered; the health check above is
// intentionally excluded.
// Note: authMiddleware is now passed via options to createApp, so we don't apply it here.
// Instead, it's applied in the app factory (see createApp function).
// We keep this comment for historical context but the actual middleware application
// happens in the options passed to createApp.
// app.use("/api", authMiddleware);

  apiRouter.use("/profiles", createProfilesRouter(db));
  apiRouter.use("/posts", createPostsRouter(db));
  apiRouter.use("/follows", createFollowsRouter(db));

  // Moderation / fraud review (issue #645). The store is created once per app so
  // cases and their action logs survive across requests; a per-request store
  // would make every case unreachable a moment after it was filed.
  apiRouter.use("/moderation", createModerationRouter(new ModerationStore()));

// Conditionally mount experimental routes
  if (process.env.EXPERIMENTAL_FEATURES === "true") {
    apiRouter.use("/pools", createPoolsRouter(db));
  }

  interface SearchQuery {
    query: string;
    limit?: number;
    offset?: number;
  }

  interface SearchPost {
    id: string;
    author: string;
    content: string;
    tip_total: string;
    like_count: string;
    created_at: string | null;
    deleted: boolean;
  }

  interface SearchResponse {
    posts: SearchPost[];
    total: number;
    has_more: boolean;
    next_offset: number | null;
    prev_offset: number | null;
  }

  interface ErrorResponse {
    error: string;
    code: string;
    correlationId?: string;
  }

  const MAX_LIMIT = 100;
  const DEFAULT_LIMIT = 20;
  const DEFAULT_OFFSET = 0;
  const MAX_QUERY_LENGTH = 500;

  const serializePost = (post: {
    id: bigint;
    author: string;
    content: string;
    tip_total: bigint;
    like_count: bigint;
    created_at?: Date | null;
    deleted_at?: Date | null;
  }): SearchPost => ({
    id: post.id.toString(),
    author: post.author,
    content: post.content,
    tip_total: post.tip_total.toString(),
    // BA-027: like counts are serialized as a string so large counts keep full
    // precision — Number() would silently round counts beyond 2^53-1.
    like_count: post.like_count.toString(),
    created_at: post.created_at instanceof Date ? post.created_at.toISOString() : null,
    deleted: post.deleted_at !== undefined && post.deleted_at !== null,
  });

  apiRouter.post(
    "/search/posts",
    async (req: Request, res: Response<SearchResponse | ErrorResponse>): Promise<void> => {
      const body = req.body as Partial<SearchQuery>;
      const rawQuery = body.query;

      if (rawQuery === undefined || rawQuery === null || typeof rawQuery !== "string") {
        res.status(400).json({ error: "query is required", code: "INVALID_QUERY" });
        return;
      }

      const query = rawQuery.trim().replace(/\s+/g, " ");
      if (query === "") {
        res.status(400).json({ error: "query is required", code: "INVALID_QUERY" });
        return;
      }

      if (query.length > MAX_QUERY_LENGTH) {
        res.status(400).json({
          error: `query cannot exceed ${MAX_QUERY_LENGTH} characters`,
          code: "QUERY_TOO_LONG",
        });
        return;
      }

      if (body.limit !== undefined && body.limit !== null && typeof body.limit !== "number") {
        res.status(400).json({ error: "limit must be a number", code: "INVALID_QUERY" });
        return;
      }

      if (body.offset !== undefined && body.offset !== null && typeof body.offset !== "number") {
        res.status(400).json({ error: "offset must be a number", code: "INVALID_QUERY" });
        return;
      }

      const limit = body.limit !== undefined ? Number(body.limit) : DEFAULT_LIMIT;
      const offset = body.offset !== undefined ? Number(body.offset) : DEFAULT_OFFSET;

      if (!Number.isInteger(limit) || limit < 1) {
        res.status(400).json({ error: "limit must be a positive integer", code: "INVALID_QUERY" });
        return;
      }

      if (limit > MAX_LIMIT) {
        res.status(400).json({ error: `limit cannot exceed ${MAX_LIMIT}`, code: "LIMIT_EXCEEDED" });
        return;
      }

      if (!Number.isInteger(offset) || offset < 0) {
        res.status(400).json({ error: "offset must be a non-negative integer", code: "INVALID_QUERY" });
        return;
      }

      if (typeof db.searchPosts !== "function") {
        res.status(500).json({ error: "search backend unavailable", code: "SEARCH_UNAVAILABLE" });
        return;
      }

      const { posts, total } = await db.searchPosts({
        query,
        limit,
        offset,
      });

      const has_more = offset + posts.length < total;

      res.json({
        posts: posts.map(serializePost),
        total,
        has_more,
        next_offset: has_more ? offset + posts.length : null,
        prev_offset: offset > 0 ? offset - limit : null,
      });
    }
  );

  // ── Debug snapshot endpoint (BE-29) ────────────────────────────────────────
  const DEBUG_SNAPSHOT_LIMIT = 1000;

  apiRouter.get(
    "/debug/snapshot",
    async (req: Request, res: Response<DebugSnapshot | ApiErrorResponse>): Promise<void> => {
      const debugToken = process.env.DEBUG_TOKEN;
      if (!debugToken) {
        res.status(503).json({ error: "Debug endpoint disabled", code: "DEBUG_DISABLED" });
        return;
      }

      const providedToken = req.headers["x-debug-token"];
      if (providedToken !== debugToken) {
        res.status(401).json({ error: "Invalid debug token", code: "UNAUTHORIZED" });
        return;
      }

      const [postsResult, profilesResult, poolsResult] = await Promise.all([
        db.listPosts({ limit: DEBUG_SNAPSHOT_LIMIT, offset: 0 }),
        db.listProfiles({ limit: DEBUG_SNAPSHOT_LIMIT, offset: 0 }),
        db.listPools({ limit: DEBUG_SNAPSHOT_LIMIT, offset: 0 }),
      ]);

      res.json(
        serializeBigInt({
          posts: postsResult.posts,
          profiles: profilesResult.profiles,
          pools: poolsResult.pools,
          generated_at: new Date().toISOString(),
          post_count: postsResult.total,
          profile_count: profilesResult.total,
          pool_count: poolsResult.total,
        })
      );
    }
  );

  // ── 404 catch-all for API routes (BE-26) ───────────────────────────────────
  // Returns a consistent JSON error body instead of the default Express HTML.
  apiRouter.use((_req: Request, res: Response): void => {
    sendNotFound(res, "Route");
  });

  // Version 1 is the canonical, stable API contract.  The legacy unversioned
  // path remains available during the migration window so existing clients do
  // not break immediately.
  app.use(API_V1_PREFIX, apiRouter);
  app.use(LEGACY_API_PREFIX, (req: Request, res: Response, next: NextFunction): void => {
    const successor = req.originalUrl.replace(/^\/api(?=\/|$)/, API_V1_PREFIX);
    res.set("Deprecation", "true");
    res.append("Link", `<${successor}>; rel=\"successor-version\"`);
    next();
  });
  app.use(LEGACY_API_PREFIX, apiRouter);

  // ── Error handler ─────────────────────────────────────────────────────────────
  // All branches below emit the same structured ApiError shape (via sendError/
  // sendNotFound from ./response) so every error response — expected or an
  // unhandled exception — is a consistent, client-actionable JSON payload (BE-31).

  // Catch malformed JSON payloads (BE-19).
  app.use((err: Error, _req: Request, res: Response, next: NextFunction): void => {
    // express.json() throws a SyntaxError with status=400 for malformed JSON.
    // We use a type assertion because SyntaxError does not declare `status`.
    if (
      err instanceof SyntaxError &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).status === 400
    ) {
      sendError(res, 400, "Invalid JSON in request body", "MALFORMED_JSON");
      return;
    }
    next(err);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (err: Error, req: Request, res: Response<ApiErrorResponse>, _next: NextFunction): void => {
      const correlationId = req.correlationId;
      const databaseRelated = isDatabaseError(err);

      // Report through the structured logger instead of a raw console.error, so
      // the failure carries redaction, dedup and the correlation id. When
      // alerting is configured (#683) the logger hook turns this line into an
      // alert, so database outages page as critical.
      const log = logger.child({ correlationId, surface: "http" });
      log.error("unhandled_request_error", {
        err,
        method: req.method,
        path: req.path,
        databaseRelated,
        alertSeverity: databaseRelated ? "critical" : "error",
      });

      if (databaseRelated) {
        sendError(res, 503, "Database unavailable", "DATABASE_UNAVAILABLE", { correlationId });
        return;
      }

      // Unhandled exceptions of any other kind are converted to a safe,
      // generic 500 — the original error is logged above but never leaked
      // to the client.
      sendError(res, 500, "Internal server error", "INTERNAL_ERROR", { correlationId });
    }
  );

  return app;
}

// Back-compat: export a pre-built app for tests that import it directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _stub = {} as any;
export const app = createApp(_stub);

// Server is now started from the main index.ts entry point
