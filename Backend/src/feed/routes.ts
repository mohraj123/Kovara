import { Router, Request, Response } from "express";
import { Database, Post } from "../db";
import {
  DEFAULT_FEED_WEIGHTS,
  DEFAULT_TRENDING_WINDOW_DAYS,
  FeedCandidate,
  FeedValidationError,
  parseFeedLimit,
  parseFeedOffset,
  rankFeed,
  validateFeedMode,
} from "./ranking";

/**
 * How many recent candidates the route pulls before ranking.
 *
 * Ranking needs a pool of posts to choose from, but the ranking happens in the
 * API process, not the database, so the pool has to be bounded. This is
 * deliberately larger than any page: a caller asking for the top 20 by
 * engagement needs more than 20 posts to rank, and too small a window would
 * make "top by engagement" silently mean "most engaged of the 20 newest".
 */
const CANDIDATE_LIMIT = 500;

/**
 * The ranked feed (#676).
 *
 * Three modes, one endpoint:
 *
 *   GET /feed                        — ranked (engagement + recency)
 *   GET /feed?mode=recent            — newest first
 *   GET /feed?mode=trending          — engagement rate within a window
 *   GET /feed?author=<address>       — scope to one author
 *
 * The response echoes the ranking rules (weights, trending window) so the
 * order is explainable to a client without reading this file. An empty feed is
 * a `200` with `entries: []` and `candidate_count: 0` — an author with no posts
 * yet is a normal state, not a 404.
 */
export function createFeedRouter(db: Database): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    try {
      const mode = validateFeedMode(req.query.mode);
      const limit = parseFeedLimit(req.query.limit);
      const offset = parseFeedOffset(req.query.offset);
      const author = req.query.author ? String(req.query.author) : undefined;

      // Over-fetch: rank over a bounded window, then page within it.
      const { posts } = await db.listPosts({
        ...(author ? { author } : {}),
        limit: CANDIDATE_LIMIT,
        offset: 0,
      });

      const result = rankFeed(posts.map(toCandidate), {
        mode,
        limit,
        offset,
        weights: DEFAULT_FEED_WEIGHTS,
        trendingWindowDays: DEFAULT_TRENDING_WINDOW_DAYS,
      });

      res.json({
        entries: result.entries,
        mode: result.mode,
        total: result.candidate_count,
        limit: result.limit,
        offset: result.offset,
        has_more: result.has_more,
        ranking: result.ranking,
      });
    } catch (err) {
      if (err instanceof FeedValidationError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  return router;
}

function toCandidate(post: Post): FeedCandidate {
  return {
    id: post.id,
    author: post.author,
    content: post.content,
    tip_total: post.tip_total,
    like_count: post.like_count,
    created_ledger: post.created_ledger,
    created_at: post.created_at ?? null,
    deleted_at: post.deleted_at ?? null,
  };
}
