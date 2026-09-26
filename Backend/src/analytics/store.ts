/**
 * Historical index retrieval and country leaderboards.
 *
 * Issues #654 and #655. Once a daily aggregate exists (see the `aggregation`
 * module), two read paths need it: a historical series for charting, and a
 * ranked leaderboard of contributors.
 *
 * Determinism is the constraint that shapes both. A leaderboard is only useful
 * if the same dataset and time range always produce the same order, so every
 * query here carries a **total** ordering: ties are broken by a unique column
 * rather than left to the planner. Without an explicit tiebreak, Postgres may
 * return two contributors with equal scores in either order, so the same
 * request can produce a different ranking on a re-run — which looks like data
 * changing when it did not.
 *
 * Empty result sets are a normal answer, not an error: a country with no
 * submissions yet returns an empty list with `total: 0` and a 200, because
 * "no data" is a fact about the world the caller needs to distinguish from a
 * bad request. Only malformed input produces a 4xx.
 */

import { Pool } from "pg";
import { toSafeBigInt } from "../db";
import {
  AggregationResult,
  FilterOptions,
  PricePoint,
  aggregate,
} from "./index-aggregation";

/** One day's published index for a (country, category). */
export interface IndexHistoryEntry {
  runDate: string;
  countryIso: string;
  category: string;
  medianValue: string;
  weightedValue: string;
  sampleCount: number;
  contributorCount: number;
  /** When the aggregate was computed; distinct from `runDate` on a catch-up run. */
  computedAt: string;
}

