/**
 * Idempotency keys for ledger event processing.
 *
 * Issue #648. The indexer can legitimately see the same on-chain event more
 * than once: `getEvents` pages may overlap when a cursor is replayed, a restart
 * resumes from a persisted cursor that can precede the last committed event, an
 * operator replays a ledger range on purpose, and two replicas briefly race
 * during a leader handoff. Every one of those paths must be a no-op rather
 * than a second write — a duplicated tip total or a double-incremented like
 * count is not recoverable by retrying, because the wrong value is already
 * committed.
 *
 * The key design, in one place:
 *
 *   - The key is **derived**, never caller-supplied. `buildIdempotencyKey`
 *     combines the contract id, ledger sequence, and the event id — the three
 *     values a Soroban event carries and the provider guarantees to be stable
 *     for a given event. Deriving it means a caller cannot accidentally (or
 *     deliberately) reuse a key across two different events, which would make
 *     the second event a silent no-op.
 *   - The key is **namespaced by version** (`kovara:event:v1:…`). If the
 *     identity of an event ever changes — a new discriminator is added, or the
 *     contract moves to a new deployment — the version suffix changes and old
 *     rows are ignored rather than misread as already-processed.
 *   - Uniqueness is enforced by the database (`events.event_id` UNIQUE, and the
 *     `ON CONFLICT DO NOTHING` in `persistEvent`), so two processes racing on
 *     the same key cannot both win. This module supplies the *stable identity*
 *     and the *validation*; the database supplies the atomicity.
 *
 * Validation matters as much as derivation. A malformed or empty key that
 * reaches the store would either collide with every other malformed key or
 * match nothing, and both outcomes are silent. {@link isValidIdempotencyKey}
 * and {@link parseIdempotencyKey} reject those inputs at the boundary, before
 * any database work happens.
 */

/** Namespace version. Bump when the components of a key change. */
export const IDEMPOTENCY_KEY_VERSION = "v1";

/** Prefix every key carries, so keys are greppable in the database. */
export const IDEMPOTENCY_KEY_PREFIX = "kovara:event";

/**
 * Maximum accepted length of an idempotency key. Derived keys are well under
 * this (56-char contract id + up to 20-digit ledger + a 64-char event id); the
 * limit exists so an unbounded caller-supplied string cannot be used to push
 * megabytes into a unique index.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/** A parsed idempotency key. */
export interface IdempotencyKey {
  version: string;
  contractId: string;
  ledger: number;
  eventId: string;
}

/** The ledger sequence is an unsigned 32-bit integer. */
const MAX_LEDGER = 4_294_967_295;

/**
 * Build the canonical idempotency key for an event.
 *
 * @param contractId the contract the event was emitted by
 * @param ledger     the ledger sequence that closed the event
 * @param eventId    the provider's stable event identifier
 */
export function buildIdempotencyKey(
  contractId: string,
  ledger: number,
  eventId: string
): string {
  return `${IDEMPOTENCY_KEY_PREFIX}:${IDEMPOTENCY_KEY_VERSION}:${contractId}:${ledger}:${eventId}`;
}

/**
 * Validate a key's shape without parsing it. Returns true when the value is
 * safe to use as an idempotency key.
 *
 * Accepts both the namespaced form produced by {@link buildIdempotencyKey} and
 * a bare event id, because the `events.event_id` column stores the bare form
 * and callers legitimately hold that value.
 */
export function isValidIdempotencyKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return false;
  // Reject control characters: they are invisible in a log line and in psql
  // output, which makes a poisoned key very hard to spot after the fact.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return true;
}

/**
 * Parse a namespaced key back into its components.
 *
 * Returns null when the key is not a well-formed key of the current version —
 * a bare event id, a truncated key, or a key from a future version. Callers
 * that only need equality should compare strings rather than parse.
 */
export function parseIdempotencyKey(value: string): IdempotencyKey | null {
  if (!isValidIdempotencyKey(value)) return null;

  const parts = value.trim().split(":");
  // prefix : version : contractId : ledger : eventId
  if (parts.length !== 5) return null;
  const [prefix, version, contractId, ledgerRaw, eventId] = parts;
  if (prefix !== IDEMPOTENCY_KEY_PREFIX) return null;
  if (version !== IDEMPOTENCY_KEY_VERSION) return null;
  if (contractId === "") return null;
  if (eventId === "") return null;
  if (!/^\d+$/.test(ledgerRaw)) return null;

  const ledger = Number(ledgerRaw);
  if (!Number.isSafeInteger(ledger) || ledger < 0 || ledger > MAX_LEDGER) return null;

  return { version, contractId, ledger, eventId };
}

