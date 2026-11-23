import {
  decodeStellarBase64,
  isStellarAddress,
  NormalizationError,
  normalizeStellarEvent,
  normalizeStellarEvents,
  resolveStatus,
  stroopsToUnits,
} from "../stellar-normalize";

// Stellar strkeys are 56 characters: a leading G plus 55 base-32 characters.
// Built by repetition rather than pasted, because a hand-written key that is one
// character short fails the validator and makes every test using it lie.
const ADDRESS_A = `G${"A".repeat(55)}`;
const ADDRESS_B = `G${"B".repeat(55)}`;

/** Base64-encode a string using Stellar's URL-safe, unpadded alphabet. */
function encode(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("decodeStellarBase64", () => {
  it("decodes the URL-safe alphabet", () => {
    // 0xFB 0xFF encodes to "+/8" in standard base64 and "-_8" in Stellar's.
    expect(decodeStellarBase64("-_8")).toBe(Buffer.from([0xfb, 0xff]).toString("utf-8"));
  });

  it("restores stripped padding", () => {
    // "ab" is 2 bytes -> 3 base64 chars, no padding needed.
    expect(decodeStellarBase64(encode("ab"))).toBe("ab");
    // "a" is 1 byte -> 2 chars + "==" padding, which Stellar omits.
    expect(decodeStellarBase64(encode("a"))).toBe("a");
  });

  it("rejects a length no base64 string can have", () => {
    expect(() => decodeStellarBase64("A")).toThrow(NormalizationError);
  });
});

describe("stroopsToUnits", () => {
  it("converts without going through a float", () => {
    // 90_000_000 XLM is 9e14 stroops, well past Number.MAX_SAFE_INTEGER.
    // A float round-trip would return 89999999.99999999 or similar.
    expect(stroopsToUnits(BigInt("900000000000000"))).toBe("90000000");
  });

  it("keeps sub-unit precision", () => {
    expect(stroopsToUnits(BigInt("1"))).toBe("0.0000001");
    expect(stroopsToUnits(BigInt("10000000"))).toBe("1");
    expect(stroopsToUnits(BigInt("12345678"))).toBe("1.2345678");
  });

  it("handles zero and negatives", () => {
    expect(stroopsToUnits(BigInt(0))).toBe("0");
    expect(stroopsToUnits(BigInt("-25000000"))).toBe("-2.5");
  });
});

describe("isStellarAddress", () => {
  it("accepts a 56-character G-prefixed key", () => {
    expect(isStellarAddress(ADDRESS_A)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isStellarAddress("GABC")).toBe(false);
    expect(isStellarAddress("S" + ADDRESS_A.slice(1))).toBe(false);
    expect(isStellarAddress(undefined)).toBe(false);
    expect(isStellarAddress(42)).toBe(false);
  });
});

describe("resolveStatus", () => {
  it("defaults to success when the source reports nothing", () => {
    expect(resolveStatus({})).toBe("success");
  });

  it("reads an explicit status", () => {
    expect(resolveStatus({ status: "failed" })).toBe("failed");
    expect(resolveStatus({ status: "SUCCESS" })).toBe("success");
  });

  it("infers failure from errorResult", () => {
    expect(resolveStatus({ errorResult: "tx_failed" })).toBe("failed");
  });
});

describe("normalizeStellarEvent", () => {
  it("maps the key fields the handlers rely on", () => {
    const normalized = normalizeStellarEvent({
      id: "0001-0002",
      type: "contract",
      ledger: 12345,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      contractId: ADDRESS_A,
      pagingToken: "12884905921-3",
      topic: [encode("post_created"), encode(ADDRESS_B)],
      value: encode("5000000"),
      txHash: "abc123",
    });

    expect(normalized.eventId).toBe("0001-0002");
    expect(normalized.type).toBe("post_created");
    expect(normalized.ledger).toBe(12345);
    expect(normalized.account).toBe(ADDRESS_B);
    expect(normalized.status).toBe("success");
    expect(normalized.decodedValue).toBe("5000000");
    // Amounts stay exact: a float here would round anything above 2^53.
    expect(normalized.amountStroops).toBe(BigInt("5000000"));
  });

  it("accepts a numeric ledger delivered as a string", () => {
    const normalized = normalizeStellarEvent({ id: "e1", ledger: "777" });
    expect(normalized.ledger).toBe(777);
  });

  it("marks a failed transaction rather than indexing rolled-back effects", () => {
    const normalized = normalizeStellarEvent({ id: "e1", ledger: 1, status: "failed" });
    expect(normalized.status).toBe("failed");
  });

  it("leaves amountStroops null for a non-numeric payload", () => {
    const normalized = normalizeStellarEvent({ id: "e1", ledger: 1, value: encode("hello") });
    expect(normalized.amountStroops).toBeNull();
  });

  it("survives an undecodable topic instead of losing the event", () => {
    const normalized = normalizeStellarEvent({
      id: "e1",
      ledger: 1,
      topic: [encode("post_created"), "!!!"],
    });

    expect(normalized.type).toBe("post_created");
    expect(normalized.topics[1]).toBe("");
  });

  it("reports no account when no topic looks like an address", () => {
    const normalized = normalizeStellarEvent({ id: "e1", ledger: 1, topic: [encode("like")] });
    expect(normalized.account).toBeNull();
  });

  it("rejects a payload with no identity", () => {
    expect(() => normalizeStellarEvent({ ledger: 1 })).toThrow(NormalizationError);
    expect(() => normalizeStellarEvent(null)).toThrow(NormalizationError);
    expect(() => normalizeStellarEvent("nope")).toThrow(NormalizationError);
  });

  it("rejects a negative or fractional ledger", () => {
    expect(() => normalizeStellarEvent({ id: "e1", ledger: -1 })).toThrow(NormalizationError);
    expect(() => normalizeStellarEvent({ id: "e1", ledger: 1.5 })).toThrow(NormalizationError);
  });
});

describe("normalizeStellarEvents", () => {
  it("drops only the unusable entries", () => {
    const normalized = normalizeStellarEvents([
      { id: "good-1", ledger: 1 },
      { ledger: 2 },
      null,
      { id: "good-2", ledger: 3 },
    ]);

    expect(normalized.map((e) => e.eventId)).toEqual(["good-1", "good-2"]);
  });

  it("returns an empty list for an empty batch", () => {
    expect(normalizeStellarEvents([])).toEqual([]);
  });
});
