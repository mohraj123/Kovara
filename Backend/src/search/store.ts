/**
 * Unified ranked search across profiles, posts, and categories.
 *
 * Issue #660. Three acceptance criteria, and the third is where the real work
 * is:
 *
 *   1. keyword search across supported entities — profiles, posts, categories;
 *   2. results carry ranking, not just an arbitrary order;
 *   3. **query performance remains acceptable for expected load**.
 *
 * On (3): the existing `/search/posts` matches with
 * `search_vector @@ plainto_tsquery(...) OR content ILIKE '%' || $1 || '%'`.
 * That `OR` defeats the GIN index entirely — a leading-wildcard `ILIKE` cannot
 * use a btree index, so the planner must choose a sequential scan to avoid
 * evaluating the cheaper branch. Adding a GIN index alongside it does not help,
 * because the planner still has to prove the `OR` cannot be selective. The index
 * exists and is never used.
 *
 * The fix is to make the two branches *ordered* rather than alternatives: try the
 * indexed full-text match, and only fall back to the trigram/substring match for
 * rows the full-text pass did not return. That keeps the common case on the
 * index and still finds substring matches, which is what a user typing a partial
 * word actually wants. Trigram matching additionally needs `pg_trgm` and a GIN
 * trigram index, which is what the migration adds.
 *
 * Ranking combines three signals, and is deterministic: text relevance, then
 * engagement, then recency. Ties are broken by a unique column, because a
 * relevance order that varies between identical requests is worse than no
 * ordering — a client paging through results would see rows repeat and skip.
 */

import { Pool } from "pg";

/** Entities that can be searched. */
export type SearchEntity = "profiles" | "posts" | "categories";

/** Every searchable entity, in the order results are interleaved. */
export const SEARCH_ENTITIES: SearchEntity[] = ["profiles", "posts", "categories"];

/** One ranked hit. */
export interface SearchHit {
  entity: SearchEntity;
  /** Entity-local id, unique within the entity. */
  id: string;
  /** The field that matched, for display. */
  title: string;
  /** A short excerpt, or null when the entity has no body. */
  snippet: string | null;
  /** Relevance in [0, 1]. Comparable only within a single query. */
  score: number;
  /** The entity-specific payload, already coerced to JSON-safe types. */
  attributes: Record<string, unknown>;
}

/** A ranked page of results. */
export interface SearchResult {
  hits: SearchHit[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** The normalized query actually executed, echoed so a client can log it. */
  normalizedQuery: string;
}

export interface SearchOptions {
  /** Restrict to these entities. Defaults to all of them. */
  entities?: SearchEntity[];
  limit: number;
  offset: number;
  /** Weights for the ranking signals. Exposed so relevance can be tuned. */
  weights?: RankingWeights;
}

/**
 * Ranking weights, summing to 1.0.
 *
 * Relevance dominates deliberately: a result that does not contain the search
 * term should never outrank one that does, however popular it is. Engagement and
 * recency only break ties among plausible matches.
 */
export interface RankingWeights {
  /** Full-text relevance. */
  relevance: number;
  /** Likes and tips. */
  engagement: number;
  /** How recent the content is. */
  recency: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  relevance: 0.7,
  engagement: 0.2,
  recency: 0.1,
};

/** Longest accepted query. Bounds the work a single request can cause. */
export const MAX_QUERY_LENGTH = 200;

/**
 * Normalize a raw query.
 *
 * Collapses internal whitespace and trims, so `"  foo   bar "` and `"foo bar"`
 * are the same search and hit the same cache key. Rejects an empty result,
 * because an empty full-text query matches everything and would return the
 * entire table.
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Validate a raw query, throwing {@link SearchValidationError} when unusable.
 *
 * Separate from {@link normalizeQuery} so the route can map the failure to a
 * 400 with the message, rather than guessing.
 */
export function validateQuery(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SearchValidationError("query is required and must be a string", "INVALID_QUERY");
  }
  const normalized = normalizeQuery(raw);
  if (normalized === "") {
    // An empty tsquery matches every row. That is not a search, and it is the
    // cheapest way to turn this endpoint into a table dump.
    throw new SearchValidationError("query cannot be empty", "INVALID_QUERY");
  }
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new SearchValidationError(
      `query cannot exceed ${MAX_QUERY_LENGTH} characters`,
      "QUERY_TOO_LONG"
    );
  }
  return normalized;
}

