import "express-async-errors";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit, { RateLimitRequestHandler } from "express-rate-limit";
import { Database } from "../db";
import { ApiErrorResponse, SearchResponse } from "./contracts";

// Enable BigInt JSON serialization (Express res.json uses JSON.stringify).
(BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
  return String(this);
};
import { createProfilesRouter } from "./routes/profiles";
import { createPostsRouter } from "./routes/posts";
import { createFollowsRouter } from "./routes/follows";
import { createPoolsRouter } from "./routes/pools";

// ── Runtime configuration (all values are env-overridable) ─────────────────

let RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);
let RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10);

/**
 * Override rate-limit values at runtime (useful in tests).
 */
export function setRateLimit(windowMs: number, max: number): void {
  RATE_LIMIT_WINDOW_MS = windowMs;
  RATE_LIMIT_MAX = max;
}

// ── Rate limiter middleware factory ──────────────────────────────────────────

function createLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
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
}
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

  // ── CORS ──────────────────────────────────────────────────────────────────────
  app.use(cors());

  app.use(express.json());

  if (TRUST_PROXY !== "") {
    app.set("trust proxy", TRUST_PROXY);
  }
  // ── Health check (unlimited) ────────────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response): void => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  // Apply rate limiting to all /api routes.
  const apiLimiter = createLimiter();
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

      const { posts, total } = await db.searchPosts(body.query.trim(), limit, offset);
      res.json({
        posts: posts.map((p) => ({
          id: String(p.id),
          author: p.author,
          content: p.content,
          tip_total: String(p.tip_total),
          like_count: String(p.like_count),
          created_ledger: p.created_ledger,
        })),
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

  // ── Error handler ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (err: Error, _req: Request, res: Response<ApiErrorResponse>, _next: NextFunction): void => {
      console.error(err);
      res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  );

  return app;
}

// Back-compat: export a pre-built app for tests that import it directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _stub = {} as any;
export const app = createApp(_stub);

// Server is now started from the main index.ts entry point