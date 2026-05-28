/**
 * Handlers for Follow and Unfollow contract events.
 */

import { Pool as PgPool } from "pg";
import { Database } from "../db";
import { deleteFollowEdge, upsertFollowEdge } from "../db";

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
 * Idempotent: the underlying upsert on (follower, followee) is safe to
 * replay.
 */
export async function handleFollow(
  db: Database,
  event: FollowEvent
): Promise<void> {
  if (!event.follower) {
    throw new Error("Follow event missing required field: follower");
  }
  if (!event.followee) {
    throw new Error("Follow event missing required field: followee");
  }

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
 * Idempotent: deleting a non-existent edge is a no-op.
 */
export async function handleUnfollow(
  db: Database,
  event: UnfollowEvent
): Promise<void> {
  if (!event.follower) {
    throw new Error("Unfollow event missing required field: follower");
  }
  if (!event.followee) {
    throw new Error("Unfollow event missing required field: followee");
  }

  await db.deleteFollow(event.follower, event.followee);
}

interface FollowGraphPayload {
  follower?: string;
  followee?: string;
  created_at?: string;
}

function readString(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    if (typeof rec.address === "string") {
      return rec.address;
    }
    if (typeof rec.value === "string") {
      return rec.value;
    }
  }
  return undefined;
}

function parseFollowGraphPayload(value: unknown): FollowGraphPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;
  return {
    follower: readString(payload.follower),
    followee: readString(payload.followee),
    created_at: typeof payload.created_at === "string" ? payload.created_at : undefined,
  };
}

export async function routeFollowGraphEvent(
  pool: PgPool,
  eventType: string,
  value: unknown
): Promise<void> {
  const payload = parseFollowGraphPayload(value);
  if (!payload?.follower || !payload.followee) {
    return;
  }

  if (eventType === "FollowEvent") {
    await upsertFollowEdge(pool, {
      follower: payload.follower,
      followee: payload.followee,
      createdAt: payload.created_at ? new Date(payload.created_at) : undefined,
    });
    return;
  }

  if (eventType === "UnfollowEvent") {
    await deleteFollowEdge(pool, {
      follower: payload.follower,
      followee: payload.followee,
    });
  }
}
