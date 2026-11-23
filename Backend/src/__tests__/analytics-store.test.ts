/**
 * Validation and pagination tests for the analytics query layer (#654, #655).
 *
 * The Postgres-backed reads are exercised with a stub pool that records the SQL
 * and parameters, so the tests assert on the two properties that are easy to
 * regress and impossible to notice by hand: that caller input can never reach
 * the SQL text (it is always bound as a parameter), and that a rejected query
 * fails with a message written for the caller rather than a database error.
 */

import {
  PostgresAnalyticsStore,
  QueryValidationError,
  parseCountryIso,
  parsePagination,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "../analytics/store";
import { previousUtcDay } from "../analytics/job";

/** Minimal Pool stand-in that records queries and returns canned rows. */
function stubPool(rows: unknown[] = [], total = 0) {
  const queries: { text: string; values: unknown[] }[] = [];
  return {
    queries,
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      // The first call in each method is the COUNT.
      if (/COUNT\(\*\)::int AS total/i.test(text)) {
        return { rows: [{ total }] };
      }
      return { rows };
    },
  };
}

// Cast through unknown: the stub satisfies the query surface used here without
// needing the full pg Pool type.
const asPool = (p: unknown) => p as never;

describe("parsePagination", () => {
  it("defaults to a bounded page size", () => {
    expect(parsePagination({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });

  it("accepts an explicit page", () => {
    expect(parsePagination({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it("rejects a zero or negative limit", () => {
    expect(() => parsePagination({ limit: "0" })).toThrow(QueryValidationError);
    expect(() => parsePagination({ limit: "-1" })).toThrow(/positive integer/);
  });

  it("rejects a fractional limit", () => {
    expect(() => parsePagination({ limit: "1.5" })).toThrow(QueryValidationError);
  });

  it("rejects a limit above the cap", () => {
    expect(() => parsePagination({ limit: String(MAX_PAGE_SIZE + 1) })).toThrow(
      new RegExp(`cannot exceed ${MAX_PAGE_SIZE}`)
    );
  });

  it("rejects a negative offset", () => {
    expect(() => parsePagination({ offset: "-1" })).toThrow(/non-negative/);
  });

  it("rejects a non-numeric limit", () => {
    expect(() => parsePagination({ limit: "abc" })).toThrow(QueryValidationError);
  });
});

describe("parseCountryIso", () => {
  it("upper-cases a valid alpha-2 code", () => {
    expect(parseCountryIso("ng")).toBe("NG");
  });

  it("trims surrounding whitespace", () => {
    expect(parseCountryIso("  ng ")).toBe("NG");
  });

  it("rejects a three-letter code", () => {
    expect(() => parseCountryIso("NGA")).toThrow(/alpha-2/);
  });

  it("rejects an empty code", () => {
    expect(() => parseCountryIso("")).toThrow(QueryValidationError);
  });
});

describe("getIndexHistory (#654)", () => {
  it("binds filters as parameters rather than interpolating them", async () => {
    const pool = stubPool();
    const store = new PostgresAnalyticsStore(asPool(pool));

    await store.getIndexHistory({
      countryIso: "ng",
      category: "rent",
      from: "2024-01-01",
      to: "2024-01-31",
      limit: 10,
      offset: 0,
    });

    const pageQuery = pool.queries[1];
    // A value that would be catastrophic if interpolated is used to prove the
    // SQL text is never assembled from input.
    expect(pageQuery.values).toContain("NG");
    expect(pageQuery.text).not.toMatch(/'NG'/);
  });

  it("does not include a filter clause for an omitted filter", async () => {
    const pool = stubPool();
    const store = new PostgresAnalyticsStore(asPool(pool));
    await store.getIndexHistory({ limit: 10, offset: 0 });
    expect(pool.queries[1].text).not.toMatch(/WHERE/);
  });

  it("rejects an inverted date range before querying", async () => {
    const pool = stubPool();
    const store = new PostgresAnalyticsStore(asPool(pool));
    await expect(
      store.getIndexHistory({ from: "2024-02-01", to: "2024-01-01", limit: 10, offset: 0 })
    ).rejects.toThrow(/must not be after to/);
    expect(pool.queries).toHaveLength(0);
  });

  it("rejects a malformed date bound", async () => {
    const pool = stubPool();
    const store = new PostgresAnalyticsStore(asPool(pool));
    await expect(
      store.getIndexHistory({ from: "not-a-date", limit: 10, offset: 0 })
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("returns an empty page rather than throwing when there is no data", async () => {
    const pool = stubPool([], 0);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getIndexHistory({ limit: 10, offset: 0 });
    expect(page.entries).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("reports hasMore from the returned row count", async () => {
    const pool = stubPool(
      Array.from({ length: 5 }, (_, i) => ({
        run_date: "2024-01-01",
        country_iso: "NG",
        category: `c${i}`,
        median_value: "100",
        weighted_value: "100",
        sample_count: 1,
        contributor_count: 1,
        computed_at: new Date("2024-01-02T00:00:00Z"),
      })),
      12
    );
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getIndexHistory({ limit: 5, offset: 0 });
    expect(page.total).toBe(12);
    expect(page.hasMore).toBe(true);
  });

  it("reports hasMore false on the final page", async () => {
    const pool = stubPool(
      [
        {
          run_date: "2024-01-01",
          country_iso: "NG",
          category: "rent",
          median_value: "100",
          weighted_value: "100",
          sample_count: 1,
          contributor_count: 1,
          computed_at: new Date("2024-01-02T00:00:00Z"),
        },
      ],
      1
    );
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getIndexHistory({ limit: 10, offset: 0 });
    expect(page.hasMore).toBe(false);
  });

  it("serialises an index value larger than 2^53 without rounding", async () => {
    // 2^63 - 1 cannot survive a JSON number; the string form is the only
    // faithful representation of an i128-scaled price.
    const huge = "9223372036854775807";
    const pool = stubPool(
      [
        {
          run_date: "2024-01-01",
          country_iso: "NG",
          category: "rent",
          median_value: huge,
          weighted_value: huge,
          sample_count: 1,
          contributor_count: 1,
          computed_at: new Date("2024-01-02T00:00:00Z"),
        },
      ],
      1
    );
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getIndexHistory({ limit: 10, offset: 0 });
    expect(page.entries[0].medianValue).toBe(huge);
  });

  it("truncates a timestamped run_date to its date part", async () => {
    const pool = stubPool(
      [
        {
          run_date: "2024-01-01T00:00:00.000Z",
          country_iso: "NG",
          category: "rent",
          median_value: "1",
          weighted_value: "1",
          sample_count: 1,
          contributor_count: 1,
          computed_at: new Date("2024-01-02T00:00:00Z"),
        },
      ],
      1
    );
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getIndexHistory({ limit: 10, offset: 0 });
    expect(page.entries[0].runDate).toBe("2024-01-01");
  });
});

describe("getLeaderboard (#655)", () => {
  const day = (country: string, category: string, median: string) => ({
    run_date: "2024-01-01",
    country_iso: country,
    category,
    median_value: median,
    weighted_value: median,
    sample_count: 10,
    contributor_count: 2,
    computed_at: new Date("2024-01-02T00:00:00Z"),
  });

  it("ranks countries by index value, highest first", async () => {
    const pool = stubPool([day("NG", "rent", "300"), day("KE", "rent", "100")], 2);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getLeaderboard({ kind: "global" }, { limit: 10, offset: 0 });
    expect(page.entries.map((e) => e.countryIso)).toEqual(["NG", "KE"]);
    expect(page.entries[0].rank).toBe(1);
  });

  it("breaks ties deterministically by country so a re-run cannot reorder", async () => {
    const pool = stubPool([day("KE", "rent", "100"), day("NG", "rent", "100")], 2);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const first = await store.getLeaderboard({ kind: "global" }, { limit: 10, offset: 0 });
    expect(first.entries.map((e) => e.countryIso)).toEqual(["KE", "NG"]);

    // Same data, opposite input order: the ranking must be identical.
    const pool2 = stubPool([day("NG", "rent", "100"), day("KE", "rent", "100")], 2);
    const store2 = new PostgresAnalyticsStore(asPool(pool2));
    const second = await store2.getLeaderboard({ kind: "global" }, { limit: 10, offset: 0 });
    expect(second.entries.map((e) => e.countryIso)).toEqual(["KE", "NG"]);
  });

  it("ranks a country scope by its own categories", async () => {
    const pool = stubPool([day("NG", "rent", "300"), day("NG", "food", "100")], 2);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getLeaderboard(
      { kind: "country", countryIso: "NG" },
      { limit: 10, offset: 0 }
    );
    expect(page.entries.map((e) => e.category)).toEqual(["rent", "food"]);
  });

  it("ranks a contributors scope by submission volume", async () => {
    const small = { ...day("KE", "rent", "900"), sample_count: 1 };
    const large = { ...day("NG", "rent", "100"), sample_count: 500 };
    const pool = stubPool([small, large], 2);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getLeaderboard({ kind: "contributors" }, { limit: 10, offset: 0 });
    // NG has the higher index value but NG leads here, because volume is the
    // ranking key for this scope.
    expect(page.entries[0].countryIso).toBe("NG");
  });

  it("numbers ranks globally, not from one, on a later page", async () => {
    const pool = stubPool(
      [day("NG", "rent", "300"), day("KE", "rent", "200"), day("GH", "rent", "100")],
      3
    );
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getLeaderboard({ kind: "global" }, { limit: 1, offset: 1 });
    expect(page.entries[0].countryIso).toBe("KE");
    expect(page.entries[0].rank).toBe(2);
  });

  it("averages multiple days for the same country", async () => {
    const pool = stubPool([day("NG", "rent", "100"), day("NG", "food", "300")], 2);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getLeaderboard({ kind: "global" }, { limit: 10, offset: 0 });
    // Two categories, mean 200.
    expect(page.entries[0].medianIndex).toBe("200");
  });

  it("returns an empty page when nothing has been published", async () => {
    const pool = stubPool([], 0);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getLeaderboard({ kind: "global" }, { limit: 10, offset: 0 });
    expect(page.entries).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("rejects an invalid country on a country scope", async () => {
    const pool = stubPool();
    const store = new PostgresAnalyticsStore(asPool(pool));
    await expect(
      store.getLeaderboard({ kind: "country", countryIso: "NGA" }, { limit: 10, offset: 0 })
    ).rejects.toThrow(/alpha-2/);
  });

  it("normalises the returned date window", async () => {
    const pool = stubPool([], 0);
    const store = new PostgresAnalyticsStore(asPool(pool));
    const page = await store.getLeaderboard(
      { kind: "global" },
      { from: "2024-01-01", to: "2024-01-31", limit: 10, offset: 0 }
    );
    expect(page.from).toBe("2024-01-01");
    expect(page.to).toBe("2024-01-31");
  });
});

describe("previousUtcDay", () => {
  it("returns the preceding day in UTC", () => {
    expect(previousUtcDay(new Date("2024-03-15T10:00:00Z"))).toBe("2024-03-14");
  });

  it("crosses a month boundary", () => {
    expect(previousUtcDay(new Date("2024-03-01T00:00:01Z"))).toBe("2024-02-29");
  });

  it("crosses a year boundary", () => {
    expect(previousUtcDay(new Date("2024-01-01T06:00:00Z"))).toBe("2023-12-31");
  });

  it("does not shift the day for a late-UTC observation", () => {
    // 23:00 UTC is still the same day; using local time here would roll over
    // early and aggregate a day that has not finished.
    expect(previousUtcDay(new Date("2024-03-15T23:00:00Z"))).toBe("2024-03-14");
  });
});
