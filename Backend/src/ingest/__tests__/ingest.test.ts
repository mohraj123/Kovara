import {
  InjectedLedgerSource,
  LedgerIngestor,
  SeenEventIds,
  planLedgerWindows,
  toDomainEvent,
} from "../ingest";
import type { NormalizedStellarEvent } from "../stellar-normalize";

const ADDRESS = `G${"A".repeat(55)}`;

function encode(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A raw payload shaped like the Soroban RPC returns it. */
function payload(
  id: string,
  ledger: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    ledger,
    ledgerClosedAt: `2026-01-01T00:00:${String(ledger % 60).padStart(2, "0")}Z`,
    contractId: ADDRESS,
    pagingToken: `${ledger}-0`,
    topic: [encode("post_created"), encode(ADDRESS)],
    value: encode("10000000"),
    txHash: `tx-${ledger}`,
    ...extra,
  };
}

/** An ingestor whose source always returns `payloads`. */
function ingestorWith(payloads: unknown[]): LedgerIngestor {
  return new LedgerIngestor(
    new InjectedLedgerSource("test", async () => payloads)
  );
}

describe("SeenEventIds", () => {
  it("reports the first sighting and rejects the second", () => {
    const seen = new SeenEventIds(10);
    expect(seen.add("a")).toBe(true);
    expect(seen.add("a")).toBe(false);
    expect(seen.has("a")).toBe(true);
  });

  it("evicts the oldest id once full, so a long run cannot leak", () => {
    const seen = new SeenEventIds(3);
    seen.add("a");
    seen.add("b");
    seen.add("c");
    seen.add("d");

    expect(seen.size).toBe(3);
    // 'a' was the oldest insertion and is the one dropped.
    expect(seen.has("a")).toBe(false);
    expect(seen.has("d")).toBe(true);
  });
});

describe("LedgerIngestor.ingestRange", () => {
  it("accepts events and maps them to domain events", async () => {
    const ingestor = ingestorWith([payload("e1", 100), payload("e2", 101)]);
    const result = await ingestor.ingestRange({ startLedger: 100, endLedger: 101 });

    expect(result.accepted).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
    expect(result.accepted[0].type).toBe("post_created");
    expect(result.accepted[0].account).toBe(ADDRESS);
    expect(result.accepted[0].amountStroops).toBe(BigInt("10000000"));
  });

  it("is idempotent across a replay of the same range", async () => {
    const ingestor = ingestorWith([payload("e1", 100), payload("e2", 101)]);
    const range = { startLedger: 100, endLedger: 101 };

    const first = await ingestor.ingestRange(range);
    const second = await ingestor.ingestRange(range);

    expect(first.accepted).toHaveLength(2);
    expect(second.accepted).toHaveLength(0);
    // The duplicates are reported rather than silently dropped, so a caller can
    // tell "nothing new" apart from "source returned nothing".
    expect(second.duplicates).toHaveLength(2);
    expect(second.duplicates.map((e) => e.eventId)).toEqual(["e1", "e2"]);
  });

  it("replays domain events without duplicating indexed state (#668)", async () => {
    const ingestor = ingestorWith([payload("same-event", 225)]);
    const indexed = new Map<string, { type: string; ledger: number; actor: string | null }>();
    const range = { startLedger: 225, endLedger: 225 };

    for (let run = 0; run < 2; run += 1) {
      const replay = await ingestor.ingestRange(range);
      for (const event of replay.accepted) {
        indexed.set(event.eventId, { type: event.type, ledger: event.ledger, actor: event.account });
      }
    }

    expect(indexed.size).toBe(1);
    expect([...indexed.values()]).toEqual([{ type: "post_created", ledger: 225, actor: ADDRESS }]);
  });

  it("drops a failed transaction before it can be indexed", async () => {
    const ingestor = ingestorWith([
      payload("ok", 100),
      payload("rolled-back", 101, { status: "failed" }),
    ]);
    const result = await ingestor.ingestRange({ startLedger: 100, endLedger: 101 });

    expect(result.accepted.map((e) => e.eventId)).toEqual(["ok"]);
    expect(result.rejected.map((e) => e.eventId)).toEqual(["rolled-back"]);
  });

  it("keeps reporting a failed event as rejected on replay, not as a duplicate", async () => {
    // Dedup happens after the status check on purpose: a replayed failed event
    // should keep being reported as rejected, or an operator watching the
    // counts sees it silently migrate between two categories.
    const ingestor = ingestorWith([payload("rolled-back", 101, { status: "failed" })]);
    const range = { startLedger: 101, endLedger: 101 };

    const first = await ingestor.ingestRange(range);
    const second = await ingestor.ingestRange(range);

    expect(first.rejected).toHaveLength(1);
    expect(second.rejected).toHaveLength(1);
    expect(second.duplicates).toHaveLength(0);
  });

  it("counts malformed payloads without discarding the good ones", async () => {
    const ingestor = ingestorWith([payload("e1", 100), { ledger: 1 }, null, payload("e2", 102)]);
    const result = await ingestor.ingestRange({ startLedger: 100, endLedger: 102 });

    expect(result.accepted.map((e) => e.eventId)).toEqual(["e1", "e2"]);
    expect(result.malformed).toBe(2);
  });

  it("advances the cursor only as far as data was actually seen", async () => {
    // The source under-delivers: it returns ledger 100 only, for a range that
    // asked through 200. Advancing to 201 would skip 101-200 permanently.
    const ingestor = ingestorWith([payload("e1", 100)]);
    const result = await ingestor.ingestRange({ startLedger: 100, endLedger: 200 });

    expect(result.nextLedger).toBe(101);
  });

  it("does not rewind the cursor when a range is empty", async () => {
    const ingestor = ingestorWith([]);
    const result = await ingestor.ingestRange({ startLedger: 100, endLedger: 200 });

    expect(result.accepted).toEqual([]);
    expect(result.nextLedger).toBe(100);
  });

  it("rethrows a source failure so the retry layer can decide", async () => {
    const ingestor = new LedgerIngestor(
      new InjectedLedgerSource("flaky", async () => {
        throw new Error("connection refused");
      })
    );

    await expect(ingestor.ingestRange({ startLedger: 1, endLedger: 2 })).rejects.toThrow(
      "connection refused"
    );
  });

  it("tracks how many ids it has seen", async () => {
    const ingestor = ingestorWith([payload("e1", 1), payload("e2", 2)]);
    await ingestor.ingestRange({ startLedger: 1, endLedger: 2 });

    expect(ingestor.seenCount).toBe(2);
  });
});

