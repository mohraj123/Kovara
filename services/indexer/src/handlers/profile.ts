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
 * Handle a ProfileSet event emitted by the Linkora contract.
 *
 * Idempotent: calling this multiple times with the same data produces the
 * same result (upsert semantics).
 */
export async function handleProfileSet(
  db: Database,
  event: ProfileSetEvent
): Promise<void> {
  if (!event.user) {
    throw new Error("ProfileSet event missing required field: user");
  }
  if (!event.username) {
    throw new Error("ProfileSet event missing required field: username");
  }

  await db.upsertProfile({
    address: event.user,
    username: event.username,
    creator_token: event.creator_token ?? "",
    updated_ledger: event.ledger,
  });
}
