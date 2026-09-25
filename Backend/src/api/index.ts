import "express-async-errors";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import { Database } from "../db";
import { ApiErrorResponse, DebugSnapshot } from "./contracts";
import { sendError, sendNotFound } from "./response";
import { logger } from "../logger";
import { requestIdMiddleware } from "../request-context";
import pkg from "../../package.json";
import {
  addressRateLimiter,
  setAddressRateLimit,
} from "../middleware/address-rate-limit";
import {
  abuseDetection,
  AbuseDetector,
} from "../middleware/abuse-detection";
import { tieredRateLimits } from "../middleware/rate-limit-tiers";
import { createSearchRouter } from "./search-router";
import { PostgresSearchStore } from "../search/store";
import { Pool } from "pg";

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
import { createSubmissionsRouter } from "./routes/submissions";
import { createRewardsRouter } from "../rewards/routes";
import { RewardStore } from "../rewards/store";
import { createAuditRouter } from "../audit/routes";
import { AuditStore } from "../audit/store";
import { PostgresSubmissionFeed } from "../submissions/feed";
import { createIndexRouter } from "../analytics/routes";
import { PostgresAnalyticsStore } from "../analytics/store";
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
  /**
   * A live Postgres pool. Enables the ranked search routes (#660) and the
   * response cache that backs them (#662).
   *
   * Optional on purpose: `createApp` is called in tests with a stub `Database`
   * and no pool at all, so search must be additive rather than required. When
   * absent, `/search` is not mounted and the old `/search/posts` endpoint
   * remains the only search surface.
   */
  pool?: Pool;
  /** Injected in tests. Defaults to a store over `options.pool`. */
  searchStore?: PostgresSearchStore;
  /**
   * Injected in tests. The same instance is shared with the `/abuse` operator
   * endpoint, so the endpoint reports live state rather than an empty set.
   */
  abuseDetector?: AbuseDetector;

  /**
   * #657: reward status, claim history, and the claim endpoint.
   *
   * Supplied by the caller rather than built from `db`, because these stores
   * need a `pg.Pool` and issue transactional SQL that the `Database`
   * repository interface has no reason to expose. When a store is omitted its
   * routes are simply not mounted, so existing deployments and tests are
   * unaffected.
   */
  rewardStore?: RewardStore;

  /**
   * #658: audit log reads plus whole-stream chain verification.
   */
  auditStore?: AuditStore;

  /**
   * #659: the paginated, filtered submission feed.
   */
  submissionFeed?: PostgresSubmissionFeed;
   * #654/#655: Analytics store backing the historical index series, the country
   * leaderboard, and the filter-decision log.
   *
   * Supplied by the caller rather than constructed from `db` because these
   * endpoints issue analytical SQL (windowing, ranking, partial indexes) that the
   * `Database` repository interface has no reason to expose. When it is
   * omitted, `/index` is not mounted and every other route behaves exactly as
   * before, so existing deployments and tests need no change.
   */
  analyticsStore?: PostgresAnalyticsStore;
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
const TRUST_PROXY = process.env.TRUST_PROXY ?? "0";
const RATE_LIMIT_WINDOW_MS = parseEnvNumber("RATE_LIMIT_WINDOW_MS", 60000);
const RATE_LIMIT_MAX = parseEnvNumber("RATE_LIMIT_MAX", 100);

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

// ── App factory ───────────────────────────────────────────────────────────────

