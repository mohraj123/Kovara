import { toSafeBigInt } from "../db";

describe("toSafeBigInt (BA-028)", () => {
  it("returns native bigints as-is", () => {
    expect(toSafeBigInt(9007199254740993n)).toBe(9007199254740993n);
    expect(toSafeBigInt(-5n)).toBe(-5n);
    expect(toSafeBigInt(0n)).toBe(0n);
  });

  it("accepts safe integer numbers", () => {
    expect(toSafeBigInt(0)).toBe(0n);
    expect(toSafeBigInt(-42)).toBe(-42n);
    expect(toSafeBigInt(Number.MAX_SAFE_INTEGER)).toBe(9007199254740991n);
    expect(toSafeBigInt(Number.MIN_SAFE_INTEGER)).toBe(-9007199254740991n);
  });

  it("rejects unsafe numbers (beyond 2^53-1) instead of silently rounding", () => {
    expect(() => toSafeBigInt(Number.MAX_SAFE_INTEGER + 1)).toThrow(/Unsafe bigint/);
    expect(() => toSafeBigInt(1e20)).toThrow(/Unsafe bigint/);
    expect(() => toSafeBigInt(-1e20)).toThrow(/Unsafe bigint/);
    // Non-integer floats that pass an integer-safety check could still be
    // misleading; an unsafe value is rejected outright.
    expect(() => toSafeBigInt(0.5)).toThrow(/Unsafe bigint/);
  });

  it("parses integer strings exactly, including beyond MAX_SAFE_INTEGER", () => {
    expect(toSafeBigInt("9007199254740993")).toBe(9007199254740993n);
    expect(toSafeBigInt("0")).toBe(0n);
    expect(toSafeBigInt("  -7  ")).toBe(-7n);
    expect(toSafeBigInt("+123")).toBe(123n);
    expect(toSafeBigInt("99999999999999999999999")).toBe(99999999999999999999999n);
  });

  it("rejects malformed or empty strings", () => {
    expect(() => toSafeBigInt("")).toThrow(/empty string/);
    expect(() => toSafeBigInt("   ")).toThrow(/empty string/);
    expect(() => toSafeBigInt("12.5")).toThrow(/non-integer string/);
    expect(() => toSafeBigInt("abc")).toThrow(/non-integer string/);
    expect(() => toSafeBigInt("7n")).toThrow(/non-integer string/);
  });

  it("rejects unsupported value types", () => {
    expect(() => toSafeBigInt(null)).toThrow(/Unsupported/);
    expect(() => toSafeBigInt(undefined)).toThrow(/Unsupported/);
    expect(() => toSafeBigInt({})).toThrow(/Unsupported/);
    expect(() => toSafeBigInt([1])).toThrow(/Unsupported/);
    expect(() => toSafeBigInt(true)).toThrow(/Unsupported/);
  });
});
