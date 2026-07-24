import "express-async-errors";
import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { Database } from "../db";
import { ApiErrorResponse } from "./contracts";

// Enable BigInt JSON serialization (Express res.json uses JSON.stringify).
(BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
  return String(this);
};
import { createProfilesRouter } from "./routes/profiles";
import { createPostsRouter } from "./routes/posts";
import { createFollowsRouter } from "./routes/follows";
import { createPoolsRouter } from "./routes/pools";

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

// ── Rate limiter middleware ───────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: "draft-7", // Sends RateLimit-* headers (RFC 9110 draft-7)
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    // Respect X-Forwarded-For when running behind a trusted reverse proxy.
    // In production, set `app.set("trust proxy", 1)` and ensure only your
    // load-balancer can set this header.
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      return forwarded.split(",")[0].trim();
    }
    return req.ip ?? "unknown";
  },
  handler: (req: Request, res: Response): void => {
    const retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
    res.status(429).set("Retry-After", String(retryAfter)).json({
      error: "Too many requests. Please retry after the indicated delay.",
      code: "RATE_LIMIT_EXCEEDED",
      retryAfterSeconds: retryAfter,
    });
  },
});

// ── App factory ───────────────────────────────────────────────────────────────

export function createApp(db: Database): express.Application {
  const app = express();
  app.use(express.json());

  if (TRUST_PROXY !== "") {
    app.set("trust proxy", TRUST_PROXY);
  }
  // ── Health check (unlimited) ────────────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response): void => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Apply rate limiting to all /api routes.
  app.use("/api", apiLimiter);

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
  }

  interface ErrorResponse {
    error: string;
    code: string;
  }

  const MAX_LIMIT = 100;
  const DEFAULT_LIMIT = 20;
  const DEFAULT_OFFSET = 0;

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

      res.json({
        posts: posts.map(serializePost),
        total,
        has_more: offset + posts.length < total,
      });
    }
  );

  // ── 404 catch-all for API routes (BE-26) ───────────────────────────────────
  // Returns a consistent JSON error body instead of the default Express HTML.
  app.use("/api/*", (_req: Request, res: Response): void => {
    res.status(404).json({ error: "Route not found", code: "NOT_FOUND" });
  });

  // ── Error handler ─────────────────────────────────────────────────────────────

  // Catch malformed JSON payloads (BE-19).
  app.use((err: Error, _req: Request, res: Response, next: NextFunction): void => {
    // express.json() throws a SyntaxError with status=400 for malformed JSON.
    // We use a type assertion because SyntaxError does not declare `status`.
    if (
      err instanceof SyntaxError &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).status === 400
    ) {
      res.status(400).json({
        error: "Invalid JSON in request body",
        code: "MALFORMED_JSON",
      });
      return;
    }
    next(err);
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (err: Error, _req: Request, res: Response<ApiErrorResponse>, _next: NextFunction): void => {
      console.error(err);
      res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  );

  return app;
}

// Back-compat: export a pre-built app and limiter for tests that import them directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _stub = {} as any;
export const app = createApp(_stub);
export { apiLimiter };

// Server is now started from the main index.ts entry point