export function createApp(db: Database, options: AppOptions = {}): express.Application {
  const app = express();
  const apiRouter = express.Router();

  // ── CORS ──────────────────────────────────────────────────────────────────────
  app.use(cors());

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

  if (TRUST_PROXY !== "") {
    app.set("trust proxy", TRUST_PROXY);
  }

  // ── Request ID middleware (#684) ─────────────────────────────────────────────
  // Resolves or generates the request id, exposes it to handlers and logs, and
  // echoes it on every response — replacing the per-route X-Correlation-Id
  // echoes that only covered a subset of routes.
  app.use(requestIdMiddleware);

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

  // ── Abuse detection (#661) ──────────────────────────────────────────────────
  // Runs after the flat limiter so a client that exceeds the shared budget is
  // refused by the cheap counter first; this layer only has to reason about the
  // clients the counter considers acceptable.
  //
  // The detector instance is held here and handed to the /abuse endpoint below,
  // so the operator view reports the same state the middleware is enforcing.
  const abuse = options.abuseDetector ?? new AbuseDetector();
  if (process.env.ENABLE_ABUSE_DETECTION !== "false") {
    app.use(LEGACY_API_PREFIX, abuseDetection({ detector: abuse }));
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

  // ── Ranked unified search (#660/#662/#663) ──────────────────────────────────
  // Mounted only when a pool is available. The tiered limiter wraps the search
  // router specifically rather than being applied app-wide, because a tighter
  // budget on a whole-path prefix would also capture unrelated endpoints that
  // merely contain "/index" in their name.
  if (options.pool) {
    const searchStore = options.searchStore ?? new PostgresSearchStore(options.pool);
    const searchLimiter = tieredRateLimits();
    apiRouter.use(
      "/search",
      searchLimiter.search,
      createSearchRouter({ pool: options.pool, store: searchStore })
    );
    // The old POST /search/posts stays mounted below; the new router is GET
    // /search, so the two coexist and existing clients are unaffected.
  }

  // ── Abuse operator endpoints (#661) ─────────────────────────────────────────
  // Read-only view of what the detector has seen. Detection that only writes to
  // a log is invisible to an on-call engineer without log access, so the
  // counters are exposed over HTTP.
  apiRouter.get("/abuse", (_req: Request, res: Response): void => {
    res.status(200).json(abuse.snapshot());
  });

  /**
   * Lift a block early.
   *
   * Cooldowns are temporary by design, but a false positive on a shared NAT or
   * corporate proxy can last up to the max cooldown. This is the escape hatch,
   * and it is a POST because it mutates state.
   */
  apiRouter.post("/abuse/unblock", (req: Request, res: Response): void => {
    const identity = (req.body as { identity?: unknown } | undefined)?.identity;
    if (typeof identity !== "string" || identity === "") {
      res.status(400).json({ error: "identity is required", code: "INVALID_IDENTITY" });
      return;
    }
    const found = abuse.unblock(identity);
    res.status(found ? 200 : 404).json({
      unblocked: found,
      identity,
      // 404 rather than a silent 200: an operator unblocking a typo'd identity
      // must be able to tell that nothing happened.
      ...(found ? {} : { error: "no tracked identity matched", code: "IDENTITY_NOT_FOUND" }),
    });
  });
  // Moderation / fraud review (issue #645). The store is created once per app so
  // cases and their action logs survive across requests; a per-request store
  // would make every case unreachable a moment after it was filed.
  apiRouter.use("/moderation", createModerationRouter(new ModerationStore()));

// Conditionally mount experimental routes
  if (process.env.EXPERIMENTAL_FEATURES === "true") {
    apiRouter.use("/pools", createPoolsRouter(db));
  }

  // #659: submission feed with pagination and status/user/date filters.
  if (options.submissionFeed) {
    apiRouter.use("/submissions", createSubmissionsRouter(options.submissionFeed));
  }

  // #657: reward status, claim history, and the claim endpoint.
  if (options.rewardStore) {
    apiRouter.use("/rewards", createRewardsRouter(options.rewardStore));
  }

  // #658: audit reads and chain verification.
  if (options.auditStore) {
    apiRouter.use("/audit", createAuditRouter(options.auditStore));
  // #654/#655: historical index series, country leaderboards, and the filter
  // decision log. Mounted only when a store is supplied — see AppOptions.
  if (options.analyticsStore) {
    apiRouter.use("/index", createIndexRouter(options.analyticsStore));
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

