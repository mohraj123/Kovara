/**
 * Tamper-evident audit records.
 *
 * Issue #658. An audit log that an operator with write access can quietly edit
 * is not an audit log. Each record therefore carries the hash of its own
 * canonical content *and* the hash of the previous record, forming a chain:
 *
 *   hash(n) = SHA256(canonical(record n) || hash(n-1))
 *
 * Altering or removing any record breaks every hash after it, and
 * {@link verifyChain} reports the first record where the recomputed hash stops
 * matching. That converts "someone changed the log" from an undetectable
 * possibility into a verifiable fact, without requiring an external notary.
 *
 * The chain is per-stream, not global, so concurrent writers for different
 * streams do not serialise on each other.
 *
 * The canonical form is a fixed field order with lengths, not JSON of an
 * arbitrary object. Field order in JSON is not guaranteed across versions and
 * across languages, so hashing a serialized object would produce a different
 * digest for identical facts and make the chain useless.
 */

import { createHash } from "crypto";

/** The kinds of action recorded. Extend deliberately — the value is a filter key. */
export type AuditAction =
  | "contract.deployed"
  | "contract.upgraded"
  | "event.observed"
  | "event.processed"
  | "event.failed"
  | "event.replayed"
  | "submission.received"
  | "submission.verified"
  | "submission.rejected"
  | "reward.accrued"
  | "reward.claimed"
  | "reward.failed";

/** Who or what performed the action. */
export type AuditActor =
  | { kind: "address"; address: string }
  | { kind: "system"; component: string }
  | { kind: "unknown" };

/** Outcome of the action, so a failure is distinguishable from an attempt. */
export type AuditOutcome = "success" | "failure" | "skipped";

/** One audit entry, before hashing. */
export interface AuditEntryInput {
  /** Partition key. The chain is independent per stream. */
  stream: string;
  action: AuditAction;
  actor: AuditActor;
  outcome: AuditOutcome;
  /** The contract or entity the action touched. */
  subject: string;
  /** Stellar ledger the action relates to, when applicable. */
  ledger?: number;
  /** Stellar transaction hash, when applicable. */
  transactionHash?: string;
  /**
   * Structured context. Retained verbatim and returned by the API, because
   * "logs preserve enough context for forensic review" means the detail has to
   * actually be there — an entry that only says "submission.rejected" is not
   * reviewable.
   */
  metadata?: Record<string, unknown>;
  /** When the action happened. Supplied by the caller, never by the logger. */
  occurredAt: Date;
}

/** A stored audit entry. */
export interface AuditEntry extends AuditEntryInput {
  id: string;
  /** This record's own hash. */
  hash: string;
  /** The previous record's hash in this stream; the genesis record's is 64 zeros. */
  previousHash: string;
}

/** The hash a chain starts from. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Canonical byte form of an entry.
 *
 * Explicit, length-prefixed, and in a fixed order. A length prefix matters:
 * without it, `metadata: {a: "bc"}` and `{ab: "c"}` could produce the same
 * bytes, so a record could be altered without changing its hash.
 */
export function canonicalize(input: AuditEntryInput): string {
  const parts: string[] = [
    input.stream,
    input.action,
    actorKeyOf(input.actor),
    input.outcome,
    input.subject,
    input.ledger === undefined ? "" : String(input.ledger),
    input.transactionHash ?? "",
    input.occurredAt.toISOString(),
    // A stable key order, so the same metadata always serialises identically.
    stableStringify(input.metadata ?? {}),
  ];
  return parts.map((part) => `${part.length}:${part}`).join("|");
}

/**
 * A single string identifying the actor, unambiguous across its variants.
 *
 * Exported because the store persists and filters on this form directly: an
 * address is stored as `address:G...` so a filter for an address cannot match a
 * system component whose name happens to start with the same characters.
 */
export function actorKeyOf(actor: AuditActor): string {
  switch (actor.kind) {
    case "address":
      return `address:${actor.address}`;
    case "system":
      return `system:${actor.component}`;
    default:
      return "unknown";
  }
}


/** JSON with object keys sorted at every depth, so output is deterministic. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Built by concatenation rather than a nested template literal: the nesting
  // is hard to read, and it is the one construct here that naive source
  // scanners (including this repo's own structural check) mis-parse.
  const body = entries
    .map(([key, v]) => JSON.stringify(key) + ":" + stableStringify(v))
    .join(",");
  return "{" + body + "}";
}

/** Hash an entry given the previous hash in its stream. */
export function hashEntry(input: AuditEntryInput, previousHash: string): string {
  return createHash("sha256")
    .update(canonicalize(input))
    .update(previousHash)
    .digest("hex");
}

/** Build a chained entry from an input and the current chain head. */
export function chainEntry(
  input: AuditEntryInput,
  previousHash: string,
  id: string
): AuditEntry {
  return {
    ...input,
    id,
    hash: hashEntry(input, previousHash),
    previousHash,
  };
}

/** Result of verifying one stream's chain. */
export interface ChainVerification {
  stream: string;
  valid: boolean;
  checked: number;
  /** The first entry whose stored hash does not match a recomputation. */
  brokenAt: string | null;
  /** Why it is broken, when it is. */
  reason: string | null;
}

/**
 * Recompute a chain and report the first break.
 *
 * Checks both properties that matter: that each entry's own hash matches its
 * content, and that each entry's `previousHash` matches its predecessor's
 * `hash`. A deletion is caught by the second check even though the remaining
 * entries are individually self-consistent — which is why both are verified
 * rather than just the first.
 */
export function verifyChain(entries: AuditEntry[]): ChainVerification {
  const stream = entries[0]?.stream ?? "";
  let previous = GENESIS_HASH;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.previousHash !== previous) {
      return {
        stream,
        valid: false,
        checked: index,
        brokenAt: entry.id,
        // Named explicitly: a missing record looks identical to a rewritten one
        // from the chain alone, and the operator needs to know which to look for.
        reason: "previousHash does not match the preceding entry — an entry may have been removed or reordered",
      };
    }
    const expected = hashEntry(entry, entry.previousHash);
    if (expected !== entry.hash) {
      return {
        stream,
        valid: false,
        checked: index,
        brokenAt: entry.id,
        reason: "entry content does not match its stored hash — the record was modified",
      };
    }
    previous = entry.hash;
  }

  return { stream, valid: true, checked: entries.length, brokenAt: null, reason: null };
}