/** A paginated historical series. */
export interface IndexHistoryPage {
  entries: IndexHistoryEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** One recorded filter decision, as read back from the decision log. */
export interface FilterDecisionView {
  submissionId: string;
  /** As a decimal string: an i128-scaled value does not fit a JSON number. */
  value: string;
  included: boolean;
  reason: string;
  threshold: string | null;
}

/** Filters accepted by {@link PostgresAnalyticsStore.getIndexHistory}. */
export interface HistoryQuery {
  countryIso?: string;
  category?: string;
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  to?: string;
  limit: number;
  offset: number;
}

/** One row of the country leaderboard. */
export interface LeaderboardEntry {
  rank: number;
  countryIso: string;
  category: string | null;
  /** The rank key the ordering is derived from. */
  score: string;
  submissionCount: number;
  contributorCount: number;
  /** Mean of the published index values over the window, when available. */
  medianIndex: string | null;
}

/** Scope of a leaderboard request. */
export type LeaderboardScope =
  /** Every country, ranked by index. */
  | { kind: "global" }
  /** One country, ranked by its categories. */
  | { kind: "country"; countryIso: string }
  /** Every country, ranked by contribution volume. */
  | { kind: "contributors" };

/** A paginated leaderboard page. */
export interface LeaderboardPage {
  entries: LeaderboardEntry[];
  total: number;
  scope: LeaderboardScope;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Upper bound on `limit`, so one request cannot ask for the whole table. */
export const MAX_PAGE_SIZE = 100;

/** Default page size when the caller does not ask for one. */
export const DEFAULT_PAGE_SIZE = 20;

/** `YYYY-MM-DD`, with an optional time. Anything else is rejected. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 3166-1 alpha-2, uppercased. */
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

/**
 * Validate and normalise pagination. Throws {@link QueryValidationError} with a
 * caller-actionable message, so the route layer can turn it into a 400 without
 * re-deriving the rules.
 */
export function parsePagination(
  raw: { limit?: unknown; offset?: unknown },
  max = MAX_PAGE_SIZE
): { limit: number; offset: number } {
  const limit = raw.limit === undefined ? DEFAULT_PAGE_SIZE : Number(raw.limit);
  const offset = raw.offset === undefined ? 0 : Number(raw.offset);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new QueryValidationError("limit must be a positive integer");
  }
  if (limit > max) {
    throw new QueryValidationError(`limit cannot exceed ${max}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new QueryValidationError("offset must be a non-negative integer");
  }
  return { limit, offset };
}

/** Raised for input the caller can correct. The route layer maps it to 400. */
export class QueryValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_QUERY") {
    super(message);
    this.name = "QueryValidationError";
    this.code = code;
  }
}

/** Normalise a `YYYY-MM-DD` bound, accepting a full ISO timestamp. */
function parseDateBound(raw: string, name: string): string {
  const value = raw.trim();
  if (DATE_PATTERN.test(value)) return value;
  // An ISO timestamp is accepted and truncated to its date; rejecting it would
  // force every chart client to reformat before querying.
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) {
    throw new QueryValidationError(`${name} must be a date in YYYY-MM-DD format`, "INVALID_DATE");
  }
  return asDate.toISOString().slice(0, 10);
}

/** Normalise a country code to upper case and validate its shape. */
export function parseCountryIso(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (!COUNTRY_PATTERN.test(value)) {
    throw new QueryValidationError(
      "country must be an ISO 3166-1 alpha-2 code, e.g. NG",
      "INVALID_COUNTRY"
    );
  }
  return value;
}

export class PostgresAnalyticsStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Load the verified observations for one country and category on a day.
   *
   * Returns them in observation order and never returns a rejected or pending
   * row unless the caller asks for it: an aggregate computed from observations
   * that later get rejected would be silently unreproducible.
   */
  async loadObservations(
    countryIso: string,
    category: string,
    runDate: string,
    statuses: PricePoint["status"][] = ["verified"]
  ): Promise<PricePoint[]> {
    const country = parseCountryIso(countryIso);
    const day = parseDateBound(runDate, "runDate");

    const result = await this.pool.query(
      `
      SELECT id, value, submitter, status, observed_at
      FROM price_observations
      WHERE country_iso = $1
        AND category = $2
        AND observed_at >= $3::date
        AND observed_at <  ($3::date + INTERVAL '1 day')
        AND status = ANY($4::text[])
      ORDER BY observed_at ASC, id ASC
      `,
      [country, category, day, statuses]
    );

    return result.rows.map((row) => ({
      submissionId: String(row.id),
      // toSafeBigInt: an i128-scaled price can exceed 2^53-1, and Number()
      // would round it before any arithmetic ran.
      value: toSafeBigInt(row.value),
      submitter: String(row.submitter),
      status: String(row.status) as PricePoint["status"],
      timestamp: new Date(row.observed_at).getTime(),
    }));
  }

  /**
   * Compute and persist one day's aggregate for a (country, category).
   *
   * The aggregate and its decision log are written in a single transaction: a
   * published index with no explanation of which observations produced it is
   * exactly the state this feature exists to avoid, so the two must not be
   * able to diverge.
   *
   * Re-running a day is idempotent — both tables are keyed by
   * (run_date, country, category[, submission_id]) and written with
   * `ON CONFLICT ... DO UPDATE`, so a catch-up run converges on the same state
   * rather than accumulating duplicate rows.
   *
   * Returns null when no observation survived filtering: there is no index to
   * publish, and the caller should treat that as "no data" rather than
   * publishing a zero.
   */
  async aggregateDay(
    countryIso: string,
    category: string,
    runDate: string,
    options: FilterOptions = {}
  ): Promise<AggregationResult | null> {
    const country = parseCountryIso(countryIso);
    const day = parseDateBound(runDate, "runDate");
    const observations = await this.loadObservations(country, category, day);
    const result = aggregate(observations, options);
    if (result.median === null) return null;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const contributors = new Set(
        observations.filter((o) => o.status === "verified").map((o) => o.submitter)
      );

      await client.query(
        `
        INSERT INTO price_index_aggregates
          (run_date, country_iso, category, median_value, weighted_value,
           sample_count, contributor_count, excluded_count, excluded_by_reason,
           computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
        ON CONFLICT (run_date, country_iso, category) DO UPDATE SET
          median_value       = EXCLUDED.median_value,
          weighted_value     = EXCLUDED.weighted_value,
          sample_count       = EXCLUDED.sample_count,
          contributor_count  = EXCLUDED.contributor_count,
          excluded_count     = EXCLUDED.excluded_count,
          excluded_by_reason = EXCLUDED.excluded_by_reason,
          computed_at        = NOW()
        `,
        [
          day,
          country,
          category,
          result.median.toString(),
          (result.weighted ?? result.median).toString(),
          result.includedCount,
          contributors.size,
          result.excludedCount,
          JSON.stringify(result.excludedByReason),
        ]
      );

      for (const decision of result.decisions) {
        await client.query(
          `
          INSERT INTO price_index_filter_decisions
            (run_date, country_iso, category, submission_id, value, included,
             reason, threshold)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (run_date, country_iso, category, submission_id)
          DO UPDATE SET
            value     = EXCLUDED.value,
            included  = EXCLUDED.included,
            reason    = EXCLUDED.reason,
            threshold = EXCLUDED.threshold,
            recorded_at = NOW()
          `,
          [
            day,
            country,
            category,
            decision.submissionId,
            decision.value.toString(),
            decision.included,
            decision.reason,
            decision.threshold === null ? null : decision.threshold.toString(),
          ]
        );
      }

      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The recorded filter decisions for a published day.
   *
   * Exposed so the exclusion log is reviewable, which is the point of recording
   * it (#653): a dispute about an index value is resolved by showing which
   * observations were dropped and the threshold that dropped them.
   */
  async getFilterDecisions(
    countryIso: string,
    category: string,
    runDate: string
  ): Promise<FilterDecisionView[]> {
    const result = await this.pool.query(
      `
      SELECT submission_id, value, included, reason, threshold
      FROM price_index_filter_decisions
      WHERE run_date = $1::date AND country_iso = $2 AND category = $3
      ORDER BY included DESC, submission_id ASC
      `,
      [parseDateBound(runDate, "runDate"), parseCountryIso(countryIso), category]
    );

    return result.rows.map((row) => ({
      submissionId: String(row.submission_id),
      value: toSafeBigInt(row.value).toString(),
      included: Boolean(row.included),
      reason: String(row.reason),
      threshold: row.threshold === null ? null : toSafeBigInt(row.threshold).toString(),
    }));
  }

  /**
   * Historical index series, newest first, with a deterministic tiebreak.
   *
   * Filters are applied with optional SQL predicates built from a parameter
   * array rather than string interpolation, so a value can never be
   * interpreted as SQL.
   */
  async getIndexHistory(query: HistoryQuery): Promise<IndexHistoryPage> {
    const { limit, offset } = parsePagination(query);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.countryIso) {
      params.push(parseCountryIso(query.countryIso));
      conditions.push(`country_iso = $${params.length}`);
    }
    if (query.category) {
      params.push(query.category.trim());
      conditions.push(`category = $${params.length}`);
    }
    if (query.from) {
      params.push(parseDateBound(query.from, "from"));
      conditions.push(`run_date >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(parseDateBound(query.to, "to"));
      conditions.push(`run_date <= $${params.length}::date`);
    }
    if (
      query.from &&
      query.to &&
      parseDateBound(query.from, "from") > parseDateBound(query.to, "to")
    ) {
      throw new QueryValidationError("from must not be after to", "INVALID_RANGE");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // One parameter set is reused for both the count and the page, so the two
    // cannot disagree about which rows match.
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM price_index_aggregates ${where}`,
      params
    );

    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;
    const result = await this.pool.query(
      `
      SELECT run_date, country_iso, category, median_value, weighted_value,
             sample_count, contributor_count, computed_at
      FROM price_index_aggregates
      ${where}
      ORDER BY run_date DESC, country_iso ASC, category ASC
      LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      [...params, limit, offset]
    );

    const total = Number(countResult.rows[0]?.total ?? 0);
    return {
      entries: result.rows.map((row) => ({
        runDate: String(row.run_date).slice(0, 10),
        countryIso: String(row.country_iso),
        category: String(row.category),
        // toSafeBigInt: an index value can exceed 2^53-1 in the smallest
        // fixed-point unit, and Number() would silently round it.
        medianValue: toSafeBigInt(row.median_value ?? 0).toString(),
        weightedValue: toSafeBigInt(row.weighted_value ?? 0).toString(),
        sampleCount: Number(row.sample_count ?? 0),
        contributorCount: Number(row.contributor_count ?? 0),
        computedAt: new Date(row.computed_at).toISOString(),
      })),
      total,
      limit,
      offset,
      // Derived from the returned row count, not from `total`, so a page that
      // runs past the end reports hasMore correctly.
      hasMore: offset + result.rows.length < total,
    };
  }

  /**
   * Country leaderboard.
   *
   * Ordering is fully determined: score descending, then `country_iso` then
   * `category` ascending. The trailing columns are unique, so the same dataset
   * and window always yield byte-identical output.
   */
  async getLeaderboard(
    scope: LeaderboardScope,
    options: { from?: string; to?: string; limit: unknown; offset: unknown }
  ): Promise<LeaderboardPage> {
    const { limit, offset } = parsePagination(options);
    const from = options.from ? parseDateBound(options.from, "from") : null;
    const to = options.to ? parseDateBound(options.to, "to") : null;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (from) {
      params.push(from);
      conditions.push(`run_date >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conditions.push(`run_date <= $${params.length}::date`);
    }
    if (scope.kind === "country") {
      params.push(parseCountryIso(scope.countryIso));
      conditions.push(`country_iso = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // A country-scoped board ranks categories; the other scopes rank
    // countries. Both aggregate over the window so the score reflects the
    // whole range rather than a single day.
    const groupColumns =
      scope.kind === "country"
        ? `category`
        : `country_iso`;

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM (SELECT ${groupColumns} FROM price_index_aggregates ${where} GROUP BY ${groupColumns}) ranked`,
      params
    );

    // The ranking is reduced in JS rather than in SQL so the rule (which of
    // median and weighted to trust, and how to break ties) lives in one
    // readable, unit-testable place without a database. The result set is one
    // row per country/category per day, so the reduction is bounded by the
    // leaderboard's own data volume rather than by the observation table.
    const result = await this.pool.query(
      `
      SELECT country_iso, category,
             median_value, weighted_value, sample_count, contributor_count
      FROM price_index_aggregates
      ${where}
      ORDER BY country_iso ASC, category ASC
      `,
      params
    );

    // Reduce in JS rather than in SQL so the ranking rule (which of median and
    // weighted to trust, and how to break ties) lives in one readable place and
    // is unit-testable without a database.
    const grouped = new Map<string, { countryIso: string; category: string | null; total: bigint; count: number; contributors: number; samples: number }>();

    for (const row of result.rows) {
      const countryIso = String(row.country_iso);
      const category = String(row.category);
      const key = scope.kind === "country" ? category : countryIso;
      const median = toSafeBigInt(row.median_value ?? 0);
      const existing = grouped.get(key);
      if (existing) {
        existing.total += median;
        existing.count += 1;
        existing.contributors += Number(row.contributor_count ?? 0);
        existing.samples += Number(row.sample_count ?? 0);
      } else {
        grouped.set(key, {
          countryIso,
          category: scope.kind === "country" ? category : null,
          total: median,
          count: 1,
          contributors: Number(row.contributor_count ?? 0),
          samples: Number(row.sample_count ?? 0),
        });
      }
    }

    const all = [...grouped.values()].map((g) => {
      const mean = g.count === 0 ? 0n : g.total / BigInt(g.count);
      return {
        countryIso: g.countryIso,
        category: g.category,
        score: (scope.kind === "contributors" ? BigInt(g.samples) : mean).toString(),
        submissionCount: g.samples,
        contributorCount: g.contributors,
        medianIndex: mean.toString(),
      };
    });

    // `contributors` ranks by volume; the others rank by index value. The
    // trailing country/category columns make the order total, so equal scores
    // never reorder between identical requests.
    all.sort((a, b) => {
      if (scope.kind === "contributors") {
        const bySamples = Number(BigInt(b.submissionCount) - BigInt(a.submissionCount));
        if (bySamples !== 0) return bySamples;
      } else {
        const byScore = BigInt(b.score) === BigInt(a.score)
          ? 0
          : BigInt(b.score) > BigInt(a.score)
            ? 1
            : -1;
        if (byScore !== 0) return byScore;
      }
      return (
        a.countryIso.localeCompare(b.countryIso) ||
        (a.category ?? "").localeCompare(b.category ?? "")
      );
    });

    const total = all.length;
    const page = all.slice(offset, offset + limit).map((entry, index) => ({
      // Rank reflects the global position, not the position within the page, so
      // page 2 continues at page 1's next rank rather than restarting at 1.
      rank: offset + index + 1,
      ...entry,
    }));

    return {
      entries: page,
      total: Number(countResult.rows[0]?.total ?? total),
      scope,
      from,
      to,
      limit,
      offset,
      hasMore: offset + page.length < total,
    };
  }
}
