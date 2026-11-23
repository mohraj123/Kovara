import {
  PostgresSearchStore,
  SearchValidationError,
  normalizeQuery,
  validateQuery,
  MAX_QUERY_LENGTH,
} from "../search/store";
import { Pool } from "pg";

/**
 * A pool stub that answers the capability probe and the entity queries.
 *
 * The store probes `information_schema.columns` once and caches the result, so
 * the stub has to answer that first and the per-entity SQL after it. Each query
 * is matched on a distinctive fragment rather than in order, so the stub does
 * not break if the store reorders its parallel queries.
 */
function makePool(options: {
  columns?: { table_name: string; column_name: string }[];
  profileRows?: Record<string, unknown>[];
  postRows?: Record<string, unknown>[];
  categoryRows?: Record<string, unknown>[];
  countByFragment?: Record<string, number>;
}) {
  const columns = options.columns ?? [
    { table_name: "posts", column_name: "search_vector" },
  ];
  const calls: string[] = [];

  const pool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.replace(/\s+/g, " "));
      const text = sql.replace(/\s+/g, " ");

      if (text.includes("information_schema.columns")) {
        return { rows: columns, rowCount: columns.length };
      }
      if (text.includes("COUNT(*)::int AS total")) {
        const key = text.includes("FROM profiles")
          ? "profiles"
          : text.includes("category")
            ? "categories"
            : "posts";
        const total = options.countByFragment?.[key] ?? 0;
        return { rows: [{ total }], rowCount: 1 };
      }
      if (text.includes("FROM profiles")) {
        return { rows: options.profileRows ?? [], rowCount: (options.profileRows ?? []).length };
      }
      if (text.includes("GROUP BY category")) {
        return { rows: options.categoryRows ?? [], rowCount: (options.categoryRows ?? []).length };
      }
      if (text.includes("FROM posts")) {
        return { rows: options.postRows ?? [], rowCount: (options.postRows ?? []).length };
      }
      void params;
      return { rows: [], rowCount: 0 };
    }),
  };

  return { pool: pool as unknown as Pool, calls, mock: pool.query };
}

describe("search query validation (#660)", () => {
  it("normalizes internal whitespace", () => {
    expect(normalizeQuery("  foo   bar  ")).toBe("foo bar");
  });

  it("treats differently-spaced queries as the same search", () => {
    // This is what lets them share a cache key.
    expect(validateQuery("  stellar   token ")).toBe(validateQuery("stellar token"));
  });

  it("rejects a non-string", () => {
    expect(() => validateQuery(undefined)).toThrow(SearchValidationError);
    expect(() => validateQuery(42)).toThrow(/must be a string/);
  });

  it("rejects an empty query", () => {
    // An empty tsquery matches every row, which is not a search and is the
    // cheapest way to turn this endpoint into a table dump.
    expect(() => validateQuery("   ")).toThrow(/cannot be empty/);
  });

  it("rejects an over-long query", () => {
    expect(() => validateQuery("a".repeat(MAX_QUERY_LENGTH + 1))).toThrow(/cannot exceed/);
  });
});