/**
 * Whether two keys refer to the same event.
 *
 * A namespaced key and the bare event id it contains are the same event, so a
 * caller holding one form can be compared against a record storing the other.
 */
export function isSameEvent(a: string, b: string): boolean {
  if (a === b) return true;
  const parsedA = parseIdempotencyKey(a);
  const parsedB = parseIdempotencyKey(b);
  if (parsedA && parsedB) {
    return (
      parsedA.contractId === parsedB.contractId &&
      parsedA.ledger === parsedB.ledger &&
      parsedA.eventId === parsedB.eventId
    );
  }
  return false;
}

/** What a store lookup found for a key. */
export type IdempotencyLookup =
  /** The key was never seen; the caller should perform the work. */
  | { status: "new" }
  /** The key was seen and its work completed; the caller must not repeat it. */
  | { status: "processed"; processedAt: Date | null }
  /** The key was seen but its work failed previously; it may be retried. */
  | { status: "failed"; error: string | null; attempts: number };

/**
 * The persistence surface idempotent processing needs.
 *
 * Deliberately narrow: the implementation only requires that a key can be
 * looked up, claimed, and marked processed/failed. That keeps the transaction
 * semantics in the concrete `PostgresEventStore` where the `pg` client lives,
 * and lets the tests use a plain in-memory map.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim a key for processing. Returns false when another worker
   * already holds the claim, in which case the caller must not run the work.
   */
  claim(key: string): Promise<boolean>;
  /** Look up the current state of a key. */
  lookup(key: string): Promise<IdempotencyLookup>;
  /** Record that the work for a key completed. */
  markProcessed(key: string): Promise<void>;
  /** Record that the work for a key failed, retaining the error. */
  markFailed(key: string, error: string): Promise<void>;
}

/** Outcome of a guarded unit of work. */
export type IdempotentOutcome =
  /** The work ran now, for the first time. */
  | { status: "applied" }
  /** The work had already completed; the previous result stands. */
  | { status: "duplicate"; previous: IdempotencyLookup & { status: "processed" } };

/**
 * Run `work` at most once per key.
 *
 * The sequence is: look up the key, run the work if it has not completed,
 * claim it, then mark the outcome. A `failed` lookup is *not* short-circuited
 * — a previously failed key is eligible to run again, which is what makes
 * retrying a dead-lettered event correct rather than a no-op.
 *
 * Concurrency: the claim is the mutual-exclusion point. If the claim is lost
 * the work is not run, so two concurrent callers of the same key produce one
 * execution. Note the claim happens *after* `work` is not run but *before* it
 * runs, so a process that dies between the claim and `markProcessed` leaves the
 * key claimed rather than completed; that is the safe direction to fail,
 * because the alternative — marking processed and then dying — would lose the
 * work permanently.
 */
export async function runOnce<T>(
  store: IdempotencyStore,
  key: string,
  work: () => Promise<T>
): Promise<IdempotentOutcome> {
  if (!isValidIdempotencyKey(key)) {
    throw new Error(`Invalid idempotency key: ${JSON.stringify(String(key)).slice(0, 64)}`);
  }

  const existing = await store.lookup(key);
  if (existing.status === "processed") {
    return { status: "duplicate", previous: existing };
  }

  const claimed = await store.claim(key);
  if (!claimed) {
    // Another worker owns the key right now. Re-read so the caller can report
    // what that worker did; if it has not finished yet the state is still
    // "new" or "failed", and the caller should treat the work as in flight.
    const current = await store.lookup(key);
    if (current.status === "processed") {
      return { status: "duplicate", previous: current };
    }
    // The work is still in flight, so it has no completion timestamp. Report a
    // processed marker with a null time rather than synthesising one.
    return { status: "duplicate", previous: { status: "processed", processedAt: null } };
  }

  try {
    await work();
  } catch (err) {
    await store.markFailed(key, err instanceof Error ? err.message : String(err));
    throw err;
  }

  await store.markProcessed(key);
  return { status: "applied" };
}
