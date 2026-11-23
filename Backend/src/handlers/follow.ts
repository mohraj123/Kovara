import { Database } from "../db";
import { logger } from "../logger";
import { normalizeAddress } from "../normalize";

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
 * The one rule both the read path and the write path enforce: an account cannot
 * follow itself (BE-13).
 *
 * The check is applied to the *canonical* address, not the raw string, because
 * a contract that emits `GABC…` and an API caller that sends `gabc…` describe
 * the same account. Comparing the raw strings would let a self-follow through
 * with mismatched casing — the row would then appear in neither follower list
 * while still incrementing both counters.
 *
 * Kept as an exported predicate so the route layer can produce the same verdict
 * from the same code rather than re-implementing the comparison.
 */
export function isSelfFollow(follower: string, followee: string): boolean {
  try {
    return normalizeAddress(follower) === normalizeAddress(followee);
  } catch {
    // A structurally invalid address is not a self-follow; it is refused by the
    // per-field validation below, which reports which field was wrong.
    return false;
  }
}

/**
 * What a follow/unfollow delivery did. Redeliveries report `"noop"` instead of
 * returning nothing, so callers and tests can tell a real state change from a
 * replay without inspecting the database.
 */
export type FollowOutcome = "applied" | "noop";

/** Postgres unique-violation: a racing duplicate insert lost to the constraint. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export interface TrendEvent {
  eventTime: string;
  events: string;
  proceeding: number;
}




/**
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 *
 * Replayed follow events must be treated as idempotent and must not create
 * duplicate relationships or inflate follower/following counts (issue #928).
 * If the relationship already exists, the handler returns immediately without
 * issuing a write. The database layer also guards against duplicates via the
 * UNIQUE (follower, followee) constraint, so even if a race occurs, no second
 * row is written and counts remain unchanged.
 *
 * A self-follow is refused here, in the **write path**, with no database call at
 * all (BE-13). A self-follow is a meaningless edge: it inflates both the
 * follower and the following count of one account while the edge is invisible
 * in either list, because a client filters `x !== self`. Accepting it because
 * the read path already refuses it means the rule holds only as long as every
 * caller happens to remember to apply it.
 */
export async function handleFollow(db: Database, event: FollowEvent): Promise<FollowOutcome> {
  if (!event.follower) {
    throw new Error("Follow event missing required field: follower");
  }
  if (!event.followee) {
    throw new Error("Follow event missing required field: followee");
  }

  if (isSelfFollow(event.follower, event.followee)) {
    throw new Error("Follow event rejected: an account cannot follow itself");
  }

  const existing = await db.getFollow(event.follower, event.followee);
  if (existing) {
    logger.info(`Follow replay for ${event.follower}→${event.followee} is a no-op`);
    return "noop";
  }

  try {
    await db.insertFollow({
      follower: event.follower,
      followee: event.followee,
      ledger: event.ledger,
    });
  } catch (err) {
    // A concurrent delivery inserted the edge between our check and write; the
    // unique constraint kept the graph correct, so this delivery is a replay.
    if (isUniqueViolation(err)) {
      logger.info(`Follow race for ${event.follower}→${event.followee} resolved as a no-op`);
      return "noop";
    }
    throw err;
  }
  return "applied";
}
/**
 * Handle an Unfollow event.
 *
 * Removes the directed edge (follower → followee) from the follow graph.
 *
 * Repeated-unfollow semantics (issue #931): an Unfollow event states a desired
 * *end state* — "follower does not follow followee" — not a transition that may
 * only happen once. The chain may redeliver the same event after a crash, a
 * replay window or an at-least-once transport, so every delivery is judged
 * against the current graph:
 *
 *   - relationship present  → delete it exactly once (`DELETE ... WHERE` on the
 *     `(follower, followee)` key, so a racing duplicate affects zero rows).
 *   - relationship absent   → no-op that resolves without throwing; no write is
 *     issued and relationship counts are left untouched.
 *
 * Neither delivery order nor repetition changes the final state, so N replays
 * of the same Unfollow leave the same relationship count as the first one did.
 */
export async function handleUnfollow(db: Database, event: UnfollowEvent): Promise<FollowOutcome> {
  if (!event.follower) {
    throw new Error("Unfollow event missing required field: follower");
  }
  if (!event.followee) {
    throw new Error("Unfollow event missing required field: followee");
  }

  const existing = await db.getFollow(event.follower, event.followee);
  if (!existing) {
    // Replay of an already-applied Unfollow: harmless no-op (issue #931).
    logger.info(`Unfollow replay for ${event.follower}→${event.followee} is a no-op`);
    return "noop";
  }

  await db.deleteFollow(event.follower, event.followee);
  return "applied";
}