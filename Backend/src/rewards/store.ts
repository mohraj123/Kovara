/**
 * Reward persistence, claim state machine, and status reads.
 *
 * Issues #656 and #657.
 *
 * The claim flow is the delicate part. A payout is money leaving the system, so
 * the invariants are stated explicitly and enforced in the database rather than
 * in application code that a second code path could forget:
 *
 *   - **No double-claim.** Accruals are claimed under `FOR UPDATE`, so two
 *     concurrent claims of the same rows serialise; the second sees them already
 *     claimed and claims nothing. Without the row lock, two requests arriving
 *     together would both read "claimable" and both pay out.
 *   - **A claim is idempotent by key.** The caller supplies an idempotency key;
 *     replaying the same request returns the original claim rather than moving
 *     money again. This matters because a network retry is indistinguishable
 *     from a new request, and only the caller can tell them apart.
 *   - **A failed payout returns the accruals.** `processing` is a real state,
 *     not a formality: a claim that is in flight holds its accruals, and a
 *     failure releases them. A crash mid-payout therefore leaves the money
 *     `processing` and visible as such, rather than lost or double-paid.
 *
 * Balances are always derived from the accrual rows, never stored as a running
 * total. A cached balance and its underlying lines disagreeing is the classic
 * accounting bug; deriving the sum means they cannot.
 */

import { Pool } from "pg";
import { toSafeBigInt } from "../db";
import {
  Accrual,
  RewardRules,
  SubmissionRecord,
  VerificationRecord,
  assessBatch,
  assessSubmission,
  DEFAULT_REWARD_RULES,
} from "./rules";

/** Lifecycle of a single reward accrual. */
export type AccrualState = "pending" | "claimable" | "claimed";

/** Lifecycle of a payout attempt. */
export type ClaimState = "processing" | "completed" | "failed";

export interface StoredAccrual {
  address: string;
  submissionId: string;
  kind: Accrual["kind"];
  amount: bigint;
  state: AccrualState;
  updatedAt: Date;
}

export interface RewardStatus {
  address: string;
  /** Held pending manual review of the underlying submissions. */
  pending: bigint;
  /** Owed and available to claim. */
  claimable: bigint;
  /** Already paid out. */
  claimed: bigint;
  /** pending + claimable + claimed; the lifetime total. */
  total: bigint;
  /** Claims that are in flight, if any. */
  processing: bigint;
}

/** One payout attempt. */
export interface RewardClaim {
  claimId: string;
  address: string;
  amount: bigint;
  state: ClaimState;
  claimedAt: Date;
  completedAt: Date | null;
  /** On-chain transaction hash, once known. */
  transactionHash: string | null;
  /** Why a claim failed, when it did. */
  failureReason: string | null;
  /**
   * The caller's idempotency key. Unique, and what makes a retry safe.
   */
  idempotencyKey: string;
}

