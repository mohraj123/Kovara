/**
 * Handler for ProfileSet contract events.
 *
 * Upserts the profile record so the latest username and creator_token
 * are always reflected in the index.
 */

import { Database } from "../db";

export interface ProfileSetEvent {
  user: string;
  username: string;
  creator_token: string;
  ledger: number;
}

/**
 * Validate a raw event object has the shape expected for a ProfileSet event.
 * Throws a descriptive error for any missing or incorrectly typed field.
 */
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
 * Idempotent: calling this multiple times with the same data produces the
 * same result (upsert semantics).
 */
export async function handleProfileSet(db: Database, event: ProfileSetEvent): Promise<void> {
  if (!event.user) {
    throw new Error("ProfileSet event missing required field: user");
  }
  if (!event.username) {
    throw new Error("ProfileSet event missing required field: username");
  }

  const trimmedUsername = event.username.trim();
  if (trimmedUsername === "") {
    throw new Error("ProfileSet event username must be non-empty after trimming");
  }

  await db.upsertProfile({
    address: event.user,
    username: trimmedUsername,
    creator_token: event.creator_token ?? "",
    updated_ledger: event.ledger,
  });
}
