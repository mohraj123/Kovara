import {
  buildIdempotencyKey,
  deriveEventId,
  IDEMPOTENCY_KEY_PREFIX,
  IDEMPOTENCY_KEY_VERSION,
  isSameEvent,
  isValidIdempotencyKey,
  parseIdempotencyKey,
  runOnce,
  IdempotencyLookup,
  IdempotencyStore,
} from "../idempotency";

const CONTRACT = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const OTHER_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const EVENT_ID = "0000000000-0000-0000-0000-00000000abcd";

describe("buildIdempotencyKey", () => {
  it("is deterministic for the same event", () => {
    const a = buildIdempotencyKey(CONTRACT, 100, EVENT_ID);
    const b = buildIdempotencyKey(CONTRACT, 100, EVENT_ID);
    expect(a).toBe(b);
  });

  it("distinguishes events that differ in any component", () => {
    const base = buildIdempotencyKey(CONTRACT, 100, EVENT_ID);
    expect(buildIdempotencyKey(OTHER_CONTRACT, 100, EVENT_ID)).not.toBe(base);
    expect(buildIdempotencyKey(CONTRACT, 101, EVENT_ID)).not.toBe(base);
    expect(buildIdempotencyKey(CONTRACT, 100, `${EVENT_ID}e`)).not.toBe(base);
  });

  it("is namespaced and versioned", () => {
    const key = buildIdempotencyKey(CONTRACT, 100, EVENT_ID);
    expect(key.startsWith(`${IDEMPOTENCY_KEY_PREFIX}:${IDEMPOTENCY_KEY_VERSION}:`)).toBe(true);
  });
});

describe("isValidIdempotencyKey", () => {
  it("rejects values that would silently collide or match nothing", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("   ")).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey(42)).toBe(false);
    expect(isValidIdempotencyKey({})).toBe(false);
    // A control character is invisible in a log line and in psql output, which
    // makes a poisoned key very hard to spot after the fact.
    expect(isValidIdempotencyKey("kovara:event:v1:\u0000abc")).toBe(false);
    expect(isValidIdempotencyKey("kovara:event:v1\nabc")).toBe(false);
    expect(isValidIdempotencyKey("kovara:event:v1\u0007abc")).toBe(false);
  });

  it("rejects an unbounded key so the unique index cannot be abused", () => {
    expect(isValidIdempotencyKey("k".repeat(257))).toBe(false);
    expect(isValidIdempotencyKey("k".repeat(256))).toBe(true);
  });

  it("accepts a bare event id and a derived key", () => {
    expect(isValidIdempotencyKey(EVENT_ID)).toBe(true);
    expect(isValidIdempotencyKey(buildIdempotencyKey(CONTRACT, 1, EVENT_ID))).toBe(true);
  });
});

describe("parseIdempotencyKey", () => {
  it("round-trips a derived key", () => {
    const key = buildIdempotencyKey(CONTRACT, 4242, EVENT_ID);
    const parsed = parseIdempotencyKey(key);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      version: IDEMPOTENCY_KEY_VERSION,
      contractId: CONTRACT,
      ledger: 4242,
      eventId: EVENT_ID,
    });
  });

  it("returns null for shapes it cannot trust", () => {
    expect(parseIdempotencyKey(EVENT_ID)).toBeNull();
    expect(parseIdempotencyKey("other:v1:a:1:b")).toBeNull();
    expect(parseIdempotencyKey(`${IDEMPOTENCY_KEY_PREFIX}:v9:${CONTRACT}:1:${EVENT_ID}`)).toBeNull();
    expect(parseIdempotencyKey(`${IDEMPOTENCY_KEY_PREFIX}:${IDEMPOTENCY_KEY_VERSION}::1:x`)).toBeNull();
    expect(parseIdempotencyKey(`${IDEMPOTENCY_KEY_PREFIX}:${IDEMPOTENCY_KEY_VERSION}:${CONTRACT}:abc:x`)).toBeNull();
    expect(parseIdempotencyKey(`${IDEMPOTENCY_KEY_PREFIX}:${IDEMPOTENCY_KEY_VERSION}:${CONTRACT}:-1:x`)).toBeNull();
    expect(parseIdempotencyKey(`${IDEMPOTENCY_KEY_PREFIX}:${IDEMPOTENCY_KEY_VERSION}:${CONTRACT}:1:`)).toBeNull();
  });
});

