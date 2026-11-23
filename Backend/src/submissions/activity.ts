import { Pool } from "pg";

export type ActivityKind = "submission" | "vote";
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  occurredAt: string;
  submissionId: string;
  details: Record<string, string>;
}
export interface ActivityPage {
  address: string;
  activities: ActivityItem[];
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

/** Chronological contributor activity from indexed submissions and votes. */
export class PostgresActivityFeed {
  constructor(private readonly pool: Pool) {}

  async list(address: string, limit: number, offset: number): Promise<ActivityPage> {
    const count = await this.pool.query<{ total: string }>(
      `SELECT (SELECT COUNT(*) FROM submissions WHERE submitter = $1) +
              (SELECT COUNT(*) FROM verifications WHERE verifier = $1) AS total`,
      [address]
    );
    const total = Number(count.rows[0]?.total ?? 0);
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id, kind, occurred_at, submission_id, details FROM (
         SELECT 'submission:' || id AS id, 'submission' AS kind, submitted_at AS occurred_at,
                id AS submission_id, jsonb_build_object('status', status, 'value', value::text) AS details
         FROM submissions WHERE submitter = $1
         UNION ALL
         SELECT 'vote:' || submission_id || ':' || verifier AS id, 'vote' AS kind,
                recorded_at AS occurred_at, submission_id,
                jsonb_build_object('verdict', verdict) AS details
         FROM verifications WHERE verifier = $1
       ) activity
       ORDER BY occurred_at DESC, kind ASC, id ASC
       LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );
    return {
      address,
      activities: result.rows.map((row) => ({
        id: String(row.id), kind: row.kind as ActivityKind,
        occurredAt: new Date(row.occurred_at as string).toISOString(),
        submissionId: String(row.submission_id), details: row.details as Record<string, string>,
      })),
      limit, offset, total, hasMore: offset + result.rows.length < total,
    };
  }
}
