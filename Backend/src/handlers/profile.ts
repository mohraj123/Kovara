import { Database } from "../db";
import { logger } from "../logger";

export interface ProfileSetEvent {
  user: string;
  username: string;
  creator_token: string;
  ledger: number;
}

/** Shared maximum lengths for profile fields, measured after trimming. */
export const MAX_USERNAME_LENGTH = 32;
export const MAX_CREATOR_TOKEN_LENGTH = 128;

/**
 * A profile update. `username` and `creator_token` may be omitted: an omitted
 * field keeps its stored value, while an explicit empty `creator_token` clears
 * it. (An empty `username` is always invalid.)
 */
export type ProfileSetInput = Omit<ProfileSetEvent, "username" | "creator_token"> & {
  username?: string;
  creator_token?: string;
};

export function validateProfileEvent(event: unknown): asserts event is ProfileSetEvent {
  if (!event || typeof event !== "object") {
    throw new Error("ProfileSet event must be a non-null object");
  }
  const e = event as Record<string, unknown>;
  if (typeof e.user !== "string" || e.user.trim() === "") {
    throw new Error("ProfileSet event missing or invalid field: user");
  }
  if (typeof e.username !== "string" || e.username.trim() === "") {
    throw new Error("ProfileSet event missing or invalid field: username");
  }
  if (e.creator_token !== undefined && typeof e.creator_token !== "string") {
    throw new Error("ProfileSet event field 'creator_token' must be a string");
  }
  if (typeof e.ledger !== "number" || !Number.isInteger(e.ledger)) {
    throw new Error("ProfileSet event missing or invalid field: ledger");
  }
}

/**
 * Handle a ProfileSet event emitted by the Kovara contract.
 *
 * Replay safety (BE-07) has two halves, and both are needed:
 *
 *  1. **The event is a state assertion, not a transition.** A `ProfileSet`
 *     states "this account's profile *is* this", so applying N deliveries of it
 *     must leave the same profile as applying one. That is guaranteed by
 *     comparing ledgers: an event whose ledger is not strictly newer than the
 *     stored `updated_ledger` is ignored, which covers both a redelivery of an
 *     already-applied event (`ledger ===`) and a replayed older one
 *     (`ledger <`) — the out-of-order case first raised in issue #927. The
 *     newest *valid* state therefore always wins, and a duplicate can never
 *     overwrite it.
 *  2. **The lookup key is canonical.** `event.user` is trimmed and folded to
 *     upper case before it is used, so an event carrying `gabc…` resolves to the
 *     same row as the `GABC…` written earlier. Skipping this would let a
 *     replayed event miss the existing row entirely, take the "no profile yet"
 *     branch and write a second profile for the same account. This mirrors
 *     `normalizeAddress` (BE-08) but deliberately does not re-validate the
 *     strkey: the shape was already checked when the event was ingested, and
 *     rejecting it here would drop an otherwise valid profile.
 *
 * If no profile exists, the first event is applied unconditionally.
 */
export async function handleProfileSet(db: Database, event: ProfileSetInput): Promise<void> {
  if (!event.user) {
    throw new Error("ProfileSet event missing required field: user");
  }

  // One canonical key for both the read and the write below.
  const address = event.user.trim().toUpperCase();

  // Validate supplied fields before touching the database.
  let username: string | undefined;
  if (event.username !== undefined) {
    if (!event.username) {
      throw new Error("ProfileSet event missing required field: username");
    }
    username = event.username.trim();
    if (username === "") {
      throw new Error("ProfileSet event username must be non-empty after trimming");
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      throw new Error(`ProfileSet event username exceeds ${MAX_USERNAME_LENGTH} characters`);
    }
  }
  let creatorToken: string | undefined;
  if (event.creator_token !== undefined) {
    creatorToken = event.creator_token.trim();
    if (creatorToken.length > MAX_CREATOR_TOKEN_LENGTH) {
      throw new Error(`ProfileSet event creator_token exceeds ${MAX_CREATOR_TOKEN_LENGTH} characters`);
    }
  }

  const existing = await db.getProfile(address);
  if (existing && event.ledger <= existing.updated_ledger) {
    logger.info(
      `Skipping replayed/stale ProfileSet for ${address} (event ledger ${event.ledger}, stored ledger ${existing.updated_ledger})`
    );
    return;
  }

  // Partial update: an omitted field keeps the stored value. A brand-new
  // profile has nothing to keep, so it needs a username.
  const finalUsername = username ?? existing?.username;
  if (finalUsername === undefined) {
    throw new Error("ProfileSet event missing required field: username");
  }

  await db.upsertProfile({
    address,
    username: finalUsername,
    creator_token: creatorToken ?? existing?.creator_token ?? "",
    updated_ledger: event.ledger,
  });
}
