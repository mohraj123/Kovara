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
 */
export async function streamEvents(
  config: StreamConfig,
  handler: EventHandler,
  signal: AbortSignal
): Promise<void> {
  const pollMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let cursor: string | undefined;
  let startLedger = config.startLedger;

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
        if (!validateEventPayload(event)) {
          console.error("[stream] Skipping invalid event payload:", JSON.stringify(event));
          cursor = event.pagingToken;
          continue;
        }
        try {
          await handler(event);
        } catch (err) {
          console.error(
            `[stream] Handler error for event ${event.id} (type=${event.type}):`,
            err
          );
        }
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
