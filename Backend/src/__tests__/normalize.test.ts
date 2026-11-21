import {
  normalizeAddress,
  normalizeAmount,
  normalizeLedger,
  normalizeEvent,
  validateTopicValue,
  normalizeRawEvent,
  normalizeTimestamp,
} from "../normalize";

const ADDRESS = `G${"A".repeat(55)}`;

describe("price and event normalization (#667)", () => {
  it("trims, validates, and preserves valid Stellar addresses", () => {
    expect(normalizeAddress(` ${ADDRESS} `)).toBe(ADDRESS);
    expect(() => normalizeAddress(" ")).toThrow(/empty/);
    expect(() => normalizeAddress("G123")).toThrow(/56 characters/);
    expect(() => normalizeAddress(`S${"A".repeat(55)}`)).toThrow(/valid Stellar public key/);
    expect(() => normalizeAddress(`G${"0".repeat(55)}`)).toThrow(/valid Stellar public key/);
  });

  it("normalizes integer prices without losing large integer precision", () => {
    expect(normalizeAmount(" +000900719925474099312345 ")).toBe("900719925474099312345");
    expect(normalizeAmount(-12.9)).toBe("-12");
    expect(normalizeAmount(12n)).toBe("12");
    for (const invalid of ["", "1.2", "NaN", "Infinity"]) {
      expect(() => normalizeAmount(invalid)).toThrow();
    }
    expect(() => normalizeAmount(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("accepts positive integer ledgers only", () => {
    expect(normalizeLedger(1)).toBe(1);
    for (const invalid of [0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeLedger(invalid)).toThrow(/positive integer/);
    }
  });

  it("applies only requested fields and returns a fresh deterministic object", () => {
    const event = { address: ` ${ADDRESS} `, amount: "+0008", untouched: " x " };
    const schema = {
      address: (value: unknown) => normalizeAddress(value as string),
      amount: (value: unknown) => normalizeAmount(value as string | number | bigint),
    };
    const normalized = normalizeEvent(event, schema);
    expect(normalized).toEqual({ address: ADDRESS, amount: "8", untouched: " x " });
    expect(event.address).toBe(` ${ADDRESS} `);
    expect(normalizeEvent(event, schema)).toEqual(normalized);
  });
});

/**
 * Canonical address representation (BE-08).
 *
 * A Stellar strkey is base-32 over `A–Z` and `2–7`, so upper-case is the
 * canonical encoding. Folding case means a profile created from `gabc…` is
 * found again by a lookup for `GABC…` instead of silently producing a second
 * A Stellar strkey is base-32 over `A�Z` and `2�7`, so upper-case is the
 * canonical encoding. Folding case means a profile created from `gabc�` is
 * found again by a lookup for `GABC�` instead of silently producing a second
 * row for the same account.
 */
describe("address casing normalization (BE-08)", () => {
  it("returns the same canonical string for every casing of one account", () => {
    const lower = ADDRESS.toLowerCase();
    const mixed = `g${ADDRESS.slice(1, 30).toLowerCase()}${ADDRESS.slice(30)}`;

    expect(normalizeAddress(ADDRESS)).toBe(ADDRESS);
    expect(normalizeAddress(lower)).toBe(ADDRESS);
    expect(normalizeAddress(mixed)).toBe(ADDRESS);
    expect(normalizeAddress(` ${lower} `)).toBe(ADDRESS);
  });

  it("is idempotent, so a second normalization changes nothing", () => {
    const once = normalizeAddress(ADDRESS.toLowerCase());
    expect(normalizeAddress(once)).toBe(once);
  });

  it("still rejects characters outside the strkey alphabet after folding", () => {
    // Case-insensitivity must not weaken the alphabet check: `0`/`1`/`8`/`9`
    // are not strkey characters in either case.
    expect(() => normalizeAddress(`G${"0".repeat(55)}`)).toThrow(/valid Stellar public key/);
    expect(() => normalizeAddress(`g${"0".repeat(55)}`)).toThrow(/valid Stellar public key/);
    expect(() => normalizeAddress(`g${"1".repeat(55)}`)).toThrow(/valid Stellar public key/);
  });

  it("still rejects a non-G prefix in lower case", () => {
    expect(() => normalizeAddress(`s${"a".repeat(55)}`)).toThrow(/valid Stellar public key/);
  });

  it("reports the length error before the alphabet error for a short value", () => {
    expect(() => normalizeAddress("gabc")).toThrow(/56 characters/);
  });

  it("normalizes the address inside a normalized event", () => {
    const event = { user: ADDRESS.toLowerCase(), untouched: ADDRESS.toLowerCase() };
    const normalized = normalizeEvent(event, { user: (value: unknown) => normalizeAddress(value as string) });
    expect(normalized).toEqual({ user: ADDRESS, untouched: ADDRESS.toLowerCase() });
  });
});

describe("topic/value pairing", () => {
  it("accepts JSON or integer values for known topics and ignores unknown topics", () => {
    expect(() => validateTopicValue("like", "42")).not.toThrow();
    expect(() => validateTopicValue("tip", '{"amount":"5"}')).not.toThrow();
    expect(() => validateTopicValue("mystery", "")).not.toThrow();
  });

  it("rejects empty and malformed JSON values for known topics", () => {
    expect(() => validateTopicValue("like", "  ")).toThrow(/empty value/);
    expect(() => validateTopicValue("tip", "{bad")).toThrow(/malformed JSON/);
  });
});
describe("timestamp normalization (#1030)", () => {
  const expectedMs = Date.parse("2026-01-02T03:04:05.000Z");

  it("converts every supported representation to the same millisecond value", () => {
    expect(normalizeTimestamp(new Date(expectedMs))).toBe(expectedMs);
    expect(normalizeTimestamp(expectedMs)).toBe(expectedMs);
    expect(normalizeTimestamp(String(expectedMs))).toBe(expectedMs);
    expect(normalizeTimestamp(String(Math.floor(expectedMs / 1000)))).toBe(expectedMs);
    expect(normalizeTimestamp("2026-01-02T03:04:05Z")).toBe(expectedMs);
    expect(normalizeTimestamp(" 2026-01-02T03:04:05.000Z ")).toBe(expectedMs);
  });

  it("keeps sub-second precision from ISO strings", () => {
    expect(normalizeTimestamp("2026-01-02T03:04:05.123Z")).toBe(
      Date.parse("2026-01-02T03:04:05.123Z")
    );
  });

  it("rejects ambiguous or unsupported timestamp formats", () => {
    for (const invalid of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "123",
      "12345678901234",
      "1.2",
      "2026-01-02T03:04:05",
      "yesterday",
      "2026-13-40T03:04:05Z",
    ]) {
      expect(() => normalizeTimestamp(invalid as never)).toThrow();
    }
    expect(() => normalizeTimestamp({} as never)).toThrow(/number, string, or Date/);
  });

  it("validates ledger close times through the shared parser", () => {
    const event = {
      type: "post_created",
      ledger: 7,
      ledgerClosedAt: "2026-01-01T00:00:07Z",
      contractId: ADDRESS,
      id: "e1",
      pagingToken: "7-0",
      topic: ["post_created"],
      value: "",
      txHash: "tx-7",
    };

    expect(normalizeRawEvent(event).ledgerClosedAt).toBe(event.ledgerClosedAt);
    expect(() =>
      normalizeRawEvent({ ...event, ledgerClosedAt: "2026-01-01 00:00:07" })
    ).toThrow(/unsupported timestamp format/);
  });
});
