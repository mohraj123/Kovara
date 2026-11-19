/**
 * Query-shape and validation tests for the submission feed (#659) and the
 * audit query layer (#658).
 *
 * Driven through a stub pool that records SQL and parameters, so the tests
 * assert the two things that are easy to regress and hard to notice: that
 * caller input is always bound rather than interpolated, and that ordering is
 * total so pagination cannot skip or repeat a row.
 */

import {
  PostgresSubmissionFeed,
  SUBMISSION_STATUSES,
  SubmissionStatus,
} from "../submissions/feed";
import { AuditStore } from "../audit/store";
import { AuditAction, AuditOutcome } from "../audit/chain";

interface RecordedQuery {
  text: string;
  values: unknown[];
}

/** A pool stand-in that records every query and returns canned rows. */
function stubPool(rows: unknown[] = [], total = 0) {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (/COUNT\(\*\)::int AS total/i.test(text)) {
        return { rows: [{ total }] };
      }
      return { rows };
    },
  };
}

const asPool = (p: unknown) => p as never;

/** A row shaped like the submissions table. */
function submissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    submitter: `G${"A".repeat(55)}`,
    status: "verified",
    country_iso: "NG",
    category: "rent",
    value: "1500000",
    verified_by: `G${"B".repeat(55)}`,
    verified_at: new Date("2024-01-02T00:00:00Z"),
    submitted_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: new Date("2024-01-02T00:00:00Z"),
    ...overrides,
  };
}

describe("listSubmissions filters (#659)", () => {
  it("applies no WHERE clause when no filter is given", async () => {
    const pool = stubPool();
    const feed = new PostgresSubmissionFeed(asPool(pool));
    await feed.listSubmissions({ limit: 10, offset: 0 });
    expect(pool.queries[1].text).not.toMatch(/WHERE/);
  });

  it("binds each filter as a parameter", async () => {
    const pool = stubPool();
    const feed = new PostgresSubmissionFeed(asPool(pool));
    await feed.listSubmissions({
      status: "verified",
      submitter: `G${"A".repeat(55)}`,
      countryIso: "NG",
      category: "rent",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-31T00:00:00Z"),
      limit: 10,
      offset: 0,
    });

    const pageQuery = pool.queries[1];
    expect(pageQuery.values).toEqual(
      expect.arrayContaining(["verified", `G${"A".repeat(55)}`, "NG", "rent"])
    );
    // The value must never appear in the SQL text.
    expect(pageQuery.text).not.toContain("'verified'");
  });

  it("combines filters with AND", async () => {
    const pool = stubPool();
    const feed = new PostgresSubmissionFeed(asPool(pool));
    await feed.listSubmissions({ status: "pending", category: "food", limit: 5, offset: 0 });
    expect(pool.queries[1].text).toMatch(/AND/);
  });

  it("orders by submitted_at then id, so the ordering is total", async () => {
    const pool = stubPool();
    const feed = new PostgresSubmissionFeed(asPool(pool));
    await feed.listSubmissions({ limit: 10, offset: 0 });
    // Without the id tiebreak, two rows sharing a timestamp can swap places
    // between pages, so a client would see a record twice or miss one.
    expect(pool.queries[1].text).toMatch(/ORDER BY submitted_at DESC, id DESC/i);
  });

  it("places limit and offset after the bound filters", async () => {
    const pool = stubPool();
    const feed = new PostgresSubmissionFeed(asPool(pool));
    await feed.listSubmissions({ status: "verified", limit: 7, offset: 21 });
    const pageQuery = pool.queries[1];
    expect(pageQuery.values.slice(-2)).toEqual([7, 21]);
    expect(pageQuery.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+/i);
  });
});

