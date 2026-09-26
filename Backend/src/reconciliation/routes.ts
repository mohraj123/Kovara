import { Router, Request, Response } from "express";
import { ReconciliationQueryStore } from "./stores";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/**
 * Reconciliation reporting surface (#669).
 *
 * The job records what it checked; these endpoints make that visible. A
 * data-integrity check whose only output is a log line is invisible to anyone
 * without log access, and un-queryable even then.
 *
 *   GET /reconciliation/runs                 — recent runs, newest first
 *   GET /reconciliation/runs/:runDate        — one run with its discrepancies
 *
 * An empty run list is a `200` with `total: 0`: a fresh deployment has not
 * reconciled anything yet, which is not an error. A missing *specific* run is a
 * `404`, because the caller named a day that should have a result.
 */
export function createReconciliationRouter(store: ReconciliationQueryStore): Router {
  const router = Router();

  router.get("/runs", async (req: Request, res: Response): Promise<void> => {
    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_LIMIT;
    const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : 0;

    if (!Number.isInteger(rawLimit) || rawLimit < 1) {
      res.status(400).json({ error: "limit must be a positive integer", code: "INVALID_QUERY" });
      return;
    }
    if (rawLimit > MAX_LIMIT) {
      res.status(400).json({ error: `limit cannot exceed ${MAX_LIMIT}`, code: "LIMIT_EXCEEDED" });
      return;
    }
    if (!Number.isInteger(rawOffset) || rawOffset < 0) {
      res.status(400).json({ error: "offset must be a non-negative integer", code: "INVALID_QUERY" });
      return;
    }

    const { runs, total } = await store.listRuns(rawLimit, rawOffset);

    res.json({
      runs,
      total,
      limit: rawLimit,
      offset: rawOffset,
      has_more: rawOffset + runs.length < total,
    });
  });

  router.get("/runs/:runDate", async (req: Request, res: Response): Promise<void> => {
    const runDate = String(req.params.runDate);

    // Shape-check before hitting the database: a malformed date would otherwise
    // reach a `$1::date` cast and fail as a 500.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
      res.status(400).json({
        error: "runDate must be an ISO date (YYYY-MM-DD)",
        code: "INVALID_DATE",
      });
      return;
    }

    const result = await store.getRun(runDate);
    if (!result) {
      res.status(404).json({ error: "Reconciliation run not found", code: "NOT_FOUND" });
      return;
    }

    res.json({ ...result.run, discrepancies: result.discrepancies });
  });

  return router;
}
