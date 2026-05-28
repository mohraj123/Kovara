/**
 * Handlers for PostCreated and PostDeleted contract events.
 */

import { Database } from "../db";

export interface PostCreatedEvent {
  id: bigint;
  author: string;
  ledger: number;
}

export interface PostDeletedEvent {
  post_id: bigint;
  author: string;
  ledger: number;
}

/**
 * Handle a PostCreated event.
 *
 * Inserts a new post record with deleted=false and zero counters.
 * Idempotent: a duplicate event for the same post_id is a no-op because
 * the underlying upsert will overwrite with the same values.
 */
export async function handlePostCreated(
  db: Database,
  event: PostCreatedEvent
): Promise<void> {
  if (!event.author) {
    throw new Error("PostCreated event missing required field: author");
  }

  await db.insertPost({
    id: event.id,
    author: event.author,
    deleted: false,
    tip_total: BigInt(0),
    like_count: BigInt(0),
    created_ledger: event.ledger,
    deleted_ledger: null,
  });
}

/**
 * Handle a PostDeleted event.
 *
 * Soft-deletes the post so historical tip and like records remain consistent.
 * Idempotent: marking an already-deleted post as deleted again is safe.
 */
export async function handlePostDeleted(
  db: Database,
  event: PostDeletedEvent
): Promise<void> {
  await db.markPostDeleted(event.post_id, event.ledger);
}
