/**
 * Soroban event streaming via Horizon/Soroban RPC.
 *
 * Polls getEvents on the configured RPC endpoint and yields raw contract
 * events for the Kovara contract. Callers provide a cursor (latest processed
 * ledger) so the stream can resume after a restart.
 *
 * BE-42: Also provides replay recovery utilities so operators can re-process
 * a range of ledgers or specific event types after an interruption.
 */
 // const applied = await getAppliedMigrations(pool);
/**
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 * Idempotent: if the follow already exists the handler returns immediately
 * without issuing a database write.
 */
import { logger } from "./logger";

import { normalizeRawEvent } from "./normalize";
import { withRetry } from "./retry";

    // current.requestCount++;
export interface RawEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  topic: string[];
  value: string;
  txHash: string;
}

export interface StreamConfig {
  rpcUrl: string;
  contractId: string;
  startLedger: number;
  pollIntervalMs?: number;
  /**
   * BE-24: Maximum number of recent tx hashes to keep in the in-process
   * deduplication set.  Older entries are evicted in insertion order to
   * bound memory usage.  Defaults to 10 000.
   */
  dedupCacheSize?: number;
  /**
   * BE-42: Optional event type filter. When set, only events whose topic[0]
   * matches one of these strings are dispatched to the handler.
   */
  eventTypeFilter?: string[];
}

export type EventHandler = (event: RawEvent) => Promise<void>;

/**
 * Validate that a raw event has the minimum required structure before dispatch.
 * Returns true if the event is structurally valid, false otherwise.
 */
export function validateEventPayload(event: unknown): event is RawEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  if (typeof e.type !== "string" || e.type.trim() === "") return false;
  if (typeof e.ledger !== "number" || !Number.isInteger(e.ledger)) return false;
  if (typeof e.contractId !== "string" || e.contractId.trim() === "") return false;
  if (typeof e.id !== "string" || e.id.trim() === "") return false;
  if (typeof e.pagingToken !== "string" || e.pagingToken.trim() === "") return false;
  if (!Array.isArray(e.topic)) return false;
  if (typeof e.value !== "string") return false;
  if (typeof e.txHash !== "string" || e.txHash.trim() === "") return false;
  return true;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_EVENTS_PER_PAGE = 100;
/**
 * BA-035: Cap for the progressive RPC backoff. After prolonged failures the
 * inter-poll delay grows toward this ceiling (60s) and resets on success.
 */
const MAX_BACKOFF_MS = 60_000;
/**
 * BA-037: Number of consecutive full pages that return the same cursor before
 * we treat the pagination as stalled and raise an error, avoiding an endless
 * tight loop. Repeated cursors never silently skip events — the stream stops
 * and surfaces the problem instead.
 */
const MAX_REPEATED_CURSOR = 3;
/**
 * BE-24: Default size of the in-memory tx-hash deduplication ring buffer.
 * Large enough to cover a typical replay window without exhausting memory.
 */
const DEFAULT_DEDUP_CACHE_SIZE = 10_000;

const RPC_FETCH_TIMEOUT_MS = parseInt(process.env["RPC_FETCH_TIMEOUT_MS"] ?? "", 10) || 15_000;

/**
 * BA-036: Shape-validate a getEvents RPC result.
 *
 * Malformed provider responses must be surfaced as errors rather than being
 * silently coerced into an "empty page", which would hide a real provider
 * failure and could permanently stall ingestion. We validate the top-level
 * `result`, the `events` array, each event's structural fields, `latestLedger`,
 * and the pagination token carried by each event.
 *
 * Returns a normalized `{ events, latestLedger }` on success and throws an
 * Error describing the first schema violation it finds.
 */
export interface EventsResult {
  events: RawEvent[];
  latestLedger: number;
}

