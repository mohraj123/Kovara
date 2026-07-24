import "express-async-errors";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import crypto from "crypto";
import { Database } from "../db";
import { ApiErrorResponse, SearchResponse } from "./contracts";

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

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = parseEnvNumber("PORT", 3000);
const TRUST_PROXY = process.env.TRUST_PROXY ?? "0";
const RATE_LIMIT_WINDOW_MS = parseEnvNumber("RATE_LIMIT_WINDOW_MS", 60000);
const RATE_LIMIT_MAX = parseEnvNumber("RATE_LIMIT_MAX", 100);

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

export function createApp(db: Database, options: AppOptions = {}): express.Application {
  const app = express();

  // ── CORS ──────────────────────────────────────────────────────────────────────
  app.use(cors());

  app.use(express.json());

  // BE-25: Resolve auth middleware — use caller-supplied hook or fall back
  // to the no-op so anonymous access is unchanged by default.
  const authMiddleware: AuthMiddleware = options.authMiddleware ?? noopAuthMiddleware;

  if (TRUST_PROXY !== "") {
    app.set("trust proxy", TRUST_PROXY);
  }

  // ── Correlation ID middleware ────────────────────────────────────────────────
  app.use((req: Request, _res: Response, next: NextFunction): void => {
    const id = (req.headers["x-correlation-id"] as string) || crypto.randomUUID();
    req.correlationId = id;
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
  // ── Health check (unlimited, no auth required) ──────────────────────────────
  app.get("/health", (_req: Request, res: Response): void => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Apply rate limiting to all /api routes.
  // const apiLimiter = createLimiter();
  // app.use("/api", apiLimiter);

  // BE-25: Apply the auth middleware to all /api routes after rate limiting.
  // Routes registered below this line are covered; the health check above is
  // intentionally excluded.
  app.use("/api", authMiddleware);

  // ── Resource routes ────────────────────────────────────────────────────────
  app.use("/api/profiles", createProfilesRouter(db));
  app.use("/api/posts", createPostsRouter(db));
  app.use("/api/follows", createFollowsRouter(db));
  app.use("/api/pools", createPoolsRouter(db));

  // ── Search endpoint ──────────────────────────────────────────────────────────

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
    like_count: number;
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
    like_count: Number(post.like_count),
    created_at: post.created_at instanceof Date ? post.created_at.toISOString() : null,
    deleted: post.deleted_at !== undefined && post.deleted_at !== null,
  });

  app.post(
    "/api/search/posts",
    async (req: Request, res: Response<SearchResponse | ErrorResponse>): Promise<void> => {
      const body = req.body as Partial<SearchQuery>;

      if (
        body.query === undefined ||
        body.query === null ||
        typeof body.query !== "string" ||
        body.query.trim() === ""
      ) {
        res.status(400).json({ error: "query is required", code: "INVALID_QUERY" });
        return;
      }

      if (body.query.length > MAX_QUERY_LENGTH) {
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
        res.status(400).json({
          error: `limit cannot exceed ${MAX_LIMIT}`,
          code: "LIMIT_EXCEEDED",
        });
        return;
      }

      if (!Number.isInteger(offset) || offset < 0) {
        res
          .status(400)
          .json({ error: "offset must be a non-negative integer", code: "INVALID_QUERY" });
        return;
      }

      if (typeof db.searchPosts !== "function") {
        res.status(500).json({ error: "search backend unavailable", code: "SEARCH_UNAVAILABLE" });
        return;
      }

      const { posts, total } = await db.searchPosts({
        query: body.query.trim(),
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

  // ── Error handler ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (err: Error, req: Request, res: Response<ApiErrorResponse>, _next: NextFunction): void => {
      const correlationId = req.correlationId;
      console.error(`[${correlationId}]`, err);

      if (isDatabaseError(err)) {
        res.status(503).json({
          error: "Database unavailable",
          code: "DATABASE_UNAVAILABLE",
          correlationId,
        } as ApiErrorResponse & { correlationId?: string });
        return;
      }

      res.status(500).json({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        correlationId,
      } as ApiErrorResponse & { correlationId?: string });
    }
  );

  return app;
}

// Back-compat: export a pre-built app for tests that import it directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _stub = {} as any;
export const app = createApp(_stub);

// Server is now started from the main index.ts entry point