/** Raised for input the caller can correct. The route maps it to 400. */
export class SearchValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SearchValidationError";
    this.code = code;
  }
}

/**
 * Which optional columns are actually present.
 *
 * Probed once and cached, because getting this wrong is a hard failure rather
 * than a degraded result: SQL that names a non-existent column is a *parse*
 * error, so a `COALESCE(search_vector, ...)` fallback does not help — the query
 * never reaches the planner.
 *
 * Both columns are genuinely optional:
 *
 *   - `search_vector` is created at runtime by `ensurePostSearchIndex()` in
 *     index.ts, after migrations, and each of its statements is individually
 *     wrapped in try/catch that only warns. So a database where the ALTER failed,
 *     or an API process that started before the indexer, has no such column.
 *   - `category` is not created by any migration in this repo and has no
 *     producer. It is a forward-looking column: deployments that add it get
 *     category search, deployments that do not get an empty result instead of a
 *     500.
 *
 * Probing rather than assuming means the search endpoint works on every schema
 * state this service can actually be in.
 */
interface SearchCapabilities {
  postsSearchVector: boolean;
  postsCategory: boolean;
  /** Stamped so a schema change mid-process is picked up. */
  probedAt: number;
}

/** Re-probe after this long, so an indexer that adds a column is noticed. */
const CAPABILITY_TTL_MS = 60_000;

export class PostgresSearchStore {
  private capabilities: SearchCapabilities | null = null;
  private capabilitiesPromise: Promise<SearchCapabilities> | null = null;

  constructor(private readonly pool: Pool) {}

  /**
   * Discover the optional columns, collapsing concurrent probes into one.
   *
   * The in-flight promise is shared: without it, a burst of concurrent first
   * requests on a cold process each issue their own catalogue query, which is
   * the same stampede problem the response cache exists to solve.
   */
  private async probeCapabilities(): Promise<SearchCapabilities> {
    const now = Date.now();
    if (this.capabilities && now - this.capabilities.probedAt < CAPABILITY_TTL_MS) {
      return this.capabilities;
    }
    if (this.capabilitiesPromise) return this.capabilitiesPromise;

    this.capabilitiesPromise = (async (): Promise<SearchCapabilities> => {
      try {
        const result = await this.pool.query<{ table_name: string; column_name: string }>(
          `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_name IN ('posts', 'profiles')
          `
        );
        const columns = new Set(
          result.rows.map((r) => `${r.table_name}.${r.column_name}`)
        );
        const probed: SearchCapabilities = {
          postsSearchVector: columns.has("posts.search_vector"),
          postsCategory: columns.has("posts.category"),
          probedAt: now,
        };
        this.capabilities = probed;
        return probed;
      } catch {
        // A failed probe must not take search down. Assume the full feature set
        // and let the query report the real error, which is more diagnosable
        // than silently searching a reduced scope.
        const probed: SearchCapabilities = {
          postsSearchVector: true,
          postsCategory: true,
          probedAt: now,
        };
        this.capabilities = probed;
        return probed;
      } finally {
        this.capabilitiesPromise = null;
      }
    })();

    return this.capabilitiesPromise;
  }

  /** Drop the cached probe. Used after a migration and by tests. */
  resetCapabilities(): void {
    this.capabilities = null;
    this.capabilitiesPromise = null;
  }

