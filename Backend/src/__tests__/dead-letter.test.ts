import {
  DeadLetterQueue,
  DeadLetterRecord,
  DeadLetterStore,
} from "../dead-letter";

/** In-memory store capturing everything the queue records. */
class FakeDeadLetterStore implements DeadLetterStore {
  readonly rows = new Map<string, DeadLetterRecord>();
  requeued: string[] = [];

  async record(entry: Omit<DeadLetterRecord, "deadLetteredAt" | "requeuedAt">): Promise<void> {
    this.rows.set(entry.idempotencyKey, {
      ...entry,
      deadLetteredAt: new Date("2026-01-01T00:00:00.000Z"),
      requeuedAt: null,
    });
  }

  async list(limit: number, offset: number) {
    const all = [...this.rows.values()].filter((r) => r.requeuedAt === null);
    return { entries: all.slice(offset, offset + limit), total: all.length };
  }

  provenance: unknown[] = [];

  async requeue(idempotencyKey: string, provenance?: unknown): Promise<boolean> {
    this.provenance.push(provenance);
    const row = this.rows.get(idempotencyKey);
    if (!row || row.requeuedAt !== null) return false;
    row.requeuedAt = new Date("2026-01-02T00:00:00.000Z");
    this.requeued.push(idempotencyKey);
    return true;
  }

  async countPending(): Promise<number> {
    return [...this.rows.values()].filter((r) => r.requeuedAt === null).length;
  }
}

const CONTEXT = {
  eventId: "evt-1",
  contractId: "contract-1",
  txHash: "tx-1",
  ledger: 100,
  topic: ["post_created", "GABC"],
  value: '{"some":"payload"}',
  error: "boom",
};

describe("DeadLetterQueue", () => {
  it("does not dead-letter a transient failure inside the retry budget", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 3);

    expect(await queue.fail("key-1", CONTEXT)).toBeNull();
    expect(await queue.fail("key-1", CONTEXT)).toBeNull();
    expect(await store.countPending()).toBe(0);
  });

  it("dead-letters once the retry budget is exhausted", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 3);

    await queue.fail("key-1", CONTEXT);
    await queue.fail("key-1", CONTEXT);
    const reason = await queue.fail("key-1", CONTEXT);

    expect(reason).toBe("retries_exhausted");
    expect(await store.countPending()).toBe(1);
    expect(queue.attemptsFor("key-1")).toBe(3);
  });

  it("dead-letters a permanent failure immediately", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 3);

    // One attempt, not three: a permanent failure cannot be fixed by retrying.
    const reason = await queue.fail("key-1", CONTEXT, "permanent_failure");
    expect(reason).toBe("permanent_failure");
    expect(await store.countPending()).toBe(1);
  });

  it("dead-letters invalid payloads and wrong-contract events immediately", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 3);

    expect(await queue.fail("key-a", CONTEXT, "invalid_payload")).toBe("invalid_payload");
    expect(await queue.fail("key-b", CONTEXT, "wrong_contract")).toBe("wrong_contract");
    expect(await store.countPending()).toBe(2);
  });

  it("keeps enough context to debug the failure", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 1);

    await queue.fail("key-1", CONTEXT, "permanent_failure");
    const { entries } = await store.list(10, 0);
    const record = entries[0];

    expect(record.eventId).toBe("evt-1");
    expect(record.txHash).toBe("tx-1");
    expect(record.ledger).toBe(100);
    expect(record.eventType).toBe("post_created");
    expect(record.topic).toEqual(["post_created", "GABC"]);
    // The raw payload is retained: a redacted queue cannot be debugged from.
    expect(record.value).toBe('{"some":"payload"}');
    expect(record.error).toBe("boom");
  });

  it("tracks attempts per key independently", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 2);

    await queue.fail("key-1", CONTEXT);
    expect(queue.attemptsFor("key-1")).toBe(1);
    expect(queue.attemptsFor("key-2")).toBe(0);

    await queue.fail("key-2", CONTEXT);
    expect(queue.attemptsFor("key-2")).toBe(1);
    expect(await store.countPending()).toBe(0);
  });

  it("clears the attempt budget after a success", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 2);

    await queue.fail("key-1", CONTEXT);
    expect(queue.attemptsFor("key-1")).toBe(1);

    queue.reset("key-1");
    expect(queue.attemptsFor("key-1")).toBe(0);
  });

  it("reports shouldDeadLetter before the failing attempt", async () => {
    const queue = new DeadLetterQueue(new FakeDeadLetterStore(), 3);
    expect(queue.shouldDeadLetter(2)).toBe(false);
    expect(queue.shouldDeadLetter(3)).toBe(true);
    expect(queue.shouldDeadLetter(4)).toBe(true);
  });

  it("requeues a dead letter and grants a fresh budget", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 1);

    await queue.fail("key-1", CONTEXT, "permanent_failure");
    expect(queue.attemptsFor("key-1")).toBe(1);

    await expect(queue.requeue("key-1")).resolves.toBe(true);
    expect(await store.countPending()).toBe(0);
    // The operator asked for a fresh set of attempts, not a continuation.
    expect(queue.attemptsFor("key-1")).toBe(0);
  });

  it("does not requeue an unknown or already-requeued key", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 1);

    await expect(queue.requeue("missing")).resolves.toBe(false);
    await queue.fail("key-1", CONTEXT, "permanent_failure");
    await expect(queue.requeue("key-1")).resolves.toBe(true);
    await expect(queue.requeue("key-1")).resolves.toBe(false);
  });

  it("records provenance for every requeue request, including repeats", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 1);
    await queue.fail("key-1", CONTEXT, "permanent_failure");

    await queue.requeue("key-1", { requestedBy: "op-1", reason: "fixed", source: "cli" });
    await queue.requeue("key-1", { requestedBy: "op-2", reason: "again", source: "api" });

    const history = queue.requeueHistory("key-1");
    expect(history.map((h) => h.requestedBy)).toEqual(["op-1", "op-2"]);
    expect(history[0].requestedAt).toBeInstanceOf(Date);
    expect(store.provenance[0]).toMatchObject({ requestedBy: "op-1", reason: "fixed", source: "cli" });
  });

  it("pages dead letters with a bounded limit and cursor", async () => {
    const store = new FakeDeadLetterStore();
    const queue = new DeadLetterQueue(store, 1);
    for (const k of ["a", "b", "c"]) await queue.fail(k, CONTEXT, "permanent_failure");

    const first = await queue.listPage(2);
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = await queue.listPage(2, first.nextCursor!);
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    await expect(queue.listPage(0)).rejects.toThrow(RangeError);
    await expect(queue.listPage(201)).rejects.toThrow(RangeError);
    await expect(queue.listPage(10, "-1")).rejects.toThrow(RangeError);
  });
});
