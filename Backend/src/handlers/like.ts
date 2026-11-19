import { Pool } from "pg";
import { logger } from "../logger";

export interface LikePostEvent {
  user: string;
  post_id: bigint;
}
/**
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 * Idempotent: if the follow already exists the handler returns immediately
 * without issuing a database write.
 */
 // const applied = await getAppliedMigrations(pool);
export interface LikeEventContext {
  txHash: string;
  ledgerSeq: number;
  timestamp: Date;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 50;

function isSerializationError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code;
    if (code === "40001" || code === "40P01") return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("could not serialize access") || msg.includes("serialization failure")) {
      return true;
    }
  }
  return false;
}

/**
 * Handle LikePostEvent
 * 1. Reads the post row and rejects the delivery when the post is missing or
 *    soft-deleted (issue #933) — no like row is created for either case
 * 2. Inserts like record into likes table
 * 3. Recomputes like_count on the corresponding post from the likes table
 *    (issue #932) rather than incrementing it, so a redelivered event can
 *    never move the count twice
 * Uses SERIALIZABLE isolation with retries to prevent concurrent
 * like double-counting or corruption. Idempotent: Uses
 * (post_id, user_address) unique constraint.
 */
export async function handleLike(
  pool: Pool,
  event: LikePostEvent,
  context: LikeEventContext
): Promise<void> {
  const { user, post_id } = event;
  const { txHash, timestamp } = context;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

      const postCheck = await client.query(
        "SELECT id, deleted_at FROM posts WHERE id = $1",
        [post_id.toString()]
      );
      if (postCheck.rowCount === 0) {
        await client.query("COMMIT");
        logger.warn(`Like rejected: post ${post_id} does not exist (missing post)`);
        client.release();
        return;
      }
      const postRow = postCheck.rows[0] as { deleted_at: Date | string | null };
      if (postRow.deleted_at !== null && postRow.deleted_at !== undefined) {
        await client.query("COMMIT");
        logger.warn(`Like rejected: post ${post_id} is deleted`);
        client.release();
        return;
      }

      const insertLikeQuery = `
        INSERT INTO likes (post_id, user_address, created_at, tx_hash)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (post_id, user_address) DO NOTHING
        RETURNING id
      `;

      const insertValues = [post_id.toString(), user, timestamp, txHash];

      const insertResult = await client.query(insertLikeQuery, insertValues);

      if (insertResult.rowCount === 0) {
        logger.info(
          `Like already exists for user ${user} on post ${post_id} (idempotent skip)`
        );
        await client.query("COMMIT");
        client.release();
        return;
      }

      // Issue #932: derive the count from the rows themselves so replays,
      // retries and concurrent deliveries converge on the same number instead
      // of drifting with every `+ 1`.
      const updatePostQuery = `
        UPDATE posts
        SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = $1)
        WHERE id = $1 AND deleted_at IS NULL
      `;

      const updateValues = [post_id.toString()];
      const updateResult = await client.query(updatePostQuery, updateValues);

      if (updateResult.rowCount === 0) {
        logger.warn(
          `Post ${post_id} not found or deleted, like recorded but post not updated`
        );
      } else {
        logger.info(`Like from ${user} added to post ${post_id}`);
      }

      await client.query("COMMIT");
      client.release();
      return;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();

      if (isSerializationError(error) && attempt < MAX_RETRIES) {
        logger.warn(
          `Serialization failure on attempt ${attempt}/${MAX_RETRIES} for like on post ${post_id}, retrying...`
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        continue;
      }

      logger.error(`Error handling LikePostEvent for post ${post_id}: ${String(error)}`);
      throw error;
    }
  }
}

export interface UnlikePostEvent {
  user: string;
  post_id: bigint;
}

/**
 * Handle an unlike: remove the like row and recompute `like_count` from the
 * likes table in the same SERIALIZABLE transaction, so a like and an unlike
 * racing on one post cannot leave the stored count different from the number of
 * like rows. Removing a like that does not exist is an idempotent no-op that
 * leaves the count untouched.
 */
export async function handleUnlike(pool: Pool, event: UnlikePostEvent): Promise<void> {
  const { user, post_id } = event;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

      const removed = await client.query(
        "DELETE FROM likes WHERE post_id = $1 AND user_address = $2 RETURNING id",
        [post_id.toString(), user]
      );
      if (removed.rowCount === 0) {
        logger.info(`Unlike for ${user} on post ${post_id} is a no-op (no like row)`);
        await client.query("COMMIT");
        client.release();
        return;
      }

      await client.query(
        `UPDATE posts
         SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = $1)
         WHERE id = $1 AND deleted_at IS NULL`,
        [post_id.toString()]
      );

      await client.query("COMMIT");
      client.release();
      return;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();

      if (isSerializationError(error) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        continue;
      }

      logger.error(`Error handling unlike for post ${post_id}: ${String(error)}`);
      throw error;
    }
  }
}

export function createMockLikeEvent(
  user: string = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  post_id: bigint = 1n
): { event: LikePostEvent; context: LikeEventContext } {
  return {
    event: { user, post_id },
    context: {
      txHash: `0x${Math.random().toString(16).substring(2)}`,
      ledgerSeq: 12345,
      timestamp: new Date(),
    },
  };
}