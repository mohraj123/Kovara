import { normalizeAddress, normalizeAmount, normalizeLedger, normalizeEvent } from "../normalize";

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
