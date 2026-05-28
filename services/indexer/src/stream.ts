export interface StreamCursorState {
  cursor: string;
}

export interface SorobanEvent {
  id: string;
  type: string;
  ledger: number;
  txHash: string;
  contractId: string;
  topic: unknown;
  value: unknown;
  raw: unknown;
}

export interface EventStreamOptions {
  rpcUrl: string;
  contractAddress: string;
  startCursor?: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onEvent: (event: SorobanEvent) => Promise<void>;
  onCursor?: (state: StreamCursorState) => Promise<void> | void;
}

interface HorizonEventResponse {
  _embedded?: {
    records?: Array<Record<string, unknown>>;
  };
}

function normalizeEvent(record: Record<string, unknown>): SorobanEvent {
  const topic = record.topic ?? null;
  const value = record.value ?? null;

  return {
    id: String(record.id),
    type:
      typeof record.type === "string" && record.type.length > 0
        ? record.type
        : Array.isArray(topic) && topic.length > 0
          ? String(topic[0])
          : "unknown",
    ledger: Number(record.ledger ?? 0),
    txHash: String(record.tx_hash ?? ""),
    contractId: String(record.contract_id ?? ""),
    topic,
    value,
    raw: record,
  };
}

export async function streamSorobanEvents(options: EventStreamOptions): Promise<void> {
  const interval = options.pollIntervalMs ?? 3_000;
  let cursor = options.startCursor ?? "now";

  while (!options.signal?.aborted) {
    const base = new URL("/events", options.rpcUrl);
    base.searchParams.set("contract_ids", options.contractAddress);
    base.searchParams.set("cursor", cursor);
    base.searchParams.set("limit", "200");
    base.searchParams.set("order", "asc");

    const response = await fetch(base, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`Failed to stream Soroban events: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as HorizonEventResponse;
    const records = payload._embedded?.records ?? [];

    for (const record of records) {
      const event = normalizeEvent(record);
      if (event.contractId.toLowerCase() !== options.contractAddress.toLowerCase()) {
        continue;
      }
      await options.onEvent(event);
      cursor = event.id;
      await options.onCursor?.({ cursor });
    }

    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
}
