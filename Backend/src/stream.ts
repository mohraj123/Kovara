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
 * BE-24: Default size of the in-memory tx-hash deduplication ring buffer.
 * Large enough to cover a typical replay window without exhausting memory.
 */
const DEFAULT_DEDUP_CACHE_SIZE = 10_000;

const RPC_FETCH_TIMEOUT_MS = parseInt(process.env["RPC_FETCH_TIMEOUT_MS"] ?? "", 10) || 15_000;

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

  return {
    events: json.result?.events ?? [],
    latestLedger: json.result?.latestLedger ?? startLedger,
  };
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

  while (!signal.aborted) {    try {
      const { events, latestLedger } = await withRetry(
        () => fetchEvents(config.rpcUrl, config.contractId, startLedger, cursor),
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

      for (const event of events) {
        if (signal.aborted) break;
        if (!validateEventPayload(event)) {
          // BA-039: Route through the structured logger so the payload is
          // redacted before it reaches the console.
          logger.warn("skipping_invalid_event", { eventType: String(event.type) });
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
          logger.info("skipping_duplicate_event", {
            eventId: normalizedEvent.id,
            txHash: normalizedEvent.txHash,
          });
          cursor = normalizedEvent.pagingToken;
          continue;
        }

        try {
          await handler(normalizedEvent);
        } catch (err) {
          logger.error("handler_error", {
            eventId: normalizedEvent.id,
            eventType: normalizedEvent.type,
            err,
          });
        }

        markSeen(normalizedEvent.id);
        cursor = normalizedEvent.pagingToken;
      }

      if (events.length === MAX_EVENTS_PER_PAGE) {
        continue;
      }

      startLedger = latestLedger;
    } catch (err) {
      logger.error("Error fetching events:", err);
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
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

  // BA-038: Reject invalid replay ranges before issuing any RPC requests.
  // The range is inclusive on both ends ([startLedger, endLedger]).
  if (!Number.isInteger(config.startLedger) || config.startLedger < 0) {
    throw new Error(
      `Invalid replay start ledger: ${config.startLedger}. Must be a non-negative integer.`
    );
  }
  if (!Number.isInteger(config.endLedger) || config.endLedger < 0) {
    throw new Error(
      `Invalid replay end ledger: ${config.endLedger}. Must be a non-negative integer.`
    );
  }
  if (config.startLedger > config.endLedger) {
    throw new Error(
      `Invalid replay range: start (${config.startLedger}) exceeds end (${config.endLedger}). ` +
        `The range is inclusive on both ends, so start must be <= end.`
    );
  }

  logger.info("replay_start", {
    startLedger: config.startLedger,
    endLedger: config.endLedger,
    contractId: config.contractId,
    eventTypes: config.eventTypeFilter?.join(",") ?? "all",
  });

  for (let ledger = config.startLedger; ledger <= config.endLedger && !signal.aborted; ledger++) {
    let hasMore = true;
    cursor = undefined;

    while (hasMore && !signal.aborted) {
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
            logger.error("replay_handler_error", { eventId: normalized.id, err });
          }

          cursor = normalized.pagingToken;
        }

        hasMore = events.length === batchSize;
      } catch (err) {
        logger.error("replay_fetch_error", { ledger, err });
        hasMore = false;
      }
    }
  }

  logger.info("replay_completed", { totalDispatched });
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
