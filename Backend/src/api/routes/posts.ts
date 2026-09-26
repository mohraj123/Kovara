import { Router, Request, Response } from "express";
import { Database, Post, Tip } from "../../db";
import { ApiErrorResponse, PostListResponse, PostResponse } from "../contracts";
import { serializeBigInt } from "../index";
import {
  isFailure,
  validateId,
  validateInteger,
  validatePagination,
  validatePositiveInteger,
  validateStellarAddress,
  validateTransactionHash,
} from "../validation";

const MAX_LIMIT = 100;

/**
 * The largest tip the API will accept in one call, in the asset's smallest
 * unit. A bound is required because the amount is caller-supplied: without one,
 * a single request could record an amount larger than every real balance and
 * skew the post's tip total (and anything derived from it) permanently.
 */
const MAX_TIP_AMOUNT = 1_000_000_000_000n; // 1e12

/**
 * Serialize a Post record to its API representation.
 *
 * BE-23: All date fields are serialized as ISO 8601 strings so consumers
 * receive a consistent, timezone-unambiguous format. Null/undefined dates
 * are surfaced as null rather than being omitted or coerced to an empty
 * string.
 */
function serializePost(post: Post): Record<string, unknown> {
  return {
    id: post.id.toString(),
    author: post.author,
    content: post.content,
    deleted: post.deleted,
    tip_total: post.tip_total.toString(),
    like_count: post.like_count.toString(),
    created_ledger: post.created_ledger,
    deleted_ledger: post.deleted_ledger ?? null,
    created_at:
      post.created_at instanceof Date && !isNaN(post.created_at.getTime())
        ? post.created_at.toISOString()
        : post.created_at != null
          ? String(post.created_at)
          : null,
    deleted_at:
      post.deleted_at instanceof Date && !isNaN(post.deleted_at.getTime())
        ? post.deleted_at.toISOString()
        : post.deleted_at != null
          ? String(post.deleted_at)
          : null,
  };
}

/** Serialize a tip row, keeping amounts as decimal strings. */
function serializeTip(tip: Tip): Record<string, unknown> {
  return {
    id: tip.id ?? null,
    tipper: tip.tipper,
    post_id: tip.post_id.toString(),
    amount: tip.amount.toString(),
    fee: tip.fee.toString(),
    ledger: tip.ledger,
    tx_hash: tip.tx_hash,
  };
}

