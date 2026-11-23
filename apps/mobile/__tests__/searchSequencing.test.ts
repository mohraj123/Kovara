/**
 * Search result sequencing (FE-23).
 *
 * A response issued for an older query must never replace the results of a
 * newer search.
 */

import { shouldApplySearchResult } from "../utils/searchSequencing";

describe("shouldApplySearchResult", () => {
  it("applies the response that belongs to the newest search", () => {
    expect(
      shouldApplySearchResult({ query: "music", requestId: 2 }, 2, "music")
    ).toBe(true);
  });

  it("ignores a response for a superseded query string", () => {
    // "maya" started first, "music" second. The slow first response must not
    // overwrite the second query's rows.
    expect(
      shouldApplySearchResult({ query: "maya", requestId: 1 }, 2, "music")
    ).toBe(false);
  });

  it("ignores a response whose id is behind the latest, even for the same query", () => {
    // Two identical searches (e.g. a retry tap) still only apply once.
    expect(
      shouldApplySearchResult({ query: "music", requestId: 4 }, 5, "music")
    ).toBe(false);
  });

  it("ignores the newest response once the query on screen has moved on", () => {
    // The debounce has not fired for the newest keystroke yet, so the query the
    // user sees is no longer the one the last request was issued for.
    expect(
      shouldApplySearchResult({ query: "music", requestId: 9 }, 9, "music ")
    ).toBe(false);
  });

  it("does not treat an aborted or unmounted run as current", () => {
    // A run abandoned at unmount has no newer sibling; nothing may be applied.
    expect(
      shouldApplySearchResult({ query: "music", requestId: 1 }, 0, "music")
    ).toBe(false);
  });

  it("is case- and whitespace-exact, matching what the user typed", () => {
    expect(
      shouldApplySearchResult({ query: "Music", requestId: 3 }, 3, "Music")
    ).toBe(true);
    expect(
      shouldApplySearchResult({ query: "Music", requestId: 3 }, 3, "music")
    ).toBe(false);
  });
});
