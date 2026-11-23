/**
 * Normalization of raw Stellar contract events (issue #647).
 *
 * Soroban RPC hands back a loosely-typed envelope: base64 XDR in `topic` and
 * `value`, amounts in stroops, and a transaction that may have failed while
 * still appearing in the stream. Every handler downstream wants the same
 * handful of fields in the same shape, and the previous behaviour was for each
 * handler to decode base64 and guess at units on its own.
 *
 * This module is the single place that decoding happens, and it is pure — it
 * takes a payload and returns a normalized record, with no clock, no network
 * and no database. That separation is the point of the issue: normalization is
 * testable without standing up ingestion, and ingestion can change how it
 * fetches without touching field mapping.
 */

/** Transaction outcome as surfaced by the RPC. */
export type TxStatus = "success" | "failed";

/** A raw Stellar event after decoding, with units resolved. */
export interface NormalizedStellarEvent {
  /** The provider's event id, trimmed but otherwise as delivered. */
  eventId: string;
  /**
   * Canonical identity for replay protection: equivalent spellings of the same
   * provider id (padding, case, surrounding whitespace) map to one value. The
   * ingestion layer dedupes on this, not on `eventId`.
   */
  canonicalId: string;
  /** Contract event name, taken from the first topic. */
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  pagingToken: string;
  status: TxStatus;
  /** First topic entry that looks like a Stellar address (the actor). */
  account: string | null;
  /**
   * Remaining decoded topic entries, base64-decoded but otherwise opaque.
   * Event-specific layouts differ per contract, so these are passed through
   * rather than guessed at.
   */
  topics: string[];
  /** Decoded `value` payload as a UTF-8 string. */
  decodedValue: string;
  /**
   * `value` interpreted as a base-10 stroop amount, or null when it is not
   * numeric. Monetary amounts are never returned as a JS number: stroop
   * amounts routinely exceed 2^53 and `Number` would silently round them.
   */
  amountStroops: bigint | null;
}

/** Thrown when a payload cannot be normalized at all. */
export class NormalizationError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

/** Stellar strkey: a 56-character base-32 public key starting with `G`. */
const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

const STROOPS_PER_UNIT = 10_000_000;

/** Decimal places in a Stellar amount — one unit is 10^7 stroops. */
const FRACTIONAL_DIGITS = STROOPS_PER_UNIT.toString().length - 1;

/**
 * Decode Stellar's base64 variant.
 *
 * The alphabet is URL-safe and padding is stripped, so neither
 * `atob` nor `Buffer.from(x, "base64")` is reliable on its own — the standard
 * decoder rejects the `-`/`_` characters and the URL-safe one is not
 * available everywhere. Normalizing the alphabet and restoring the padding
 * makes the value decodable by `Buffer`.
 */
export function decodeStellarBase64(value: string): string {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const unpadded = standard.replace(/=+$/, "");
  const remainder = unpadded.length % 4;
  // A length of 1 mod 4 cannot be produced by base64 at all.
  if (remainder === 1) {
    throw new NormalizationError("value is not valid base64", "value");
  }
  const padded = remainder === 0 ? unpadded : unpadded + "=".repeat(4 - remainder);
  return Buffer.from(padded, "base64").toString("utf-8");
}

/** True when `value` is a well-formed Stellar address. */
export function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && STELLAR_ADDRESS_RE.test(value);
}

/**
 * Convert stroops to a decimal string in the asset's major unit.
 *
 * Written as integer string surgery rather than `Number(amount) / 1e7`: a
 * 90,000,000 XLM balance is `9e7 * 1e7` stroops, far past `Number.MAX_SAFE_INTEGER`.
 * Going through a float here is the single most common way an indexer quietly
 * loses precision on balances.
 */
export function stroopsToUnits(amountStroops: bigint): string {
  const negative = amountStroops < BigInt(0);
  const digits = (negative ? -amountStroops : amountStroops).toString();

  // Pad to at least 8 digits so there is always a whole-unit digit to the left
  // of the decimal point. 7 fractional digits, so the split is at
  // length - 7 — using length - 8 here would leave an empty whole part for any
  // amount below one unit and produce ".0000001" instead of "0.0000001".
  const padded = digits.padStart(FRACTIONAL_DIGITS + 1, "0");
  const split = padded.length - FRACTIONAL_DIGITS;
  const whole = padded.slice(0, split);
  const fraction = padded.slice(split);
  const body = `${whole}.${fraction}`.replace(/0+$/, "").replace(/\.$/, "");

  return negative ? `-${body}` : body;
}

/**
 * Reduce a provider event id to its canonical form.
 *
 * Soroban ids look like `0000012884905984-0000000001` (TOID and event index),
 * and the same event can be delivered zero-padded or not. Purely numeric
 * segments therefore lose their leading zeros; any other id is compared
 * case-insensitively. The result is deterministic and idempotent.
 */
export function canonicalizeEventId(rawId: string): string {
  const trimmed = rawId.trim();
  const parts = trimmed.split("-");
  if (parts.every((part) => /^\d+$/.test(part))) {
    return parts.map((part) => part.replace(/^0+(?=\d)/, "")).join("-");
  }
  return trimmed.toLowerCase();
}