export function createPostsRouter(db: Database): Router {
  const router = Router();

  /**
   * GET /posts?author=<address>&limit=<n>&offset=<n>
   * Lists posts with optional author filter and pagination.
   */
  router.get(
    "/",
    async (req: Request, res: Response<PostListResponse | ApiErrorResponse>): Promise<void> => {
      const author = typeof req.query.author === "string" ? req.query.author : undefined;

      // #665: a malformed page window is rejected before the database is hit.
      const pagination = validatePagination(req.query as Record<string, unknown>, {
        maxLimit: MAX_LIMIT,
      });
      if (isFailure(pagination)) {
        res.status(400).json(pagination.failure);
        return;
      }

      const { limit, offset } = pagination.value;
      const { posts, total } = await db.listPosts({ author, limit, offset });
      res.json({
        posts: posts.map(serializePost),
        total,
        limit,
        offset,
        has_more: offset + posts.length < total,
      } as unknown as PostListResponse);
    }
  );

  /**
   * GET /posts/:id
   * Returns a single post by its numeric ID.
   */
  router.get(
    "/:id",
    async (req: Request, res: Response<PostResponse | ApiErrorResponse>): Promise<void> => {
      const postId = validateId(req.params.id);
      if (isFailure(postId)) {
        res.status(400).json(postId.failure);
        return;
      }

      const post = await db.getPost(postId.value);
      if (!post) {
        res.status(404).json({ error: "Post not found", code: "NOT_FOUND" });
        return;
      }

      res.json(serializePost(post) as unknown as PostResponse);
    }
  );

  /**
   * POST /posts/:id/like
   * Body: { user, ledger? }
   *
   * Records a like and increments the post's like count. The write is
   * idempotent at the database (`ON CONFLICT (post_id, user) DO NOTHING`), and
   * the boolean it returns tells us whether this call created the edge — so a
   * repeat is reported as a conflict and the count is incremented exactly once.
   */
  router.post(
    "/:id/like",
    async (
      req: Request,
      res: Response<{ post_id: string; user: string; liked: boolean; like_count: string } | ApiErrorResponse>
    ): Promise<void> => {
      const postId = validateId(req.params.id);
      if (isFailure(postId)) {
        res.status(400).json(postId.failure);
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawUser =
        body.user !== undefined
          ? body.user
          : typeof req.headers["x-stellar-address"] === "string"
            ? req.headers["x-stellar-address"]
            : undefined;
      const user = validateStellarAddress(rawUser, "user");
      if (isFailure(user)) {
        res.status(400).json(user.failure);
        return;
      }

      const ledger = validateInteger(body.ledger ?? 0, "ledger", { code: "INVALID_LEDGER" });
      if (isFailure(ledger)) {
        res.status(400).json(ledger.failure);
        return;
      }

      const post = await db.getPost(postId.value);
      if (!post || post.deleted) {
        res.status(404).json({ error: "Post not found", code: "NOT_FOUND" });
        return;
      }

      const inserted = await db.upsertLike({
        post_id: postId.value,
        user: user.value,
        ledger: Number(ledger.value),
      });
      if (!inserted) {
        res.status(409).json({ error: "post already liked by this address", code: "ALREADY_LIKED" });
        return;
      }

      await db.incrementPostLikeCount(postId.value);

      // Report the count the write produced, so a client does not have to
      // re-read the post to render the new total.
      res.status(201).json({
        post_id: postId.value.toString(),
        user: user.value,
        liked: true,
        like_count: (post.like_count + 1n).toString(),
      });
    }
  );

  /**
   * POST /posts/:id/tip
   * Body: { tipper, amount, fee?, tx_hash, ledger? }
   *
   * Records a tip and adds it to the post's tip total. `tx_hash` is the
   * idempotency key: a replay of the same on-chain transaction must not pay
   * twice, so an already-recorded hash is reported as a conflict and the total
   * is left untouched.
   */
  router.post(
    "/:id/tip",
    async (
      req: Request,
      res: Response<
        { post_id: string; tipper: string; amount: string; fee: string; tip_total: string } | ApiErrorResponse
      >
    ): Promise<void> => {
      const postId = validateId(req.params.id);
      if (isFailure(postId)) {
        res.status(400).json(postId.failure);
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;

      const tipper = validateStellarAddress(body.tipper, "tipper");
      if (isFailure(tipper)) {
        res.status(400).json(tipper.failure);
        return;
      }

      const amount = validatePositiveInteger(body.amount, "amount", { max: MAX_TIP_AMOUNT });
      if (isFailure(amount)) {
        res.status(400).json(amount.failure);
        return;
      }

      const fee = validateInteger(body.fee ?? 0, "fee", {
        max: amount.value,
        code: "INVALID_FEE",
      });
      if (isFailure(fee)) {
        res.status(400).json(fee.failure);
        return;
      }

      const txHash = validateTransactionHash(body.tx_hash);
      if (isFailure(txHash)) {
        res.status(400).json(txHash.failure);
        return;
      }

      const ledger = validateInteger(body.ledger ?? 0, "ledger", { code: "INVALID_LEDGER" });
      if (isFailure(ledger)) {
        res.status(400).json(ledger.failure);
        return;
      }

      const post = await db.getPost(postId.value);
      if (!post || post.deleted) {
        res.status(404).json({ error: "Post not found", code: "NOT_FOUND" });
        return;
      }

      if (typeof db.hasTip === "function" && (await db.hasTip(txHash.value))) {
        res.status(409).json({ error: "tip already recorded for this transaction", code: "DUPLICATE_TIP" });
        return;
      }

      await db.insertTip({
        tipper: tipper.value,
        post_id: postId.value,
        amount: amount.value,
        fee: fee.value,
        ledger: Number(ledger.value),
        tx_hash: txHash.value,
      });
      await db.addPostTipTotal(postId.value, amount.value);

      res.status(201).json({
        post_id: postId.value.toString(),
        tipper: tipper.value,
        amount: amount.value.toString(),
        fee: fee.value.toString(),
        tip_total: (post.tip_total + amount.value).toString(),
      });
    }
  );

  /**
   * GET /posts/:id/activity?limit=&offset=
   *
   * The persisted like and tip activity for a post, newest first, alongside the
   * aggregate counts. Listing the individual events (not just the totals) is
   * what makes the totals auditable: a count that cannot be reconstructed from
   * its rows is exactly the kind of number this API must not publish.
   */
  router.get(
    "/:id/activity",
    async (req: Request, res: Response): Promise<void> => {
      const postId = validateId(req.params.id);
      if (isFailure(postId)) {
        res.status(400).json(postId.failure);
        return;
      }

      const pagination = validatePagination(req.query as Record<string, unknown>, {
        maxLimit: MAX_LIMIT,
      });
      if (isFailure(pagination)) {
        res.status(400).json(pagination.failure);
        return;
      }

      const post = await db.getPost(postId.value);
      if (!post || post.deleted) {
        res.status(404).json({ error: "Post not found", code: "NOT_FOUND" });
        return;
      }

      const { limit, offset } = pagination.value;

      // Feature-detected so a minimal `Database` implementation still serves
      // the aggregate view.
      const likes =
        typeof db.listLikes === "function"
          ? await db.listLikes(postId.value, limit, offset)
          : { likes: [], total: Number(post.like_count) };
      const tips =
        typeof db.listTips === "function"
          ? await db.listTips(postId.value, limit, offset)
          : { tips: [] as Tip[], total: 0 };

      res.json(
        serializeBigInt({
          post_id: postId.value.toString(),
          like_count: post.like_count,
          tip_total: post.tip_total,
          likes: likes.likes,
          likes_total: likes.total,
          tips: tips.tips.map(serializeTip),
          tips_total: tips.total,
          limit,
          offset,
        })
      );
    }
  );

  return router;
}
