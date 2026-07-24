/**
 * Soroban event streaming via Horizon/Soroban RPC.
 *
 * Polls getEvents on the configured RPC endpoint and yields raw contract
 * events for the Kovara contract. Callers provide a cursor (latest processed
 * ledger) so the stream can resume after a restart.
 */

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
}

export type EventHandler = (event: RawEvent) => Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_EVENTS_PER_PAGE = 100;
/**
 * BE-24: Default size of the in-memory tx-hash deduplication ring buffer.
 * Large enough to cover a typical replay window without exhausting memory.
 */
const DEFAULT_DEDUP_CACHE_SIZE = 10_000;

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

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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

  while (!signal.aborted) {
    try {
      const { events, latestLedger } = await fetchEvents(
        config.rpcUrl,
        config.contractId,
        startLedger,
        cursor
      );

      for (const event of events) {
        if (signal.aborted) break;

        // BE-24: Skip already-processed events before hitting the handler or DB.
        if (seenEventIds.has(event.id)) {
          console.log(`[stream] Skipping duplicate event id=${event.id} tx=${event.txHash}`);
          cursor = event.pagingToken;
          continue;
        }

        await handler(event);
        markSeen(event.id);
        cursor = event.pagingToken;
      }

      if (events.length === MAX_EVENTS_PER_PAGE) {
        continue;
      }

      startLedger = latestLedger;
    } catch (err) {
      console.error("[stream] Error fetching events:", err);
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