describe("PostgresSearchStore (#660)", () => {
  describe("capability probing", () => {
    it("returns no categories when the column does not exist", async () => {
      // `category` is not created by any migration in this repo. "No categories
      // exist" is the correct answer for a schema that has none, and it must not
      // be a 500.
      const { pool } = makePool({ columns: [{ table_name: "posts", column_name: "id" }] });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 10, offset: 0 });
      expect(result.hits.every((h) => h.entity !== "categories")).toBe(true);
    });

    it("probes once and caches the answer", async () => {
      // A burst of concurrent first requests must not each issue a catalogue
      // query — the same stampede problem the response cache exists to solve.
      const { pool, mock } = makePool({});
      const store = new PostgresSearchStore(pool);
      await Promise.all([
        store.search("a", { limit: 5, offset: 0 }),
        store.search("b", { limit: 5, offset: 0 }),
        store.search("c", { limit: 5, offset: 0 }),
      ]);
      const probes = mock.mock.calls.filter((c) => String(c[0]).includes("information_schema"));
      expect(probes.length).toBe(1);
    });

    it("falls back to the full feature set when the probe fails", async () => {
      // A failed probe must not silently reduce the search scope; letting the
      // query report the real error is more diagnosable.
      const pool = {
        query: jest.fn(async (sql: string) => {
          if (String(sql).includes("information_schema")) throw new Error("permission denied");
          return { rows: [], rowCount: 0 };
        }),
      } as unknown as Pool;
      const store = new PostgresSearchStore(pool as Pool);
      await store.search("a", { limit: 5, offset: 0 }).catch(() => undefined);
      // The point is that it attempted the full-featured query, not that it
      // succeeded.
      const queries = (pool.query as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(queries.some((q) => q.includes("search_vector"))).toBe(true);
    });

    it("re-probes after a reset so a newly added column is noticed", async () => {
      const { pool, mock } = makePool({});
      const store = new PostgresSearchStore(pool);
      await store.search("a", { limit: 5, offset: 0 });
      store.resetCapabilities();
      await store.search("a", { limit: 5, offset: 0 });
      const probes = mock.mock.calls.filter((c) => String(c[0]).includes("information_schema"));
      expect(probes.length).toBe(2);
    });
  });

  describe("ranking", () => {
    it("orders merged results by descending score", async () => {
      const { pool } = makePool({
        columns: [
          { table_name: "posts", column_name: "search_vector" },
          { table_name: "posts", column_name: "category" },
        ],
        countByFragment: { posts: 2, profiles: 1, categories: 0 },
        profileRows: [{ address: "G1", username: "stellar", updated_ledger: 1, relevance: 0.9 }],
        postRows: [
          { id: 1, author: "GA", content: "stellar", like_count: 1, tip_total: 0, created_ledger: 1, created_at: new Date().toISOString(), relevance: 0.5 },
        ],
      });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 10, offset: 0 });
      const scores = result.hits.map((h) => h.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it("breaks score ties deterministically", async () => {
      // A relevance order that varies between identical requests is worse than
      // no ordering: a client paging would see rows repeat and skip.
      const row = (id: number) => ({
        address: `G${id}`,
        username: "stellar",
        updated_ledger: 1,
        relevance: 0.5,
      });
      const { pool } = makePool({
        profileRows: [row(3), row(1), row(2)],
        countByFragment: { profiles: 3 },
      });
      const store = new PostgresSearchStore(pool);

      const first = await store.search("stellar", { limit: 10, offset: 0 });
      const second = await store.search("stellar", { limit: 10, offset: 0 });
      expect(first.hits.map((h) => h.id)).toEqual(second.hits.map((h) => h.id));
      expect(first.hits.map((h) => h.id)).toEqual(["1", "2", "3"]);
    });

    it("rounds scores so output is stable across platforms", async () => {
      // Unrounded floats render differently across runtimes, which would make
      // a client diffing two responses see a change where there is none.
      const { pool } = makePool({
        profileRows: [
          { address: "G1", username: "stellar", updated_ledger: 1, relevance: 1 / 3 },
        ],
        countByFragment: { profiles: 1 },
      });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 5, offset: 0 });
      // 1/3 * 0.7 (relevance weight) = 0.23333..., rounded to 6 places.
      expect(result.hits[0].score).toBe(0.233333);
    });
  });

  describe("pagination", () => {
    it("computes has_more for a partial page", async () => {
      const { pool } = makePool({
        postRows: Array.from({ length: 2 }, (_, i) => ({
          id: i,
          author: "GA",
          content: "stellar",
          like_count: 0,
          tip_total: 0,
          created_ledger: 0,
          created_at: new Date().toISOString(),
          relevance: 0.5,
        })),
        countByFragment: { posts: 100 },
      });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 2, offset: 0 });
      expect(result.hits).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(100);
    });

    it("slices the requested offset window", async () => {
      const { pool } = makePool({
        postRows: Array.from({ length: 5 }, (_, i) => ({
          id: i,
          author: "GA",
          content: "stellar",
          like_count: 0,
          tip_total: 0,
          created_ledger: 0,
          created_at: new Date().toISOString(),
          relevance: 0.5,
        })),
        countByFragment: { posts: 5 },
      });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 2, offset: 2 });
      expect(result.hits).toHaveLength(2);
    });
  });

  describe("bigint safety", () => {
    it("renders post ids and tip totals as decimal strings", async () => {
      // Both exceed 2^53-1 in the token's smallest unit, and Number() would
      // round them.
      const { pool } = makePool({
        postRows: [
          {
            id: 9007199254740993n,
            author: "GA",
            content: "stellar",
            like_count: 9007199254740993n,
            tip_total: 123456789012345678n,
            created_ledger: 1,
            created_at: new Date().toISOString(),
            relevance: 0.5,
          },
        ],
        countByFragment: { posts: 1 },
      });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 5, offset: 0 });
      const attrs = result.hits[0].attributes;
      expect(attrs.id).toBe("9007199254740993");
      expect(attrs.tip_total).toBe("123456789012345678");
      expect(attrs.like_count).toBe("9007199254740993");
    });
  });

  describe("entity filter", () => {
    it("restricts the query to the requested entities", async () => {
      const { pool } = makePool({
        profileRows: [{ address: "G1", username: "stellar", updated_ledger: 1, relevance: 0.9 }],
        countByFragment: { profiles: 1, posts: 5 },
      });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 10, offset: 0, entities: ["profiles"] });
      expect(result.hits.every((h) => h.entity === "profiles")).toBe(true);
    });

    it("sums totals across the requested entities", async () => {
      const { pool } = makePool({
        countByFragment: { profiles: 4, posts: 6, categories: 0 },
      });
      const store = new PostgresSearchStore(pool);
      const result = await store.search("stellar", { limit: 10, offset: 0 });
      expect(result.total).toBe(10);
    });
  });

  describe("facets", () => {
    it("reports a zero facet for an absent category column", async () => {
      const { pool } = makePool({
        columns: [{ table_name: "posts", column_name: "id" }],
        countByFragment: { profiles: 2, posts: 3 },
      });
      const store = new PostgresSearchStore(pool);
      const facets = await store.facets("stellar");
      expect(facets).toEqual({ profiles: 2, posts: 3, categories: 0 });
    });

    it("rejects an empty query rather than counting every row", async () => {
      const { pool } = makePool({});
      await expect(new PostgresSearchStore(pool).facets("  ")).rejects.toThrow(SearchValidationError);
    });
  });
});