function validateLedger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid RPC result: ${field} must be a non-negative integer`);
  }
  return value;
}

function validateEventsResult(json: unknown): EventsResult {
  if (!json || typeof json !== "object") {
    throw new Error("Invalid RPC result: expected an object result");
  }
  const result = (json as Record<string, unknown>).result;
  if (!result || typeof result !== "object") {
    throw new Error("Invalid RPC result: missing object `result`");
  }
  const events = (result as Record<string, unknown>).events;
  if (!Array.isArray(events)) {
    throw new Error("Invalid RPC result: `result.events` is not an array");
  }

  const parsedEvents: RawEvent[] = [];
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object") {
      throw new Error("Invalid RPC result: event entry is not an object");
    }
    const e = rawEvent as Record<string, unknown>;
    if (typeof e.type !== "string" || e.type.trim() === "") {
      throw new Error("Invalid RPC result: event `type` must be a non-empty string");
    }
    if (typeof e.ledger !== "number" || !Number.isInteger(e.ledger) || e.ledger < 0) {
      throw new Error("Invalid RPC result: event `ledger` must be a non-negative integer");
    }
    if (typeof e.contractId !== "string" || e.contractId.trim() === "") {
      throw new Error("Invalid RPC result: event `contractId` must be a non-empty string");
    }
    if (typeof e.id !== "string" || e.id.trim() === "") {
      throw new Error("Invalid RPC result: event `id` must be a non-empty string");
    }
    if (typeof e.pagingToken !== "string" || e.pagingToken.trim() === "") {
      throw new Error("Invalid RPC result: event `pagingToken` (pagination) must be a non-empty string");
    }
    if (!Array.isArray(e.topic) || e.topic.some((t: unknown) => typeof t !== "string")) {
      throw new Error("Invalid RPC result: event `topic` must be an array of strings");
    }
    if (typeof e.value !== "string") {
      throw new Error("Invalid RPC result: event `value` must be a string");
    }
    if (typeof e.txHash !== "string") {
      throw new Error("Invalid RPC result: event `txHash` must be a string");
    }
    parsedEvents.push(rawEvent as RawEvent);
  }

  const latestLedger = validateLedger(
    (result as Record<string, unknown>).latestLedger,
    "result.latestLedger",
  );

  return { events: parsedEvents, latestLedger };
}

async function fetchEvents(
  rpcUrl: string,
  contractId: string,
  startLedger: number,
  cursor?: string
): Promise<{ events: RawEvent[]; latestLedger: number }> {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: 1,
    method: "getEvents",
    params: {
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
        },
      ],
      pagination: {
        limit: MAX_EVENTS_PER_PAGE,
        ...(cursor ? { cursor } : {}),
      },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    result?: {
      events: RawEvent[];
      latestLedger: number;
    };
    error?: { message: string };
  };

  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }

  // BA-036: shape-validate the result so a malformed provider response is
  // surfaced instead of being silently treated as an empty page.
  return validateEventsResult(json);
}

/**
 * Stream Soroban contract events and invoke `handler` for each.
 *
 * Runs until `signal` is aborted. Maintains a cursor so restarts resume
 * without re-processing events. Returns the latest ledger seen.
 *
 * BE-24: An in-memory LRU-style ring buffer of recently seen event IDs
 * prevents the handler from being called twice for the same event when the
 * RPC layer returns overlapping pages or when the stream is restarted with
 * an overlapping start ledger. The database-level ON CONFLICT guards remain
 * in place as the authoritative deduplication layer; this is a cheaper
 * first-pass filter that avoids unnecessary round-trips.
 */
export async function streamEvents(
  config: StreamConfig,
  handler: EventHandler,
  signal: AbortSignal
): Promise<void> {
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxCacheSize = config.dedupCacheSize ?? DEFAULT_DEDUP_CACHE_SIZE;
  let cursor: string | undefined;
  let startLedger = config.startLedger;

  // BA-035: Progressive backoff across poll iterations. Grows on consecutive
  // failures up to MAX_BACKOFF_MS and resets after a successful fetch.
  let backoffMs = pollMs;
  let consecutiveFailures = 0;
  // BA-037: Repeated-cursor stall detection.
  let repeatedCursor = 0;

  // BE-24: Ring-buffer deduplication set.  We track event.id (the stable
  // Soroban event identifier) rather than txHash so that two distinct events
  // within the same transaction are not incorrectly merged.
  const seenEventIds = new Set<string>();
  // Insertion-order queue used to evict the oldest entry when the cache is full.
  const seenEventIdsQueue: string[] = [];

  function markSeen(eventId: string): void {
    if (seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    seenEventIdsQueue.push(eventId);
    if (seenEventIdsQueue.length > maxCacheSize) {
      const oldest = seenEventIdsQueue.shift();
      if (oldest !== undefined) seenEventIds.delete(oldest);
    }
  }

  console.log(`[stream] Starting from ledger ${startLedger}, contract=${config.contractId}`);

  while (!signal.aborted) {
    try {
      // BA-037: remember the cursor we are fetching from so we can detect
      // pagination that makes no forward progress.
      const fetchCursor = cursor;
      const { events, latestLedger } = await withRetry(
        () => fetchEvents(config.rpcUrl, config.contractId, startLedger, fetchCursor),
        {
          maxAttempts: 3,
          baseDelayMs: 300,
          backoffMultiplier: 2,
          isRetryable: (err: unknown) => {
            if (err instanceof Error) {
              const msg = err.message.toLowerCase();
              return (
                msg.includes("econnreset") ||
                msg.includes("econnrefused") ||
                msg.includes("socket hang up") ||
                msg.includes("timeout") ||
                msg.includes("failed to fetch") ||
                msg.includes("network") ||
                msg.includes("502") ||
                msg.includes("503") ||
                msg.includes("504")
              );
            }
            return true;
          },
          operationLabel: "fetchEvents",
        }
      );

      // A successful fetch resets the progressive backoff (BA-035).
      consecutiveFailures = 0;
      backoffMs = pollMs;

      // BA-034: Do not advance past events whose handler throwing. We process
      // events in order; the first failure halts page advancement so the failed
      // event remains retryable on the next pass, while events before it were
      // already marked seen and will not be re-dispatched.
      let pageFailed = false;

      for (const event of events) {
        if (signal.aborted) break;
        if (!validateEventPayload(event)) {
          console.error("[stream] Skipping invalid event payload:", JSON.stringify(event));
          cursor = event.pagingToken;
          continue;
        }

        const normalizedEvent = normalizeRawEvent(event);

        // BE-42: Skip events that do not match the configured event type filter.
        if (config.eventTypeFilter && !config.eventTypeFilter.includes(normalizedEvent.type)) {
          cursor = normalizedEvent.pagingToken;
          continue;
        }

        // BE-24: Skip already-processed events before hitting the handler or DB.
        if (seenEventIds.has(normalizedEvent.id)) {
          console.log(`[stream] Skipping duplicate event id=${normalizedEvent.id} tx=${normalizedEvent.txHash}`);
          cursor = normalizedEvent.pagingToken;
          continue;
        }

        // BA-034: a handler error must NOT advance the cursor, so the failed
        // event is retried on a subsequent fetch instead of being lost.
        try {
          await handler(normalizedEvent);
        } catch (err) {
          console.error(
            `[stream] Handler error for event ${normalizedEvent.id} (type=${normalizedEvent.type}), will retry:`,
            err
          );
          pageFailed = true;
          break;
        }

        markSeen(normalizedEvent.id);
        cursor = normalizedEvent.pagingToken;
      }

      // BA-037: A full page that does not advance the cursor means the RPC
      // provider keeps returning the same page. Guard against the resulting
      // endless tight loop with a bounded retry that surfaces the stall.
      // A handler failure (BA-034) also means no advance, but that must fall
      // through to the backoff sleep below so the failed event is retried
      // without spinning.
      if (pageFailed) {
        // Keep `cursor` at the last successfully-dispatched event so the failed
        // event is retried on the next pass. Fall through to the sleep below.
      } else {
        if (events.length === MAX_EVENTS_PER_PAGE && cursor === fetchCursor) {
          repeatedCursor += 1;
          if (repeatedCursor > MAX_REPEATED_CURSOR) {
            throw new Error(
              `[stream] Pagination stalled: ${MAX_REPEATED_CURSOR} consecutive full pages ` +
              `returned the same cursor "${cursor}". Aborting to avoid an endless loop.`,
            );
          }
          continue; // allow a bounded number of retries before raising
        }
        if (repeatedCursor > 0) repeatedCursor = 0;

        if (events.length === MAX_EVENTS_PER_PAGE) {
          continue;
        }

        startLedger = latestLedger;
      }
    } catch (err) {
      // BA-035: grow the backoff on consecutive failures, capped, and abortable.
      consecutiveFailures += 1;
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      logger.error("Error fetching events:", err);
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoffMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  console.log("[stream] Stopped.");
}

// ---------------------------------------------------------------------------
// BE-42: Replay recovery utilities
// ---------------------------------------------------------------------------

export interface ReplayConfig {
  rpcUrl: string;
  contractId: string;
  startLedger: number;
  endLedger: number;
  eventTypeFilter?: string[];
  batchSize?: number;
}

/**
 * Replay a range of ledgers (inclusive) by polling the RPC endpoint for every
 * ledger in [startLedger, endLedger].  Events that match the optional
 * eventTypeFilter are passed to `handler`.  No in-memory deduplication is
 * performed because the caller (or the handler's backing store) is expected to
 * enforce idempotency (e.g. ON CONFLICT DO NOTHING).
 *
 * Returns the number of events dispatched.
 */
export async function replayLedgerRange(
  config: ReplayConfig,
  handler: EventHandler,
  signal: AbortSignal,
): Promise<number> {
  const batchSize = config.batchSize ?? MAX_EVENTS_PER_PAGE;
  let totalDispatched = 0;
  let cursor: string | undefined;

  console.log(
    `[replay] Replaying ledgers ${config.startLedger}–${config.endLedger} ` +
    `contract=${config.contractId} filter=${config.eventTypeFilter?.join(",") ?? "all"}`,
  );

  for (let ledger = config.startLedger; ledger <= config.endLedger && !signal.aborted; ledger++) {
    let hasMore = true;
    cursor = undefined;

    while (hasMore && !signal.aborted) {
      let repeatedCursor = 0;
      try {
        const { events } = await withRetry(
          () => fetchEvents(config.rpcUrl, config.contractId, ledger, cursor),
          {
            maxAttempts: 3,
            baseDelayMs: 300,
            backoffMultiplier: 2,
            isRetryable: (err: unknown) => {
              if (err instanceof Error) {
                const msg = err.message.toLowerCase();
                return msg.includes("timeout") || msg.includes("econnreset") || msg.includes("503");
              }
              return true;
            },
            operationLabel: "replayFetchEvents",
          },
        );

        // BA-037: record the cursor this page was fetched from so a page that
        // returns the same cursor can be detected and bounded.
        const fetchCursor = cursor;

        for (const event of events) {
          if (signal.aborted) break;
          if (!validateEventPayload(event)) continue;

          const normalized = normalizeRawEvent(event);

          if (config.eventTypeFilter && !config.eventTypeFilter.includes(normalized.type)) {
            cursor = normalized.pagingToken;
            continue;
          }

          try {
            await handler(normalized);
            totalDispatched++;
          } catch (err) {
            console.error(`[replay] Handler error for event ${normalized.id}:`, err);
          }

          cursor = normalized.pagingToken;
        }

        hasMore = events.length === batchSize;

        // BA-037: a full page whose final cursor is unchanged means the provider
        // keeps returning the same page; abort instead of looping forever.
        if (hasMore && cursor === fetchCursor) {
          repeatedCursor += 1;
          if (repeatedCursor > MAX_REPEATED_CURSOR) {
            throw new Error(
              `[replay] Pagination stalled for ledger ${ledger}: ` +
              `${MAX_REPEATED_CURSOR} consecutive full pages returned the same cursor. ` +
              `Aborting to avoid an endless loop.`,
            );
          }
        }
      } catch (err) {
        console.error(`[replay] Error fetching ledger ${ledger}:`, err);
        hasMore = false;
      }
    }
  }

  console.log(`[replay] Completed. Dispatched ${totalDispatched} events.`);
  return totalDispatched;
}

/**
 * Replay events for specific event types within a ledger range.
 * Convenience wrapper around `replayLedgerRange`.
 */
export async function replayEventTypes(
  config: ReplayConfig,
  handler: EventHandler,
  signal: AbortSignal,
): Promise<number> {
  return replayLedgerRange(
    {
      ...config,
      eventTypeFilter: config.eventTypeFilter,
    },
    handler,
    signal,
  );
}
  logger.always("Stopped.");
}