describe("listSubmissions results (#659 edge cases)", () => {
  it("returns an empty page rather than throwing when nothing matches", async () => {
    const pool = stubPool([], 0);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const page = await feed.listSubmissions({ limit: 10, offset: 0 });
    expect(page.submissions).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("reports has_more true mid-list", async () => {
    const pool = stubPool([submissionRow(), submissionRow({ id: "s2" })], 40);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const page = await feed.listSubmissions({ limit: 2, offset: 0 });
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(40);
  });

  it("reports has_more false on the final page", async () => {
    const pool = stubPool([submissionRow()], 1);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const page = await feed.listSubmissions({ limit: 10, offset: 0 });
    expect(page.hasMore).toBe(false);
  });

  it("reports has_more false when total is an exact multiple of the page size", async () => {
    // The classic off-by-one: 20 rows, page size 10, second page is empty but
    // naive arithmetic says there is more.
    const pool = stubPool([], 20);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const page = await feed.listSubmissions({ limit: 10, offset: 10 });
    expect(page.hasMore).toBe(false);
  });

  it("serialises an oversized value as a string", async () => {
    // An i128-scaled value exceeds 2^53-1; a JSON number would round it.
    const huge = "9223372036854775807";
    const pool = stubPool([submissionRow({ value: huge })], 1);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const page = await feed.listSubmissions({ limit: 10, offset: 0 });
    expect(page.submissions[0].value).toBe(huge);
  });

  it("maps nullable columns to null rather than the string 'null'", async () => {
    const pool = stubPool(
      [
        submissionRow({
          country_iso: null,
          category: null,
          verified_by: null,
          verified_at: null,
        }),
      ],
      1
    );
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const page = await feed.listSubmissions({ limit: 10, offset: 0 });
    expect(page.submissions[0].countryIso).toBeNull();
    expect(page.submissions[0].category).toBeNull();
    expect(page.submissions[0].verifiedBy).toBeNull();
    expect(page.submissions[0].verifiedAt).toBeNull();
  });

  it("exposes exactly the three filterable statuses", () => {
    expect(SUBMISSION_STATUSES).toEqual<SubmissionStatus[]>(["pending", "verified", "rejected"]);
  });
});

describe("getSubmission", () => {
  it("returns null for a missing id so the route can choose 404", async () => {
    const pool = stubPool([]);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    expect(await feed.getSubmission("missing")).toBeNull();
  });

  it("returns the row when present", async () => {
    const pool = stubPool([submissionRow()]);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const result = await feed.getSubmission("s1");
    expect(result?.id).toBe("s1");
  });
});

describe("summarizeStatuses", () => {
  it("counts every status, defaulting absent ones to zero", async () => {
    const pool = stubPool([{ status: "verified", count: 7 }]);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const summary = await feed.summarizeStatuses({});
    expect(summary).toEqual({ pending: 0, verified: 7, rejected: 0 });
  });

  it("ignores an unrecognised status from the database", async () => {
    const pool = stubPool([{ status: "archived", count: 3 }]);
    const feed = new PostgresSubmissionFeed(asPool(pool));
    const summary = await feed.summarizeStatuses({});
    expect(summary).toEqual({ pending: 0, verified: 0, rejected: 0 });
  });
});

describe("AuditStore.listEntries (#658)", () => {
  it("orders newest-first with a total tiebreak", async () => {
    const pool = stubPool();
    const store = new AuditStore(asPool(pool));
    await store.listEntries({ limit: 10, offset: 0 });
    expect(pool.queries[1].text).toMatch(/ORDER BY occurred_at DESC, id DESC/i);
  });

  it("binds every filter as a parameter", async () => {
    const pool = stubPool();
    const store = new AuditStore(asPool(pool));
    await store.listEntries({
      stream: "contract:C1",
      action: "event.processed" as AuditAction,
      outcome: "success" as AuditOutcome,
      subject: "C1",
      actor: `G${"A".repeat(55)}`,
      ledger: 100,
      from: new Date("2024-01-01T00:00:00Z"),
      limit: 10,
      offset: 0,
    });
    const pageQuery = pool.queries[1];
    expect(pageQuery.values).toEqual(
      expect.arrayContaining(["contract:C1", "event.processed", "success", "C1", 100])
    );
    expect(pageQuery.text).not.toContain("'event.processed'");
  });

  it("filters an actor address with the address prefix", async () => {
    const pool = stubPool();
    const store = new AuditStore(asPool(pool));
    const address = `G${"A".repeat(55)}`;
    await store.listEntries({ actor: address, limit: 10, offset: 0 });
    // Prefixed so an address filter cannot match a system component of the
    // same name.
    expect(pool.queries[1].values).toContain(`address:${address}`);
  });

  it("returns an empty page when nothing matches", async () => {
    const pool = stubPool([], 0);
    const store = new AuditStore(asPool(pool));
    const page = await store.listEntries({ limit: 10, offset: 0 });
    expect(page.entries).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("clamps stable pagination bounds and preserves the total-order query", async () => {
    const pool = stubPool([], 0);
    const store = new AuditStore(asPool(pool));
    const page = await store.listEntries({ limit: 999, offset: -5 });
    expect(page.limit).toBe(500);
    expect(page.offset).toBe(0);
    expect(pool.queries[1].text).toMatch(/ORDER BY occurred_at DESC, id DESC/i);
  });
});
