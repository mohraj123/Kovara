import "express-async-errors";
import express, { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
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

// ── Rate-limit configuration (all values are env-overridable) ────────────────

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10);

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

  const MAX_LIMIT = 100;
  const DEFAULT_LIMIT = 20;
  const DEFAULT_OFFSET = 0;

  app.post(
    "/api/search/posts",
    (req: Request, res: Response<SearchResponse | ApiErrorResponse>): void => {
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

      // TODO: integrate with the search database.
      res.json({ posts: [], total: 0, has_more: false, limit, offset });
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

// Back-compat: export a pre-built app and limiter for tests that import them directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _stub = {} as any;
export const app = createApp(_stub);
export { apiLimiter };

// ── Server bootstrap (skipped when imported in tests) ────────────────────────

if (require.main === module) {
  const PORT = parseInt(process.env.PORT ?? "3001", 10);
  app.listen(PORT, () => {
    console.log(`Indexer API listening on port ${PORT}`);
    console.log(
      `Rate limit: ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s per IP`
    );
  });
}
