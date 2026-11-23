import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, FollowersResponse, FollowingResponse } from "../contracts";
import {
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  parseCursor,
  parseLimit,
  parseOffset,
  parseStellarAddress,
  sendValidationError,
  ValidationResult,
  validate,
} from "../validation";

/**
 * Largest page a follow listing may request. A larger `limit` is rejected with
 * `LIMIT_EXCEEDED` and a message naming the `limit` field, not silently capped.
 */
export const MAX_FOLLOWS_LIMIT = 50;
const MAX_LIMIT = MAX_FOLLOWS_LIMIT;
const parseFollowsLimit = parseLimit(MAX_LIMIT, DEFAULT_LIMIT);

interface FollowsQuery {
  address: string;
  limit: number;
  offset: number;
  cursor?: string;
}

/**
 * Validate the address, pagination and cursor for a follows request.
 *
 * Previously this route validated only the limit and offset and passed the
 * address straight to the database — the one field on the endpoint that is a
 * wallet address was the one field left unchecked (issue #665). It now goes
 * through the shared validator alongside every other public endpoint.
 */
function parseFollowsRequest(req: Request): ValidationResult<FollowsQuery> {
  return validate<FollowsQuery>(
    {
      address: { parse: parseStellarAddress },
      limit: { parse: parseFollowsLimit, required: false, default: DEFAULT_LIMIT },
      offset: { parse: parseOffset, required: false, default: DEFAULT_OFFSET },
      cursor: { parse: parseCursor, required: false },
    },
    {
      address: req.params.address,
      limit: req.query.limit,
      offset: req.query.offset,
      cursor: req.query.cursor,
    }
  );
}

export function createFollowsRouter(db: Database): Router {
  const router = Router();

  /**
   * GET /follows/:address/followers
   * Returns accounts that follow the given address.
   */
  router.get(
    "/:address/followers",
    async (req: Request, res: Response<FollowersResponse | ApiErrorResponse>): Promise<void> => {
      const parsed = parseFollowsRequest(req);
      if (!parsed.ok) {
        sendValidationError(res, parsed.issue);
        return;
      }

      const { address, limit, offset, cursor } = parsed.value;

      if (cursor) {
        // Issue #929: cursor-based pagination follows keyset semantics. We return
        // `next_offset`/`prev_offset` as `null` because the cursor is the opaque
        // boundary key (the last follower returned), not a numeric page offset.
        const { followers, total } = await db.getFollowersAfter(address, cursor, limit);
        res.json({
          address,
          followers,
          total,
          limit,
          offset,
          has_more: followers.length === limit,
          next_offset: null,
          prev_offset: null,
        });
        return;
      }

      const { followers, total } = await db.getFollowers(address, limit, offset);
      const hasMore = offset + followers.length < total;
      res.json({
        address,
        followers,
        total,
        limit,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        prev_offset: offset > 0 ? Math.max(0, offset - limit) : null,
      });
    }
  );

  router.get(
    "/:address/following",
    async (req: Request, res: Response<FollowingResponse | ApiErrorResponse>): Promise<void> => {
      const parsed = parseFollowsRequest(req);
      if (!parsed.ok) {
        sendValidationError(res, parsed.issue);
        return;
      }

      const { address, limit, offset, cursor } = parsed.value;

      if (cursor) {
        const { following, total } = await db.getFollowingAfter(address, cursor, limit);
        res.json({
          address,
          following,
          total,
          limit,
          offset,
          has_more: following.length === limit,
          next_offset: null,
          prev_offset: null,
        });
        return;
      }

      const { following, total } = await db.getFollowing(address, limit, offset);
      const hasMore = offset + following.length < total;
      res.json({
        address,
        following,
        total,
        limit,
        offset,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
        prev_offset: offset > 0 ? Math.max(0, offset - limit) : null,
      });
    }
  );

  return router;
}
