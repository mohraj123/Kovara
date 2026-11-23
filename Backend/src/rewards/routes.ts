import { Router, Request, Response } from "express";
import { RewardStore, AccrualState, ClaimState } from "./store";
import { isValidAddress } from "./rules";

/**
 * Reward status and claim endpoints.
 *
 * Issue #657. Three read paths and one write:
 *
 *   GET  /rewards/:address          status, derived from accrual rows
 *   GET  /rewards/:address/claims   claim history, newest first
 *   GET  /rewards/:address/accruals the lines behind the total
 *   POST /rewards/:address/claim    claim everything claimable
 *
 * The write endpoint requires an idempotency key. That is not ceremony: a
 * client that times out mid-request cannot tell whether the payout landed, and
 * a retry must be safe by default rather than by the client remembering. The key
 * is required rather than generated so a retry reuses the same one.
 *
 * A claim with nothing claimable returns 200 with a zero-amount `processing`
 * claim. That is a statement about the caller's balance, not a server fault, and
 * turning it into a 409 would make a correct client treat a legitimate state as
 * an error.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** Parse limit/offset with the same bounds the rest of the API uses. */
function parsePagination(req: Request, res: Response): { limit: number; offset: number } | null {
  const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_LIMIT;
  const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : 0;

  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    res.status(400).json({ error: "limit must be a positive integer", code: "INVALID_QUERY" });
    return null;
  }
  if (rawLimit > MAX_LIMIT) {
    res.status(400).json({ error: `limit cannot exceed ${MAX_LIMIT}`, code: "LIMIT_EXCEEDED" });
    return null;
  }
  if (!Number.isInteger(rawOffset) || rawOffset < 0) {
    res.status(400).json({ error: "offset must be a non-negative integer", code: "INVALID_QUERY" });
    return null;
  }
  return { limit: rawLimit, offset: rawOffset };
}

/** Reject a malformed address before it reaches the database. */
function requireAddress(req: Request, res: Response): string | null {
  const address = String(req.params.address ?? "");
  if (!isValidAddress(address)) {
    res.status(400).json({ error: "address must be a Stellar address", code: "INVALID_ADDRESS" });
    return null;
  }
  return address;
}

export function createRewardsRouter(store: RewardStore): Router {
  const router = Router();

  /**
   * GET /rewards/:address
   * Reward status: pending, claimable, claimed, and any in-flight payout.
   *
   * All amounts are decimal strings. A reward total in the smallest unit
   * routinely exceeds 2^53-1, and a JSON number would silently round it.
   */
  router.get(
    "/:address",
    async (req: Request, res: Response): Promise<void> => {
      if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);

      const address = requireAddress(req, res);
      if (address === null) return;

      const status = await store.getStatus(address);
      res.json({
        address: status.address,
        pending: status.pending.toString(),
        claimable: status.claimable.toString(),
        claimed: status.claimed.toString(),
        processing: status.processing.toString(),
        total: status.total.toString(),
      });
    }
  );

  /**
   * GET /rewards/:address/claims?state=&limit=&offset=
   * Claim history, newest first. Optionally filtered by claim state.
   */
  router.get(
    "/:address/claims",
    async (req: Request, res: Response): Promise<void> => {
      if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);

      const address = requireAddress(req, res);
      if (address === null) return;

      const page = parsePagination(req, res);
      if (page === null) return;

      const stateParam = typeof req.query.state === "string" ? req.query.state : undefined;
      const valid: ClaimState[] = ["processing", "completed", "failed"];
      if (stateParam && !valid.includes(stateParam as ClaimState)) {
        res.status(400).json({
          error: `state must be one of: ${valid.join(", ")}`,
          code: "INVALID_STATE",
        });
        return;
      }

      const { claims, total } = await store.listClaims(address, {
        ...page,
        ...(stateParam ? { state: stateParam as ClaimState } : {}),
      });

      res.json({
        claims: claims.map((claim) => ({
          claim_id: claim.claimId,
          address: claim.address,
          amount: claim.amount.toString(),
          state: claim.state,
          claimed_at: claim.claimedAt.toISOString(),
          completed_at: claim.completedAt ? claim.completedAt.toISOString() : null,
          transaction_hash: claim.transactionHash,
          failure_reason: claim.failureReason,
        })),
        total,
        limit: page.limit,
        offset: page.offset,
        has_more: page.offset + claims.length < total,
      });
    }
  );

  /**
   * GET /rewards/:address/accruals?state=&limit=&offset=
   * The individual lines behind a status total, so any number is explainable.
   */
  router.get(
    "/:address/accruals",
    async (req: Request, res: Response): Promise<void> => {
      if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);

      const address = requireAddress(req, res);
      if (address === null) return;

      const page = parsePagination(req, res);
      if (page === null) return;

      const stateParam = typeof req.query.state === "string" ? req.query.state : undefined;
      const valid: AccrualState[] = ["pending", "claimable", "claimed"];
      if (stateParam && !valid.includes(stateParam as AccrualState)) {
        res.status(400).json({
          error: `state must be one of: ${valid.join(", ")}`,
          code: "INVALID_STATE",
        });
        return;
      }

      const { accruals, total } = await store.listAccruals(address, {
        ...page,
        ...(stateParam ? { state: stateParam as AccrualState } : {}),
      });

      res.json({
        accruals: accruals.map((accrual) => ({
          submission_id: accrual.submissionId,
          kind: accrual.kind,
          amount: accrual.amount.toString(),
          state: accrual.state,
          updated_at: accrual.updatedAt.toISOString(),
        })),
        total,
        limit: page.limit,
        offset: page.offset,
        has_more: page.offset + accruals.length < total,
      });
    }
  );

  /**
   * POST /rewards/:address/claim
   * Body: { idempotency_key: string, transaction_hash?: string }
   *
   * Idempotency key is required. Reusing a key returns the original claim and
   * moves no money, which is what makes a client retry safe.
   */
  router.post(
    "/:address/claim",
    async (req: Request, res: Response): Promise<void> => {
      if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);

      const address = requireAddress(req, res);
      if (address === null) return;

      const body = (req.body ?? {}) as {
        idempotency_key?: unknown;
        transaction_hash?: unknown;
      };

      const idempotencyKey =
        typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
      if (idempotencyKey === "") {
        res.status(400).json({
          error: "idempotency_key is required so a retry cannot pay out twice",
          code: "MISSING_IDEMPOTENCY_KEY",
        });
        return;
      }
      if (idempotencyKey.length > 200) {
        res.status(400).json({
          error: "idempotency_key cannot exceed 200 characters",
          code: "INVALID_QUERY",
        });
        return;
      }

      const transactionHash =
        typeof body.transaction_hash === "string" && body.transaction_hash.trim() !== ""
          ? body.transaction_hash.trim()
          : undefined;

      const claim = await store.claim(address, idempotencyKey, {
        ...(transactionHash ? { transactionHash } : {}),
      });

      // 200, not 201 and not 409: a claim is a request that was accepted, and
      // the same key always yields the same claim. A retry of an existing claim
      // is a success, not a conflict.
      res.status(200).json({
        claim_id: claim.claimId,
        address: claim.address,
        amount: claim.amount.toString(),
        state: claim.state,
        claimed_at: claim.claimedAt.toISOString(),
        completed_at: claim.completedAt ? claim.completedAt.toISOString() : null,
        transaction_hash: claim.transactionHash,
      });
    }
  );

  return router;
}