/** Parse a decimal integer string, or return null when it is not one. */
function parseIntegerString(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

/**
 * Derive a transaction status from the raw envelope.
 *
 * The RPC signals a failed transaction with `status: "failed"` (and the
 * `errorResult` field). A failed transaction is still emitted into the event
 * stream, so anything that treats every streamed event as a success will index
 * effects that were rolled back. Defaulting to `"success"` when the field is
 * absent preserves the behaviour of streams that do not report status at all.
 */
export function resolveStatus(raw: Record<string, unknown>): TxStatus {
  const status = raw.status;
  if (typeof status === "string") {
    return status.toLowerCase() === "failed" ? "failed" : "success";
  }
  if (raw.errorResult !== undefined && raw.errorResult !== null) {
    return "failed";
  }
  if (raw.failed === true) {
    return "failed";
  }
  return "success";
}

/** Options for {@link normalizeStellarEvent}. */
export interface NormalizeOptions {
  /**
   * Require the full event envelope (contract id, transaction hash, close time
   * and an event-name topic) and reject the event if any of it is missing.
   * The ingestion pipeline sets this so an incomplete event never reaches a
   * handler; the default stays lenient for callers that only need best effort.
   */
  strict?: boolean;
}

function requireString(raw: Record<string, unknown>, field: string, eventId: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new NormalizationError(`event ${eventId} is missing ${field}`, field);
  }
  return value;
}

/** Throws a `NormalizationError` naming the first required envelope field that is absent or malformed. */
function validateEnvelope(raw: Record<string, unknown>, eventId: string): void {
  requireString(raw, "contractId", eventId);
  requireString(raw, "txHash", eventId);
  const closedAt = requireString(raw, "ledgerClosedAt", eventId);
  if (Number.isNaN(Date.parse(closedAt))) {
    throw new NormalizationError(`event ${eventId} has an invalid ledgerClosedAt`, "ledgerClosedAt");
  }
  if (!Array.isArray(raw.topic) || raw.topic.length === 0 || typeof raw.topic[0] !== "string") {
    throw new NormalizationError(`event ${eventId} is missing its event-name topic`, "topic");
  }
  if (raw.value !== undefined && raw.value !== null && typeof raw.value !== "string") {
    throw new NormalizationError(`event ${eventId} has a non-string value`, "value");
  }
}

/**
 * Normalize one raw RPC event into the internal shape.
 *
 * Throws `NormalizationError` only for input that is structurally unusable
 * (missing identity or ledger; with `strict`, also a missing envelope field);
 * everything else degrades to a null field, because a single odd topic should
 * not cost us the event.
 */
export function normalizeStellarEvent(
  input: unknown,
  options: NormalizeOptions = {}
): NormalizedStellarEvent {
  if (typeof input !== "object" || input === null) {
    throw new NormalizationError("event must be an object", "event");
  }
  const raw = input as Record<string, unknown>;

  const eventId = typeof raw.id === "string" ? raw.id.trim() : "";
  if (eventId === "") {
    throw new NormalizationError("event id is required", "id");
  }

  const ledger = raw.ledger;
  const ledgerNumber = typeof ledger === "number" ? ledger : Number(ledger);
  if (!Number.isInteger(ledgerNumber) || ledgerNumber < 0) {
    throw new NormalizationError(`event ${eventId} has an invalid ledger`, "ledger");
  }

  if (options.strict) validateEnvelope(raw, eventId);

  const rawTopics = Array.isArray(raw.topic) ? raw.topic : [];
  const topics = rawTopics.map((topic) => {
    if (typeof topic !== "string") return "";
    try {
      return decodeStellarBase64(topic);
    } catch {
      // A topic we cannot decode is reported as empty rather than failing the
      // whole event: the event name and account are the fields callers need.
      return "";
    }
  });

  const rawValue = typeof raw.value === "string" ? raw.value : "";
  let decodedValue = "";
  try {
    decodedValue = rawValue === "" ? "" : decodeStellarBase64(rawValue);
  } catch {
    decodedValue = "";
  }

  const account = topics.find(isStellarAddress) ?? null;

  // In strict mode the event name must actually decode; an empty `type` would
  // reach the handler dispatch with nothing to dispatch on.
  if (options.strict && (topics[0]?.trim() ?? "") === "") {
    throw new NormalizationError(`event ${eventId} has an undecodable event-name topic`, "topic");
  }

  return {
    eventId,
    canonicalId: canonicalizeEventId(eventId),
    // The event name is a short symbol ("post_created"), which the indexer's
    // own handlers already use as the dispatch key.
    type: topics[0]?.trim() ?? "",
    ledger: ledgerNumber,
    ledgerClosedAt: typeof raw.ledgerClosedAt === "string" ? raw.ledgerClosedAt : "",
    contractId: typeof raw.contractId === "string" ? raw.contractId : "",
    txHash: typeof raw.txHash === "string" ? raw.txHash : "",
    pagingToken: typeof raw.pagingToken === "string" ? raw.pagingToken : "",
    status: resolveStatus(raw),
    account,
    topics,
    decodedValue,
    amountStroops: parseIntegerString(decodedValue),
  };
}

/** Normalize a batch, dropping entries that cannot be normalized. */
export function normalizeStellarEvents(
  inputs: readonly unknown[],
  options: NormalizeOptions = {}
): NormalizedStellarEvent[] {
  const normalized: NormalizedStellarEvent[] = [];
  for (const input of inputs) {
    try {
      normalized.push(normalizeStellarEvent(input, options));
    } catch {
      // Skipped deliberately: one malformed payload must not discard the rest
      // of the batch. The caller sees a shorter list and can compare counts.
    }
  }
  return normalized;
}