describe("toDomainEvent", () => {
  const normalized: NormalizedStellarEvent = {
    eventId: "e1",
    type: "post_created",
    ledger: 7,
    ledgerClosedAt: "2026-01-01T00:00:07Z",
    contractId: ADDRESS,
    txHash: "tx-7",
    pagingToken: "7-0",
    status: "success",
    account: ADDRESS,
    topics: ["post_created", ADDRESS],
    decodedValue: "25000000",
    amountStroops: BigInt("25000000"),
  };

  it("renames the decoded fields to their internal names", () => {
    // `occurredAt` and `value` are the internal names; getting the mapping wrong
    // silently puts a ledger sequence number in a timestamp field.
    const event = toDomainEvent(normalized);

    expect(event.occurredAt).toBe("2026-01-01T00:00:07Z");
    expect(event.value).toBe("25000000");
    expect(event.type).toBe("post_created");
    expect(event.ledger).toBe(7);
  });

  it("carries the identity fields through unchanged", () => {
    // eventId is the idempotency key, so it must survive the mapping exactly.
    const event = toDomainEvent(normalized);

    expect(event.eventId).toBe("e1");
    expect(event.txHash).toBe("tx-7");
    expect(event.contractId).toBe(ADDRESS);
    expect(event.account).toBe(ADDRESS);
    expect(event.amountStroops).toBe(BigInt("25000000"));
    expect(event.status).toBe("success");
  });

  it("survives the round trip through the ingestor unchanged", async () => {
    const ingestor = ingestorWith([payload("e1", 7)]);
    const result = await ingestor.ingestRange({ startLedger: 7, endLedger: 7 });

    expect(result.accepted[0]).toMatchObject({ eventId: "e1", txHash: "tx-7", ledger: 7 });
  });
});

describe("planLedgerWindows", () => {
  it("splits a range into bounded windows", () => {
    expect(planLedgerWindows(1, 10, 4)).toEqual([
      { startLedger: 1, endLedger: 4 },
      { startLedger: 5, endLedger: 8 },
      { startLedger: 9, endLedger: 10 },
    ]);
  });

  it("returns one window when the range is smaller than the window", () => {
    expect(planLedgerWindows(5, 6, 100)).toEqual([{ startLedger: 5, endLedger: 6 }]);
  });

  it("returns nothing for an inverted range", () => {
    expect(planLedgerWindows(10, 5, 2)).toEqual([]);
  });

  it("rejects a zero-width window", () => {
    expect(() => planLedgerWindows(1, 10, 0)).toThrow(/windowSize/);
  });
});
