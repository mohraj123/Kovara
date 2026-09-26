import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, FollowersResponse, FollowingResponse } from "../contracts";
import {
  isFailure,
  validateInteger,
  validatePagination,
  validateStellarAddress,
} from "../validation";

const MAX_LIMIT = 50;

interface FollowActionResponse {
  follower: string;
  followee: string;
  following: boolean;
}

interface RelationshipResponse {
  address: string;
  target: string;
  /** `address` follows `target`. */
  following: boolean;
  /** `target` follows `address` (the follow-back edge). */
  followed_by: boolean;
  /** Both edges exist. */
  mutual: boolean;
}

interface FollowCountsResponse {
  address: string;
  followers: number;
  following: number;
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
      const address = validateStellarAddress(req.params.address, "address");
      if (isFailure(address)) {
        res.status(400).json(address.failure);
        return;
      }

      const pagination = validatePagination(req.query as Record<string, unknown>, {
        maxLimit: MAX_LIMIT,
      });
      if (isFailure(pagination)) {
        res.status(400).json(pagination.failure);
        return;
      }

      const { limit, offset } = pagination.value;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      if (cursor) {
        const { followers, total } = await db.getFollowersAfter(address.value, cursor, limit);
        res.json({
          address: address.value,
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

      const { followers, total } = await db.getFollowers(address.value, limit, offset);
      const hasMore = offset + followers.length < total;
      res.json({
        address: address.value,
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

  /**
   * GET /follows/:address/following
   * Returns accounts that the given address follows.
   */
  router.get(
    "/:address/following",
    async (req: Request, res: Response<FollowingResponse | ApiErrorResponse>): Promise<void> => {
      const address = validateStellarAddress(req.params.address, "address");
      if (isFailure(address)) {
        res.status(400).json(address.failure);
        return;
      }

      const pagination = validatePagination(req.query as Record<string, unknown>, {
        maxLimit: MAX_LIMIT,
      });
      if (isFailure(pagination)) {
        res.status(400).json(pagination.failure);
        return;
      }

      const { limit, offset } = pagination.value;
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

      if (cursor) {
        const { following, total } = await db.getFollowingAfter(address.value, cursor, limit);
        res.json({
          address: address.value,
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

      const { following, total } = await db.getFollowing(address.value, limit, offset);
      const hasMore = offset + following.length < total;
      res.json({
        address: address.value,
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

  /**
   * GET /follows/:address/counts
   * Reliable follower / following totals for an account, without paging the
   * lists themselves. Backed by the same `COUNT(*)` the list endpoints use, so
   * the numbers agree with what a client would count by paging.
   */
  router.get(
    "/:address/counts",
    async (req: Request, res: Response<FollowCountsResponse | ApiErrorResponse>): Promise<void> => {
      const address = validateStellarAddress(req.params.address, "address");
      if (isFailure(address)) {
        res.status(400).json(address.failure);
        return;
      }

      // A zero-width page still returns the true `total`.
      const [{ total: followers }, { total: following }] = await Promise.all([
        db.getFollowers(address.value, 0, 0),
        db.getFollowing(address.value, 0, 0),
      ]);

      res.json({ address: address.value, followers, following });
    }
  );

  /**
   * GET /follows/:address/relationship/:target
   * Reads the relationship state in both directions — whether `address`
   * follows `target`, whether `target` follows back, and whether the pair is
   * mutual. A UI needs all three to render a follow button, and issuing two
   * list queries to reconstruct them is both slower and racier than reading
   * the two edges directly.
   */
  router.get(
    "/:address/relationship/:target",
    async (req: Request, res: Response<RelationshipResponse | ApiErrorResponse>): Promise<void> => {
      const address = validateStellarAddress(req.params.address, "address");
      if (isFailure(address)) {
        res.status(400).json(address.failure);
        return;
      }
      const target = validateStellarAddress(req.params.target, "target");
      if (isFailure(target)) {
        res.status(400).json(target.failure);
        return;
      }

      const [forward, backward] = await Promise.all([
        db.getFollow(address.value, target.value),
        db.getFollow(target.value, address.value),
      ]);

      const following = forward !== null;
      const followedBy = backward !== null;
      res.json({
        address: address.value,
        target: target.value,
        following,
        followed_by: followedBy,
        mutual: following && followedBy,
      });
    }
  );

  /**
   * POST /follows
   * Body: { follower, followee, ledger? }
   *
   * Creates the directed edge follower → followee.
   *
   * Rejections are explicit:
   *   - 400 CANNOT_FOLLOW_SELF — a self-edge is meaningless and would corrupt
   *     follower counts.
   *   - 409 ALREADY_FOLLOWING — the edge exists. A duplicate follow is not a
   *     malformed request, so it is a conflict rather than a 400, and it is not
   *     silently accepted because the client should be able to tell that no new
   *     edge was created.
   */
  router.post(
    "/",
    async (req: Request, res: Response<FollowActionResponse | ApiErrorResponse>): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      const follower = validateStellarAddress(body.follower, "follower");
      if (isFailure(follower)) {
        res.status(400).json(follower.failure);
        return;
      }
      const followee = validateStellarAddress(body.followee, "followee");
      if (isFailure(followee)) {
        res.status(400).json(followee.failure);
        return;
      }
      if (follower.value === followee.value) {
        res.status(400).json({ error: "an account cannot follow itself", code: "CANNOT_FOLLOW_SELF" });
        return;
      }

      const ledger = validateInteger(body.ledger ?? 0, "ledger", { code: "INVALID_LEDGER" });
      if (isFailure(ledger)) {
        res.status(400).json(ledger.failure);
        return;
      }

      const existing = await db.getFollow(follower.value, followee.value);
      if (existing) {
        res
          .status(409)
          .json({ error: "already following this account", code: "ALREADY_FOLLOWING" });
        return;
      }

      await db.insertFollow({
        follower: follower.value,
        followee: followee.value,
        ledger: Number(ledger.value),
      });

      res.status(201).json({
        follower: follower.value,
        followee: followee.value,
        following: true,
      });
    }
  );

  /**
   * DELETE /follows/:follower/:followee
   * Removes the directed edge. Returns 404 when no such edge exists, so a
   * client that thought it was following an account finds out that it was not
   * rather than receiving a success for a no-op.
   */
  router.delete(
    "/:follower/:followee",
    async (req: Request, res: Response<FollowActionResponse | ApiErrorResponse>): Promise<void> => {
      const follower = validateStellarAddress(req.params.follower, "follower");
      if (isFailure(follower)) {
        res.status(400).json(follower.failure);
        return;
      }
      const followee = validateStellarAddress(req.params.followee, "followee");
      if (isFailure(followee)) {
        res.status(400).json(followee.failure);
        return;
      }

      const existing = await db.getFollow(follower.value, followee.value);
      if (!existing) {
        res.status(404).json({ error: "not following this account", code: "NOT_FOLLOWING" });
        return;
      }

      await db.deleteFollow(follower.value, followee.value);

      res.json({ follower: follower.value, followee: followee.value, following: false });
    }
  );

  return router;
}
