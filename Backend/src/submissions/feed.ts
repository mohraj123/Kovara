/**
 * Submission feed: filters, pagination, and the query that backs them.
 *
 * Issue #659. The acceptance criteria name status, user, and date filters, and
 * ask that empty and large results behave predictably — so both are handled
 * explicitly rather than left to whatever Postgres does.
 *
 * `offset` pagination is used, matching every other list endpoint in this API.
 * It is not the right choice for a continuously-written feed: rows inserted
 * during a walk shift the window, so a client paging through can see a record
 * twice or miss one. The total ordering below is what makes offset paging
 * *consistent* for a stable snapshot, and the README notes the cursor
 * alternative. Switching later means adding a route, not changing this one.
 */

import { Pool } from "pg";

/** The states a submission can be in. */
export type SubmissionStatus = "pending" | "verified" | "rejected";

/** The statuses a feed may be filtered to. */
export const SUBMISSION_STATUSES: SubmissionStatus[] = ["pending", "verified", "rejected"];

/** One submission as the feed returns it. */
export interface Submission {
  id: string;
  submitter: string;
  status: SubmissionStatus;
  countryIso: string | null;
  category: string | null;
  /** Decimal string: an i128-scaled value does not survive a JSON number. */
  value: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  submittedAt: string;
  updatedAt: string;
}

/** Filters accepted by {@link PostgresSubmissionFeed.listSubmissions}. */
export interface SubmissionQuery {
  status?: SubmissionStatus;
  submitter?: string;
  countryIso?: string;
  category?: string;
  /** Inclusive lower bound on `submitted_at`. */
  from?: Date;
  /** Inclusive upper bound on `submitted_at`. */
  to?: Date;
  limit: number;
  offset: number;
}

/** A paginated page. */
export interface SubmissionPage {
  submissions: Submission[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export class PostgresSubmissionFeed {
  constructor(private readonly pool: Pool) {}

  /**
   * Filtered, paginated submission list, newest first.
   *
   * Filters bind as parameters into an AND list, so no value can reach the SQL
   * text. An empty result is `{ submissions: [], total: 0, has_more: false }`,
   * not an error: a feed with nothing in it is a normal answer.
   */
  async listSubmissions(query: SubmissionQuery): Promise<SubmissionPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const add = (clause: (index: number) => string, value: unknown): void => {
      params.push(value);
      conditions.push(clause(params.length));
    };

    if (query.status) add((i) => `status = $${i}`, query.status);
    if (query.submitter) add((i) => `submitter = $${i}`, query.submitter);
    if (query.countryIso) add((i) => `country_iso = $${i}`, query.countryIso);
    if (query.category) add((i) => `category = $${i}`, query.category);
    if (query.from) add((i) => `submitted_at >= $${i}`, query.from);
    if (query.to) add((i) => `submitted_at <= $${i}`, query.to);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM submissions ${where}`,
      params
    );
    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT id, submitter, status, country_iso, category, value,
             verified_by, verified_at, submitted_at, updated_at
      FROM submissions
      ${where}
      ORDER BY submitted_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, query.limit, query.offset]
    );

    const total = Number(countResult.rows[0]?.total ?? 0);
    return {
      submissions: result.rows.map((row) => ({
        id: String(row.id),
        submitter: String(row.submitter),
        status: String(row.status) as SubmissionStatus,
        countryIso: row.country_iso ? String(row.country_iso) : null,
        category: row.category ? String(row.category) : null,
        value: String(row.value),
        verifiedBy: row.verified_by ? String(row.verified_by) : null,
        verifiedAt: row.verified_at ? new Date(row.verified_at as string).toISOString() : null,
        submittedAt: new Date(row.submitted_at as string).toISOString(),
        updatedAt: new Date(row.updated_at as string).toISOString(),
      })),
      total,
      limit: query.limit,
      offset: query.offset,
      // Derived from the returned row count, so the final page reports false
      // even when the total is an exact multiple of the page size.
      hasMore: query.offset + result.rows.length < total,
    };
  }

  /**
   * A status breakdown over the same filters, minus `status` itself.
   *
   * A feed with a status filter applied cannot usefully show a status summary —
   * it would only ever report the one status that was filtered to. Excluding
   * the filter makes the summary describe the whole filtered set, which is the
   * thing a caller actually wants to see next to the rows.
   */
  async summarizeStatuses(
    query: Omit<SubmissionQuery, "status" | "limit" | "offset">
  ): Promise<Record<SubmissionStatus, number>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const add = (clause: (index: number) => string, value: unknown): void => {
      params.push(value);
      conditions.push(clause(params.length));
    };

    if (query.submitter) add((i) => `submitter = $${i}`, query.submitter);
    if (query.countryIso) add((i) => `country_iso = $${i}`, query.countryIso);
    if (query.category) add((i) => `category = $${i}`, query.category);
    if (query.from) add((i) => `submitted_at >= $${i}`, query.from);
    if (query.to) add((i) => `submitted_at <= $${i}`, query.to);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*)::int AS count FROM submissions ${where} GROUP BY status`,
      params
    );

    const summary: Record<SubmissionStatus, number> = {
      pending: 0,
      verified: 0,
      rejected: 0,
    };
    for (const row of result.rows) {
      const status = String(row.status) as SubmissionStatus;
      if (status in summary) summary[status] = Number(row.count);
    }
    return summary;
  }

  /**
   * A single submission, or null.
   *
   * Returns null rather than throwing for a missing id so the route can decide
   * between 404 and an empty body.
   */
  async getSubmission(id: string): Promise<Submission | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT id, submitter, status, country_iso, category, value,
             verified_by, verified_at, submitted_at, updated_at
      FROM submissions WHERE id = $1
      `,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      submitter: String(row.submitter),
      status: String(row.status) as SubmissionStatus,
      countryIso: row.country_iso ? String(row.country_iso) : null,
      category: row.category ? String(row.category) : null,
      value: String(row.value),
      verifiedBy: row.verified_by ? String(row.verified_by) : null,
      verifiedAt: row.verified_at ? new Date(row.verified_at as string).toISOString() : null,
      submittedAt: new Date(row.submitted_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    };
  }
}
