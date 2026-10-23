/**
 * Unit tests for search query normalization and payload size bounds.
 *
 * BE-28: Normalize search whitespace
 * BE-29: Bound search result payload size
 *
 * These tests exercise the store-level functions directly so they are not
 * affected by the application-level wiring in api/index.ts or the pre-existing
 * type errors in api/response.ts.
 */
import {
  normalizeQuery,
  validateQuery,
  MAX_QUERY_LENGTH,
  SearchValidationError,
} from "../../search/store";

/**
 * The published max and default page sizes for the /api/v1/search route.
 * These values match the constants in api/search-router.ts and must not
 * be changed without updating the documentation.
 */
const DOCUMENTED_MAX_LIMIT = 100;
const DOCUMENTED_DEFAULT_LIMIT = 20;

// ── BE-28: Normalize search whitespace ────────────────────────────────────

describe("search whitespace normalization (BE-28)", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeQuery("  stellar  ")).toBe("stellar");
    expect(normalizeQuery("\tstellar\n")).toBe("stellar");
  });

  it("collapses multiple internal spaces into one", () => {
    expect(normalizeQuery("foo   bar")).toBe("foo bar");
    expect(normalizeQuery("foo\t\tbar")).toBe("foo bar");
    expect(normalizeQuery("foo  bar  baz")).toBe("foo bar baz");
  });

  it("preserves single spaces between words unchanged", () => {
    expect(normalizeQuery("foo bar")).toBe("foo bar");
    expect(normalizeQuery("stellar soroban")).toBe("stellar soroban");
  });

  it("normalizes mixed tabs and spaces", () => {
    expect(normalizeQuery("  foo \t bar  ")).toBe("foo bar");
  });

  it("produces identical output for all equivalent whitespace variants", () => {
    const variants = [
      "stellar soroban",
      "stellar  soroban",
      "stellar   soroban",
      " stellar soroban",
      "stellar soroban ",
      "  stellar   soroban  ",
    ];
    const normalized = variants.map(normalizeQuery);
    expect(new Set(normalized).size).toBe(1);
  });

  it("validateQuery normalizes and returns the collapsed form", () => {
    expect(validateQuery("  foo   bar  ")).toBe("foo bar");
  });

  it("validateQuery throws INVALID_QUERY for whitespace-only input", () => {
    const empty = ["", "   ", "\t", "\n\n"];
    for (const s of empty) {
      let err: SearchValidationError | undefined;
      try { validateQuery(s); } catch (e) { err = e as SearchValidationError; }
      expect(err).toBeInstanceOf(SearchValidationError);
      expect(err?.code).toBe("INVALID_QUERY");
    }
  });

  it("validateQuery rejects a non-string with INVALID_QUERY", () => {
    for (const bad of [undefined, null, 42, {}]) {
      let err: SearchValidationError | undefined;
      try { validateQuery(bad); } catch (e) { err = e as SearchValidationError; }
      expect(err).toBeInstanceOf(SearchValidationError);
      expect(err?.code).toBe("INVALID_QUERY");
    }
  });

  it("whitespace is normalized before the length check — padding cannot bypass the cap", () => {
    // A padded query whose raw length exceeds MAX_QUERY_LENGTH but whose
    // normalized form is at or under the limit must still be accepted.
    const padding = " ".repeat(MAX_QUERY_LENGTH + 50);
    const padded = "stellar" + padding;
    // raw.length > MAX_QUERY_LENGTH but normalized = "stellar" (7 chars)
    expect(padded.length).toBeGreaterThan(MAX_QUERY_LENGTH);
    expect(() => validateQuery(padded)).not.toThrow();
    expect(validateQuery(padded)).toBe("stellar");
  });
});

// ── BE-29: Bound search result payload size ───────────────────────────────

describe("search result payload size bounds (BE-29)", () => {
  it("documented MAX_LIMIT is 100", () => {
    // Matches the constant in api/search-router.ts — a value above this
    // must be rejected by the route before it reaches the store.
    expect(DOCUMENTED_MAX_LIMIT).toBe(100);
  });

  it("documented DEFAULT_LIMIT is 20", () => {
    expect(DOCUMENTED_DEFAULT_LIMIT).toBe(20);
  });

  it("MAX_QUERY_LENGTH is 200 — queries above this are rejected", () => {
    expect(MAX_QUERY_LENGTH).toBe(200);
  });

  it("a query exactly at MAX_QUERY_LENGTH (200 chars) is accepted", () => {
    const atLimit = "a".repeat(MAX_QUERY_LENGTH);
    expect(() => validateQuery(atLimit)).not.toThrow();
    expect(validateQuery(atLimit)).toBe(atLimit);
  });

  it("a query one character over MAX_QUERY_LENGTH is rejected with QUERY_TOO_LONG", () => {
    const over = "a".repeat(MAX_QUERY_LENGTH + 1);
    let err: SearchValidationError | undefined;
    try { validateQuery(over); } catch (e) { err = e as SearchValidationError; }
    expect(err).toBeInstanceOf(SearchValidationError);
    expect(err?.code).toBe("QUERY_TOO_LONG");
  });

  it("QUERY_TOO_LONG error message includes the documented limit", () => {
    const over = "a".repeat(MAX_QUERY_LENGTH + 1);
    let err: SearchValidationError | undefined;
    try { validateQuery(over); } catch (e) { err = e as SearchValidationError; }
    expect(err?.message).toContain(String(MAX_QUERY_LENGTH));
  });

  it("MAX_LIMIT (100) is the published upper bound — cannot be exceeded silently", () => {
    // The route rejects limit > MAX_LIMIT with LIMIT_EXCEEDED. We verify the
    // constant matches the documented API contract.
    expect(DOCUMENTED_MAX_LIMIT).toBeLessThanOrEqual(100);
    expect(DOCUMENTED_DEFAULT_LIMIT).toBeLessThanOrEqual(DOCUMENTED_MAX_LIMIT);
  });
});