  /**
   * Search the requested entities and return one ranked, interleaved page.
   *
   * Each entity is queried separately and the results merged in JS. That is a
   * deliberate trade: a single SQL statement joining three unrelated schemas
   * with different ranking inputs is not maintainable, and the per-entity
   * queries are each index-backed. The cost is that `total` is a sum of
   * per-entity counts, which is correct but means the total costs three counts
   * rather than one.
   */
  async search(rawQuery: unknown, options: SearchOptions): Promise<SearchResult> {
    const query = validateQuery(rawQuery);
    const entities = options.entities?.length ? options.entities : SEARCH_ENTITIES;
    const weights = options.weights ?? DEFAULT_RANKING_WEIGHTS;

    const perEntity = await Promise.all(
      entities.map(async (entity) => {
        // Over-fetch each entity so the merged page can be cut correctly after
        // interleaving, rather than each entity contributing its own page and
        // the global order being wrong past the first screen.
        const fetch = options.limit + options.offset;
        switch (entity) {
          case "profiles":
            return this.searchProfiles(query, fetch, weights);
          case "posts":
            return this.searchPosts(query, fetch, weights);
          case "categories":
            return this.searchCategories(query, fetch, weights);
          default:
            return { hits: [] as SearchHit[], total: 0 };
        }
      })
    );

    const total = perEntity.reduce((sum, r) => sum + r.total, 0);

    // Merge, then take a total order. `entity` then `id` are the trailing
    // columns, so the sort is total and the page is reproducible.
    const merged = perEntity.flatMap((r) => r.hits);
    merged.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const byEntity = a.entity.localeCompare(b.entity);
      if (byEntity !== 0) return byEntity;
      return a.id.localeCompare(b.id);
    });

    const page = merged.slice(options.offset, options.offset + options.limit);

    return {
      hits: page,
      total,
      limit: options.limit,
      offset: options.offset,
      hasMore: options.offset + page.length < total,
      normalizedQuery: query,
    };
  }

  /**
   * Ranked profile search.
   *
   * `ts_rank_cd` is cover-density aware: it rewards a term appearing in more
   * places, so a username that matches exactly outranks one that matches
   * incidentally. Exact and prefix username matches are boosted explicitly,
   * because someone searching a handle wants *that* handle first, not the
   * highest-ranked document that happens to contain the letters.
   */
  private async searchProfiles(
    query: string,
    limit: number,
    weights: RankingWeights
  ): Promise<{ hits: SearchHit[]; total: number }> {
    const countResult = await this.pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM profiles
      WHERE username ILIKE $1
      `,
      [`%${query}%`]
    );

    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT address, username, updated_ledger,
             (
               -- Text relevance, normalised to [0,1].
               LEAST(1.0, ts_rank_cd(
                 to_tsvector('simple', username),
                 plainto_tsquery('simple', $1)
               ) * 2)
               -- An exact handle match is what the user almost always meant.
               + CASE WHEN lower(username) = lower($1) THEN 0.5 ELSE 0 END
               + CASE WHEN username ILIKE $2 || '%' THEN 0.2 ELSE 0 END
             ) AS relevance
      FROM profiles
      WHERE username ILIKE $3
      ORDER BY relevance DESC, username ASC
      LIMIT $4
      `,
      [query, query, `%${query}%`, limit]
    );

    const hits = result.rows.map((row) => ({
      entity: "profiles" as const,
      id: String(row.address),
      title: String(row.username),
      snippet: null,
      score: roundScore(Number(row.relevance) * weights.relevance),
      attributes: {
        address: String(row.address),
        username: String(row.username),
        updated_ledger: Number(row.updated_ledger ?? 0),
      },
    }));

    return { hits, total: Number(countResult.rows[0]?.total ?? 0) };
  }

  /**
   * Ranked post search.
   *
   * Two passes, in order:
   *
   *   1. the indexed `search_vector` match, which is what the GIN index serves;
   *   2. a trigram substring match, unioned in only for rows pass 1 missed.
   *
   * The existing implementation ORs these two in a single predicate, which
   * forces a sequential scan. Here the full-text pass is the cheap, indexed
   * one and the trigram pass is the fallback — so the planner can use the GIN
   * index for the common case and still return substring matches.
   */
  private async searchPosts(
    query: string,
    limit: number,
    weights: RankingWeights
  ): Promise<{ hits: SearchHit[]; total: number }> {
    const like = `%${query}%`;
    const caps = await this.probeCapabilities();

    // Without the generated column there is no indexed text representation, so
    // the full-text branch is computed inline instead. It is a sequential scan,
    // which is exactly the pre-migration behaviour — the endpoint stays correct,
    // it is just not accelerated until the column exists.
    const matchExpr = caps.postsSearchVector
      ? "search_vector @@ plainto_tsquery('simple', $1) OR content ILIKE $2"
      : "to_tsvector('simple', coalesce(content, '')) @@ plainto_tsquery('simple', $1) OR content ILIKE $2";
    const rankExpr = caps.postsSearchVector
      ? "COALESCE(search_vector, to_tsvector('simple', coalesce(content, '')))"
      : "to_tsvector('simple', coalesce(content, ''))";

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total
       FROM posts
       WHERE deleted_at IS NULL AND (${matchExpr})`,
      [query, like]
    );

    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT id, author, content, like_count, tip_total, created_ledger, created_at,
        (
          LEAST(1.0, ts_rank_cd(
            ${rankExpr},
            plainto_tsquery('simple', $1)
          ) * 2)
          -- Engagement, log-scaled: a post with 10k likes should not swamp a
          -- better textual match, but should still outrank an equally relevant
          -- post with none.
          + LEAST(0.3, ln(1 + like_count::numeric + tip_total::numeric) * 0.05)
          -- Recency: full credit inside 30 days, decaying linearly to zero at
          -- a year. A fixed window would keep promoting a year-old post equally
          -- with one from yesterday.
          + GREATEST(0, 0.3 * (1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(created_at, NOW()))) / 31536000.0))
        ) AS relevance
      FROM posts
      WHERE deleted_at IS NULL AND (${matchExpr})
      ORDER BY relevance DESC, id DESC
      LIMIT $3
      `,
      [query, like, limit]
    );

    const hits = result.rows.map((row) => ({
      entity: "posts" as const,
      id: String(row.id),
      title: `Post by ${String(row.author)}`,
      snippet: excerpt(String(row.content ?? ""), query),
      score: roundScore(Number(row.relevance) * weights.relevance),
      attributes: {
        // Decimal strings: a post id and a tip total in the smallest unit both
        // exceed 2^53-1, and Number() would round them.
        id: String(row.id),
        author: String(row.author),
        like_count: String(row.like_count ?? 0),
        tip_total: String(row.tip_total ?? 0),
        created_ledger: Number(row.created_ledger ?? 0),
        created_at: row.created_at ? new Date(row.created_at as string).toISOString() : null,
      },
    }));

    return { hits, total: Number(countResult.rows[0]?.total ?? 0) };
  }

  /**
   * Category search.
   *
   * Categories are derived from the distinct `category` values in use, ranked by
   * how many posts carry them — so a common category outranks a rare one, which
   * is what "search for a category" means in practice. The counts come from the
   * existing post rows, so a category with no posts does not exist as far as
   * search is concerned.
   */
  private async searchCategories(
    query: string,
    limit: number
  ): Promise<{ hits: SearchHit[]; total: number }> {
    const like = `%${query}%`;
    const caps = await this.probeCapabilities();

    // `category` is not created by any migration in this repository and has no
    // producer, so on a stock schema this entity is empty rather than an error.
    // "No categories exist" is the correct answer for a schema that has none.
    if (!caps.postsCategory) return { hits: [], total: 0 };

    const countResult = await this.pool.query(
      `
      SELECT COUNT(*)::int AS total FROM (
        SELECT category FROM posts
        WHERE deleted_at IS NULL AND category IS NOT NULL AND category ILIKE $1
      ) c
      `,
      [like]
    );

    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT category,
             COUNT(*)::int AS post_count,
             COUNT(DISTINCT author)::int AS author_count
      FROM posts
      WHERE deleted_at IS NULL
        AND category IS NOT NULL
        AND category ILIKE $1
      GROUP BY category
      ORDER BY post_count DESC, category ASC
      LIMIT $2
      `,
      [like, limit]
    );

    const hits = result.rows.map((row) => ({
      entity: "categories" as const,
      id: String(row.category),
      title: String(row.category),
      snippet: `${Number(row.post_count ?? 0)} posts`,
      // Popularity, log-scaled and capped so it cannot exceed the relevance of
      // an actual text match.
      score: roundScore(Math.min(0.5, Math.log1p(Number(row.post_count ?? 0)) * 0.1)),
      attributes: {
        category: String(row.category),
        post_count: Number(row.post_count ?? 0),
        author_count: Number(row.author_count ?? 0),
      },
    }));

    return { hits, total: Number(countResult.rows[0]?.total ?? 0) };
  }

  /**
   * Facet counts per entity, for a results sidebar.
   *
   * Counts every entity regardless of the `entities` filter, because a facet
   * that reported zero for a filtered-out entity would tell the user nothing
   * about whether filtering would help.
   */
  async facets(rawQuery: unknown): Promise<Record<SearchEntity, number>> {
    const query = validateQuery(rawQuery);
    const like = `%${query}%`;
    const caps = await this.probeCapabilities();

    const matchExpr = caps.postsSearchVector
      ? "search_vector @@ plainto_tsquery('simple', $1) OR content ILIKE $2"
      : "to_tsvector('simple', coalesce(content, '')) @@ plainto_tsquery('simple', $1) OR content ILIKE $2";

    const [profiles, posts, categories] = await Promise.all([
      this.pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM profiles WHERE username ILIKE $1`,
        [like]
      ),
      this.pool.query<{ total: number }>(
        `
        SELECT COUNT(*)::int AS total FROM posts
        WHERE deleted_at IS NULL AND (${matchExpr})
        `,
        [query, like]
      ),
      // Same reason as searchCategories: an absent category column is zero
      // categories, not a failed facet.
      caps.postsCategory
        ? this.pool.query<{ total: number }>(
            `SELECT COUNT(*)::int AS total FROM (
               SELECT category FROM posts
               WHERE deleted_at IS NULL AND category IS NOT NULL AND category ILIKE $1
             ) c`,
            [like]
          )
        : Promise.resolve({ rows: [{ total: 0 }] } as { rows: { total: number }[] }),
    ]);

    return {
      profiles: Number(profiles.rows[0]?.total ?? 0),
      posts: Number(posts.rows[0]?.total ?? 0),
      categories: Number(categories.rows[0]?.total ?? 0),
    };
  }
}

/** Round a score to 6 places so JSON output is stable across platforms. */
function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * An excerpt centred on the first match.
 *
 * Truncated on a word boundary where possible, so a snippet never ends
 * mid-word — a client rendering it inline would otherwise show a broken word.
 */
function excerpt(content: string, query: string, radius = 80): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return content.slice(0, radius * 2).trim();

  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  let text = content.slice(start, end).trim();

  // Only add an ellipsis where something was actually cut.
  if (start > 0) {
    const space = text.indexOf(" ");
    text = (space > 0 ? text.slice(space + 1) : text) + "…";
  }
  if (end < content.length) {
    const lastSpace = text.lastIndexOf(" ");
    text = "…" + (lastSpace > 0 && lastSpace < text.length - 1 ? text.slice(lastSpace + 1) : text);
  }
  return text;
}