describe("isSameEvent", () => {
  it("compares equal strings and matching derived keys", () => {
    expect(isSameEvent("abc", "abc")).toBe(true);
    expect(isSameEvent(buildIdempotencyKey(CONTRACT, 1, EVENT_ID), buildIdempotencyKey(CONTRACT, 1, EVENT_ID))).toBe(true);
    expect(isSameEvent(buildIdempotencyKey(CONTRACT, 1, EVENT_ID), buildIdempotencyKey(CONTRACT, 2, EVENT_ID))).toBe(false);
    expect(isSameEvent("one", "two")).toBe(false);
  });
});

/** In-memory store mirroring the Postgres implementation's claim semantics. */
class FakeStore implements IdempotencyStore {
  readonly rows = new Map<string, { status: string; error: string | null; attempts: number }>();
  claimCalls = 0;

  constructor(private readonly claimable = true) {}

  async claim(key: string): Promise<boolean> {
    this.claimCalls += 1;
    if (!this.claimable) return false;
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, { status: "claimed", error: null, attempts: 0 });
      return true;
    }
    if (existing.status === "processed") return false;
    existing.status = "claimed";
    existing.attempts += 1;
    return true;
  }

  async lookup(key: string): Promise<IdempotencyLookup> {
    const row = this.rows.get(key);
    if (!row) return { status: "new" };
    if (row.status === "processed") return { status: "processed", processedAt: new Date(0) };
    if (row.status === "failed") {
      return { status: "failed", error: row.error, attempts: row.attempts };
    }
    return { status: "new" };
  }

  async markProcessed(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) row.status = "processed";
  }

  async markFailed(key: string, error: string): Promise<void> {
    this.rows.set(key, { status: "failed", error, attempts: 1 });
  }
}

describe("runOnce", () => {
  const KEY = buildIdempotencyKey(CONTRACT, 7, EVENT_ID);

  it("applies the work on the first call", async () => {
    const store = new FakeStore();
    const work = jest.fn().mockResolvedValue(undefined);

    await expect(runOnce(store, KEY, work)).resolves.toEqual({ status: "applied" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a completed key, and reports the previous outcome", async () => {
    const store = new FakeStore();
    const work = jest.fn().mockResolvedValue(undefined);

    await runOnce(store, KEY, work);
    await expect(runOnce(store, KEY, work)).resolves.toMatchObject({ status: "duplicate" });

    // The second call must not re-run the work — this is the whole point.
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("allows a previously failed key to run again", async () => {
    const store = new FakeStore();
    const failing = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(runOnce(store, KEY, failing)).rejects.toThrow("boom");

    const succeeding = jest.fn().mockResolvedValue(undefined);
    await expect(runOnce(store, KEY, succeeding)).resolves.toEqual({ status: "applied" });
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("marks the key failed and rethrows when the work throws", async () => {
    const store = new FakeStore();
    const work = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(runOnce(store, KEY, work)).rejects.toThrow("boom");
    await expect(store.lookup(KEY)).resolves.toMatchObject({
      status: "failed",
      error: "boom",
    });
  });

  it("does not run the work when the claim is lost to a concurrent worker", async () => {
    // Two replicas racing on the same key: one claims, the other must stand down.
    const store = new FakeStore(false);
    const work = jest.fn().mockResolvedValue(undefined);

    await expect(runOnce(store, KEY, work)).resolves.toMatchObject({ status: "duplicate" });
    expect(work).not.toHaveBeenCalled();
  });

  it("rejects an invalid key before touching the store", async () => {
    const store = new FakeStore();
    const work = jest.fn();

    await expect(runOnce(store, "", work)).rejects.toThrow(/Invalid idempotency key/);
    expect(store.claimCalls).toBe(0);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("deriveEventId", () => {
  const fields = { ledger: 100, txHash: "abc123", topic: ["tip"], value: "AAAA" };

  it("is stable and distinguishes differing fields", () => {
    expect(deriveEventId(fields)).toBe(deriveEventId({ ...fields }));
    expect(deriveEventId({ ...fields, value: "BBBB" })).not.toBe(deriveEventId(fields));
    expect(deriveEventId({ ...fields, ledger: 101 })).not.toBe(deriveEventId(fields));
  });

  it("rejects incomplete identity data", () => {
    expect(() => deriveEventId({ ...fields, txHash: "" })).toThrow(/txHash/);
    expect(() => deriveEventId({ ...fields, ledger: -1 })).toThrow(/ledger/);
  });
});
