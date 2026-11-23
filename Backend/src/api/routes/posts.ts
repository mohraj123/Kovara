import { Router, Request, Response } from "express";
import { Database, Post } from "../../db";
import { ApiErrorResponse, PostListResponse, PostResponse } from "../contracts";
import { serializeBigInt } from "../index";
import {
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  MAX_LIMIT,
  parseCursor,
  parseLimit,
  parseNumericId,
  parseOffset,
  parseOptionalStellarAddress,
  sendValidationError,
  validate,
} from "../validation";

const parseListLimit = parseLimit(MAX_LIMIT, DEFAULT_LIMIT);

/** The boundary keyset pagination resumes from. */
interface PostCursor {
  created_at: string;
  id: string;
}

/**
 * Encode the last row of a page into an opaque cursor (BE-01).
 *
 * The payload is the row's `(created_at, id)` pair — the same pair the query
 * compares against — so a cursor can only ever address a real boundary. It is
 * base64url-encoded rather than signed: it carries no authority (the endpoint
 * is public and read-only) and is re-validated as `created_at`/`id` on the way
 * back in, so a tampered cursor is rejected rather than trusted.
 */
function encodePostCursor(post: Post): string {
  const createdAt =
    post.created_at instanceof Date
      ? post.created_at.toISOString()
      : String(post.created_at ?? "");
  const payload = JSON.stringify({ created_at: createdAt, id: post.id.toString() });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decode a cursor, or `undefined` when it is absent.
 *
 * A malformed cursor is a client error, not a silent restart from the first
 * page: silently returning page one makes a client that lost its place loop
 * over the same rows forever.
 */
function decodePostCursor(raw: string | undefined):
  | { ok: true; value: PostCursor | undefined }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "cursor is not a valid pagination cursor" };
  }

  if (typeof decoded !== "object" || decoded === null) {
    return { ok: false, error: "cursor is not a valid pagination cursor" };
  }

  const { created_at: createdAt, id } = decoded as { created_at?: unknown; id?: unknown };

  // Re-validated rather than trusted: the token is opaque, so this is the only
  // thing standing between a client and a malformed parameterised query.
  const idText = typeof id === "string" || typeof id === "number" ? String(id) : "";
  if (typeof createdAt !== "string" || createdAt === "" || !/^\d+$/.test(idText)) {
    return { ok: false, error: "cursor is not a valid pagination cursor" };
  }

  return { ok: true, value: { created_at: createdAt, id: idText } };
}

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

export function createPostsRouter(db: Database): Router {
  const router = Router();

  /**
   * GET /posts?author=<address>&limit=<n>&offset=<n>&cursor=<c>
   * Lists posts with an optional author filter and pagination.
   *
   * Two pagination styles coexist (BE-01):
   *
   *   - **No `cursor`** — the original `limit`/`offset` behaviour, unchanged, so
   *     existing clients are unaffected. `next_cursor` is `null`.
   *   - **`cursor` present** — keyset pagination. `offset` is reported as `null`
   *     and ignored, because mixing the two would produce a page the caller
   *     cannot reason about. `total` stays the count of everything matching the
   *     filter, not of the remaining suffix, so it does not shrink per page.
   */
  router.get(
    "/",
    async (req: Request, res: Response<PostListResponse | ApiErrorResponse>): Promise<void> => {
      const parsed = validate<{
        author?: string;
        limit: number;
        offset: number;
        cursor?: string;
      }>(
        {
          // `author` is a wallet address, so it is validated as one rather than
          // passed through as an arbitrary string filter (issue #665).
          author: { parse: parseOptionalStellarAddress, required: false },
          limit: { parse: parseListLimit, required: false, default: DEFAULT_LIMIT },
          offset: { parse: parseOffset, required: false, default: DEFAULT_OFFSET },
          cursor: { parse: parseCursor, required: false },
        },
        {
          author: req.query.author,
          limit: req.query.limit,
          offset: req.query.offset,
          cursor: req.query.cursor,
        }
      );
      if (!parsed.ok) {
        sendValidationError(res, parsed.issue);
        return;
      }

      const { author, limit, offset, cursor } = parsed.value;

      if (cursor !== undefined) {
        const decoded = decodePostCursor(cursor);
        if (!decoded.ok) {
          res.status(400).json({ error: decoded.error, code: "INVALID_CURSOR" });
          return;
        }

        const { posts, total } = await db.listPosts({
          author,
          cursor: decoded.value,
          limit,
          offset: DEFAULT_OFFSET,
        });
        // A short page means the end was reached; a full page means there may be
        // more, and the next request with the returned cursor confirms it.
        const hasMore = posts.length === limit;

        res.json({
          posts: posts.map(serializePost),
          total,
          limit,
          offset: null,
          has_more: hasMore,
          next_cursor: hasMore && posts.length > 0 ? encodePostCursor(posts[posts.length - 1]) : null,
        } as unknown as PostListResponse);
        return;
      }

      const { posts, total } = await db.listPosts({ author, limit, offset });
      res.json({
        posts: posts.map(serializePost),
        total,
        limit,
        offset,
        has_more: offset + posts.length < total,
        next_cursor: null,
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
      const parsed = parseNumericId(req.params.id);
      if (!parsed.ok) {
        sendValidationError(res, parsed.issue);
        return;
      }

      const post = await db.getPost(parsed.value);
      if (!post) {
        res.status(404).json({ error: "Post not found", code: "NOT_FOUND" });
        return;
      }

      res.json(serializePost(post) as unknown as PostResponse);
    }
  );

  /**
   * DELETE /posts/:id
   * Soft-deletes a post (BE-03).
   *
   * Deletion is **idempotent and reports it as such**. A deletion is a request
   * for a desired end state — "this post is not visible" — not a transition that
   * may only happen once, so the two outcomes a client can observe are
   * distinguished explicitly rather than by accident:
   *
   *   - `200 {"deleted": true}` — this call performed the deletion.
   *   - `200 {"deleted": false}` — the post was already deleted. Retrying is
   *     safe and the response says so, instead of a client retrying forever
   *     chasing a 404.
   *   - `404 NOT_FOUND` — no such post ever existed. This one *is* an error:
   *     retrying cannot help, and a client that retries in a loop is a bug.
   *
   * Distinguishing "already deleted" from "never existed" is the whole point:
   * `markPostDeleted` matches on `deleted_at IS NULL`, so a blind 404 would be
   * returned for both and an idempotent retry would look like a failure.
   */
  router.delete(
    "/:id",
    async (req: Request, res: Response<Record<string, unknown> | ApiErrorResponse>): Promise<void> => {
      const parsed = parseNumericId(req.params.id);
      if (!parsed.ok) {
        sendValidationError(res, parsed.issue);
        return;
      }

      const post = await db.getPost(parsed.value);
      if (!post) {
        res.status(404).json({ error: "Post not found", code: "NOT_FOUND" });
        return;
      }

      const alreadyDeleted = post.deleted === true || (post.deleted_at != null && post.deleted_at !== undefined);
      if (alreadyDeleted) {
        res.json({ id: post.id.toString(), deleted: false });
        return;
      }

      await db.markPostDeleted(post.id, post.created_ledger);
      res.json({ id: post.id.toString(), deleted: true });
    }
  );

  return router;
}