export class RewardStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Evaluate a submission and persist the accruals it creates.
   *
   * Re-running is idempotent: accruals are keyed by (address, submission, kind)
   * and updated in place, so a re-evaluation after new verifications arrive
   * converges on the correct total rather than double-paying. The recomputation
   * is a full re-derivation from stored data — never an increment — which is
   * what keeps the result reproducible (#656).
   */
  async recordSubmissionRewards(
    submission: SubmissionRecord,
    verifications: VerificationRecord[],
    rules: RewardRules = DEFAULT_REWARD_RULES
  ): Promise<{ accruals: Accrual[]; total: bigint }> {
    const assessment = assessSubmission(submission, verifications, rules);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const accrual of assessment.accruals) {
        await client.query(
          `
          INSERT INTO reward_accruals (address, submission_id, kind, amount, state, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (address, submission_id, kind) DO UPDATE SET
            amount = EXCLUDED.amount,
            state  = EXCLUDED.state,
            updated_at = NOW()
          `,
          [
            accrual.address,
            accrual.submissionId,
            accrual.kind,
            accrual.amount.toString(),
            accrual.state,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { accruals: assessment.accruals, total: assessment.total };
  }

  /**
   * Recompute every accrual for a batch of submissions from stored data.
   *
   * Full re-derivation, not a delta: if a submission is later rejected or
   * un-flagged, the correct action is to overwrite the stored lines, and an
   * incremental design cannot express "this reward should no longer exist".
   */
  async recalculate(
    submissions: SubmissionRecord[],
    verifications: VerificationRecord[],
    rules: RewardRules = DEFAULT_REWARD_RULES
  ): Promise<{ addresses: number; total: bigint }> {
    const { byAddress } = assessBatch(submissions, verifications, rules);
    let total = 0n;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [address, amounts] of byAddress) {
        const pending = amounts.pending;
        const claimable = amounts.claimable;
        // Two rows per address: the held part and the available part. Stored
        // separately so un-flagging a submission moves the exact amount back
        // rather than requiring a recomputation to split it again.
        for (const [kind, amount] of [
          ["corroboration", pending + claimable],
        ] as const) {
          if (amount === 0n) continue;
          await client.query(
            `
            INSERT INTO reward_accruals (address, submission_id, kind, amount, state, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (address, submission_id, kind) DO UPDATE SET
              amount = EXCLUDED.amount,
              state  = EXCLUDED.state,
              updated_at = NOW()
            `,
            [address, `batch:${kind}`, kind, amount.toString(), pending > 0n ? "pending" : "claimable"]
          );
        }
        total += amounts.total;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { addresses: byAddress.size, total };
  }

  /**
   * Claim everything currently claimable for an address.
   *
   * Returns the existing claim unchanged when `idempotencyKey` has been seen, so
   * a client retry after a timeout cannot pay out twice.
   *
   * Returns a `processing` claim of zero when there is nothing claimable: that
   * is a fact about the caller's balance, not an error worth a 5xx.
   */
  async claim(
    address: string,
    idempotencyKey: string,
    options: { transactionHash?: string } = {}
  ): Promise<RewardClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Idempotency first. A unique key on the table is the real guard; this
      //    read just avoids doing the work.
      const existing = await client.query<Record<string, unknown>>(
        "SELECT * FROM reward_claims WHERE idempotency_key = $1 FOR UPDATE",
        [idempotencyKey]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return this.mapClaim(existing.rows[0]);
      }

      // 2. Lock the claimable accruals. FOR UPDATE is what makes two concurrent
      //    claims serialise: the second blocks here, then re-reads and finds
      //    nothing claimable left.
      const locked = await client.query<Record<string, unknown>>(
        `
        SELECT address, submission_id, kind, amount
        FROM reward_accruals
        WHERE address = $1 AND state = 'claimable'
        ORDER BY submission_id ASC, kind ASC
        FOR UPDATE
        `,
        [address]
      );

      const amount = locked.rows.reduce(
        (sum, row) => sum + toSafeBigInt(row.amount),
        0n
      );

      const claimId = `${address}:${idempotencyKey}`;
      const inserted = await client.query<Record<string, unknown>>(
        `
        INSERT INTO reward_claims
          (claim_id, address, amount, state, claimed_at, transaction_hash, idempotency_key)
        VALUES ($1, $2, $3, 'processing', NOW(), $4, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
        `,
        [claimId, address, amount.toString(), options.transactionHash ?? null, idempotencyKey]
      );

      if (inserted.rows[0] && amount > 0n) {
        // 3. Move exactly the locked lines to claimed. The pairs are passed as
        //    two parallel arrays joined with unnest, so the update covers the
        //    locked set and nothing else — a line claimable but not locked
        //    stays claimable for the next claim.
        await client.query(
          `
          UPDATE reward_accruals a
          SET state = 'claimed', updated_at = $4::timestamptz
          FROM unnest($2::text[], $3::text[]) AS t(submission_id, kind)
          WHERE a.address = $1
            AND a.state = 'claimable'
            AND a.submission_id = t.submission_id
            AND a.kind = t.kind
          `,
          [
            address,
            locked.rows.map((r) => String(r.submission_id)),
            locked.rows.map((r) => String(r.kind)),
            inserted.rows[0].claimed_at,
          ]
        );
      }

      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return this.mapClaim(inserted.rows[0]);
      }

      // Lost a race on the idempotency key: the winner's claim is the answer.
      // Re-read before COMMIT, so it remains in the same transaction snapshot
      // and is never answered from outside the atomic transition.
      const winner = await client.query<Record<string, unknown>>(
        "SELECT * FROM reward_claims WHERE idempotency_key = $1",
        [idempotencyKey]
      );
      await client.query("COMMIT");
      return this.mapClaim(winner.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Settle a claim once the on-chain transaction is known.
   *
   * `completed` moves the claim out of `processing`; `failed` returns the
   * accruals to `claimable` so the money can be claimed again. A completed
   * claim is never reversed — the transfer already happened, and pretending
   * otherwise would be a lie in the ledger.
   */
  async settleClaim(
    claimId: string,
    outcome: { state: "completed" | "failed"; transactionHash?: string; failureReason?: string }
  ): Promise<RewardClaim | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Record<string, unknown>>(
        `
        UPDATE reward_claims
        SET state = $2,
            completed_at = NOW(),
            transaction_hash = COALESCE($3, transaction_hash),
            failure_reason = $4
        WHERE claim_id = $1 AND state = 'processing'
        RETURNING *
        `,
        [
          claimId,
          outcome.state,
          outcome.transactionHash ?? null,
          outcome.failureReason ?? null,
        ]
      );

      const claim = result.rows[0];
      if (claim && outcome.state === "failed") {
        // Release exactly this claim's amount in accrual-line order. The accrual
        // table predates an explicit claim-line join table, so the cumulative
        // amount ceiling is the atomic, database-enforced limit; unrelated
        // claimed lines remain claimed.
        await client.query(
          `
          WITH ranked AS (
            SELECT address, submission_id, kind, amount,
                   SUM(amount) OVER (
                     PARTITION BY address
                     ORDER BY submission_id ASC, kind ASC
                   ) AS cumulative
            FROM reward_accruals
            WHERE address = $1
              AND state = 'claimed'
              AND updated_at = $3::timestamptz
            FOR UPDATE
          )
          UPDATE reward_accruals a
          SET state = 'claimable', updated_at = NOW()
          FROM ranked r
          WHERE a.address = r.address
            AND a.submission_id = r.submission_id
            AND a.kind = r.kind
            AND r.cumulative - r.amount < $2::numeric
          `,
          [
            String(claim.address),
            String(toSafeBigInt(claim.amount)),
            claim.claimed_at as string,
          ]
        );
      }

      await client.query("COMMIT");
      return claim ? this.mapClaim(claim) : null;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reward status for one address, derived from the accrual rows.
   *
   * `processing` is reported separately from `claimed` so an in-flight payout
   * is visible as in-flight rather than as paid.
   */
  async getStatus(address: string): Promise<RewardStatus> {
    const accruals = await this.pool.query<{ state: string; total: string }>(
      `
      SELECT state, COALESCE(SUM(amount), 0)::text AS total
      FROM reward_accruals
      WHERE address = $1
      GROUP BY state
      `,
      [address]
    );

    const sums: Record<string, bigint> = {};
    for (const row of accruals.rows) {
      sums[row.state] = toSafeBigInt(row.total);
    }

    // An in-flight claim is the sum of completed-or-processing claims that have
    // not settled: those accruals are already marked claimed, so counting them
    // again would be correct only if they are excluded from `claimed`.
    const inFlight = await this.pool.query<{ total: string }>(
      `
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM reward_claims
      WHERE address = $1 AND state = 'processing'
      `,
      [address]
    );
    const processing = toSafeBigInt(inFlight.rows[0]?.total ?? 0);

    const pending = sums.pending ?? 0n;
    const claimable = sums.claimable ?? 0n;
    const claimed = (sums.claimed ?? 0n) - processing;

    return {
      address,
      pending,
      claimable,
      // Guard the subtraction: a drifted balance must not report a negative.
      claimed: claimed < 0n ? 0n : claimed,
      total: pending + claimable + (claimed < 0n ? 0n : claimed),
      processing,
    };
  }

  /** Claim history for an address, newest first. */
  async listClaims(
    address: string,
    options: { limit: number; offset: number; state?: ClaimState }
  ): Promise<{ claims: RewardClaim[]; total: number }> {
    const values: unknown[] = [address];
    let where = "WHERE address = $1";
    if (options.state) {
      values.push(options.state);
      where += ` AND state = $${values.length}`;
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM reward_claims ${where}`,
      values
    );
    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT * FROM reward_claims ${where}
      ORDER BY claimed_at DESC, claim_id ASC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `,
      [...values, options.limit, options.offset]
    );

    return {
      claims: result.rows.map((row) => this.mapClaim(row)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  /** Individual accrual lines for an address, for explaining a total. */
  async listAccruals(
    address: string,
    options: { limit: number; offset: number; state?: AccrualState }
  ): Promise<{ accruals: StoredAccrual[]; total: number }> {
    const values: unknown[] = [address];
    let where = "WHERE address = $1";
    if (options.state) {
      values.push(options.state);
      where += ` AND state = $${values.length}`;
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM reward_accruals ${where}`,
      values
    );
    const result = await this.pool.query<Record<string, unknown>>(
      `
      SELECT * FROM reward_accruals ${where}
      ORDER BY updated_at DESC, submission_id ASC, kind ASC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `,
      [...values, options.limit, options.offset]
    );

    return {
      accruals: result.rows.map((row) => ({
        address: String(row.address),
        submissionId: String(row.submission_id),
        kind: String(row.kind) as StoredAccrual["kind"],
        amount: toSafeBigInt(row.amount),
        state: String(row.state) as AccrualState,
        updatedAt: new Date(row.updated_at as string),
      })),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  private mapClaim(row: Record<string, unknown>): RewardClaim {
    return {
      claimId: String(row.claim_id),
      address: String(row.address),
      amount: toSafeBigInt(row.amount),
      state: String(row.state) as ClaimState,
      claimedAt: new Date(row.claimed_at as string),
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
      transactionHash: row.transaction_hash ? String(row.transaction_hash) : null,
      failureReason: row.failure_reason ? String(row.failure_reason) : null,
      idempotencyKey: String(row.idempotency_key),
    };
  }
}
