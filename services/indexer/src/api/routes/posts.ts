import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, PostListResponse, PostResponse } from "../contracts";
import { serializeBigInt } from "../index";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_OFFSET = 0;

export function createPostsRouter(db: Database): Router {
  const router = Router();

  /**
   * GET /posts?author=<address>&limit=<n>&offset=<n>
   * Lists posts with optional author filter and pagination.
   */
  router.get(
    "/",
    async (req: Request, res: Response<PostListResponse | ApiErrorResponse>): Promise<void> => {
      if (req.correlationId) {
        res.set("X-Correlation-Id", req.correlationId);
      }

      const author = typeof req.query.author === "string" ? req.query.author : undefined;

      const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_LIMIT;
      const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : DEFAULT_OFFSET;

      if (!Number.isInteger(rawLimit) || rawLimit < 1) {
        res.status(400).json({ error: "limit must be a positive integer", code: "INVALID_QUERY" });
        return;
      }
      if (rawLimit > MAX_LIMIT) {
        res.status(400).json({ error: `limit cannot exceed ${MAX_LIMIT}`, code: "LIMIT_EXCEEDED" });
        return;
      }
      if (!Number.isInteger(rawOffset) || rawOffset < 0) {
        res
          .status(400)
          .json({ error: "offset must be a non-negative integer", code: "INVALID_QUERY" });
        return;
      }

      const { posts, total } = await db.listPosts({ author, limit: rawLimit, offset: rawOffset });
      res.json(
        serializeBigInt({
          posts,
          total,
          limit: rawLimit,
          offset: rawOffset,
          has_more: rawOffset + posts.length < total,
        })
      );
    }
  );

  /**
   * GET /posts/:id
   * Returns a single post by its numeric ID.
   */
  router.get(
    "/:id",
    async (req: Request, res: Response<PostResponse | ApiErrorResponse>): Promise<void> => {
      if (req.correlationId) {
        res.set("X-Correlation-Id", req.correlationId);
      }

      const rawId = req.params.id;

      let postId: bigint;
      try {
        postId = BigInt(rawId);
        if (postId < BigInt(0)) throw new Error();
      } catch {
        res.status(400).json({ error: "id must be a non-negative integer", code: "INVALID_ID" });
        return;
      }

      const post = await db.getPost(postId);
      if (!post) {
        res.status(404).json({ error: "Post not found", code: "NOT_FOUND" });
        return;
      }

      res.json(serializeBigInt(post));
    }
  );

  return router;
}
