import { Pool } from "pg";
import { logger } from "../logger";

export interface TipEvent {
  tipper: string;
  post_id: bigint;
  amount: bigint;
  fee: bigint;
}

export interface TipEventContext {
  txHash: string;
  ledgerSeq: number;
  timestamp: Date;
}

/**
 * Deleted-post rule: a tip that references a soft-deleted post is **rejected**.
 * Nothing is inserted and no total changes, in one rolled-back transaction, so a
 * deleted post's `tip_total` always equals the tips recorded while it was
 * active. A missing post is rejected the same way.
 */
export const DELETED_POST_TIP_POLICY = "reject" as const;

/** Result of handling a tip delivery. */
export type TipOutcome = "recorded" | "duplicate" | "rejected_missing" | "rejected_deleted";/**
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 * Idempotent: if the follow already exists the handler returns immediately
 * without issuing a database write.
 */
 // const applied = await getAppliedMigrations(pool);
/**
 * Validate a raw event object has the shape expected for a Tip event.
 * Throws a descriptive error for any missing or incorrectly typed field.
 */
export function validateTipEvent(event: unknown): asserts event is TipEvent {
  if (!event || typeof event !== "object") {
    throw new Error("Tip event must be a non-null object");
  }
  const e = event as Record<string, unknown>;
  if (typeof e.tipper !== "string" || e.tipper.trim() === "") {
    throw new Error("Tip event missing or invalid field: tipper");
  }
  if (typeof e.post_id !== "bigint" && typeof e.post_id !== "number" && typeof e.post_id !== "string") {
    throw new Error("Tip event missing or invalid field: post_id");
  }
  if (typeof e.amount !== "bigint" && typeof e.amount !== "number" && typeof e.amount !== "string") {
    throw new Error("Tip event missing or invalid field: amount");
  }
  if (typeof e.fee !== "bigint" && typeof e.fee !== "number" && typeof e.fee !== "string") {
    throw new Error("Tip event missing or invalid field: fee");
  }
}

/**
 * Handle TipEvent
 * 1. Inserts tip record into tips table
 * 2. Increments tip_total on the corresponding post
 * Idempotent: Uses tx_hash uniqueness constraint
 * Uses SERIALIZABLE isolation to prevent concurrent tip double-counting
 */
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

export async function handleTip(
  pool: Pool,
  event: TipEvent,
  context: TipEventContext
): Promise<TipOutcome> {
  const { tipper, post_id, amount, fee } = event;
  const { txHash, timestamp } = context;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

      // Lock the row and read its deleted state, so a missing post and a
      // soft-deleted one can be told apart and both are rejected atomically.
      const postCheck = await client.query(
        "SELECT id, deleted_at FROM posts WHERE id = $1 FOR UPDATE",
        [post_id.toString()]
      );
      if (postCheck.rowCount === 0) {
        await client.query("ROLLBACK");
        console.warn(`Post ${post_id} not found, skipping tip`);
        client.release();
        return "rejected_missing";
      }
      const postRow = (postCheck.rows?.[0] ?? {}) as { deleted_at?: Date | string | null };
      if (postRow.deleted_at !== null && postRow.deleted_at !== undefined) {
        await client.query("ROLLBACK");
        console.warn(`Post ${post_id} is deleted, tip rejected (${DELETED_POST_TIP_POLICY})`);
        client.release();
        return "rejected_deleted";
      }

      // Insert tip record (idempotent via tx_hash unique constraint)
      const insertTipQuery = `
        INSERT INTO tips (post_id, tipper, amount, fee, created_at, tx_hash)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tx_hash) DO NOTHING
        RETURNING id
      `;

      const insertValues = [
        post_id.toString(),
        tipper,
        amount.toString(),
        fee.toString(),
        timestamp,
        txHash,
      ];

      const insertResult = await client.query(insertTipQuery, insertValues);

      if (insertResult.rowCount === 0) {
        console.log(`Tip already processed for tx ${txHash} (idempotent skip)`);
        await client.query("COMMIT");
        client.release();
        return "duplicate";
      }

      // Increment tip_total on post
      const updatePostQuery = `
        UPDATE posts
        SET tip_total = tip_total + $1
        WHERE id = $2 AND deleted_at IS NULL
      `;

      const updateValues = [amount.toString(), post_id.toString()];
      const updateResult = await client.query(updatePostQuery, updateValues);

      if (updateResult.rowCount === 0) {
        console.warn(`Post ${post_id} not found or deleted, tip recorded but post not updated`);
      } else {
        console.log(`Tip of ${amount} from ${tipper} added to post ${post_id}`);
      }

      await client.query("COMMIT");
      client.release();
      return "recorded";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();

      if (isSerializationError(error) && attempt < MAX_RETRIES) {
        console.warn(
          `Serialization failure on attempt ${attempt}/${MAX_RETRIES} for tip on post ${post_id}, retrying...`
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        continue;
      }

      console.error(`Error handling TipEvent for post ${post_id}:`, error);
      throw error;
    }
  }
  throw new Error(`Tip handling for post ${post_id} exhausted ${MAX_RETRIES} attempts`);
}

export function createMockTipEvent(
  tipper: string = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  post_id: bigint = 1n,
  amount: bigint = 1000000n,
  fee: bigint = 25000n
): { event: TipEvent; context: TipEventContext } {
  return {
    event: { tipper, post_id, amount, fee },
    context: {
      txHash: `0x${Math.random().toString(16).substring(2)}`,
      ledgerSeq: 12345,
      timestamp: new Date(),
    },
  };
}