/**
 * Handlers for Follow and Unfollow contract events.
 */

import { Database } from "../db";

export interface FollowEvent {
  follower: string;
  followee: string;
  ledger: number;
}

export interface UnfollowEvent {
  follower: string;
  followee: string;
  ledger: number;
}

/**
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 * Idempotent: if the follow already exists the handler returns immediately
 * without issuing a database write.
 */
export async function handleFollow(db: Database, event: FollowEvent): Promise<void> {
  if (!event.follower) {
    throw new Error("Follow event missing required field: follower");
  }
  if (!event.followee) {
    throw new Error("Follow event missing required field: followee");
  }

  const existing = await db.getFollow(event.follower, event.followee);
  if (existing) return;

  await db.insertFollow({
    follower: event.follower,
    followee: event.followee,
    ledger: event.ledger,
  });
}

/**
 * Handle an Unfollow event.
 *
 * Removes the directed edge (follower → followee) from the follow graph.
 * Idempotent: if the follow doesn't exist the handler returns immediately
 * without issuing a database write.
 */
export async function handleUnfollow(db: Database, event: UnfollowEvent): Promise<void> {
  if (!event.follower) {
    throw new Error("Unfollow event missing required field: follower");
  }
  if (!event.followee) {
    throw new Error("Unfollow event missing required field: followee");
  }

  const existing = await db.getFollow(event.follower, event.followee);
  if (!existing) return;

  await db.deleteFollow(event.follower, event.followee);
}
