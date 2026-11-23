import { Router, Request, Response } from "express";
import { AuditStore } from "./store";
import { AuditAction, AuditOutcome } from "./chain";

/**
 * Audit read API.
 *
 * Issue #658. Exposes the trail with filtering and pagination, plus an explicit
 * integrity check.
 *
 * Every entry carries its own hash and its predecessor's, so a client can
 * verify a page locally without trusting this server. `GET /audit/:stream/verify`
 * does the same server-side over the whole stream, which is the authoritative
 * answer for "has this history been tampered with".
 *
 * Ordering is `occurred_at DESC, id DESC` — total, so a paginated walk cannot
 * skip or repeat an entry when many share a timestamp.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** The action and outcome values the API accepts, mirroring the chain types. */
const ACTIONS: AuditAction[] = [
  "contract.deployed",
  "contract.upgraded",
  "event.observed",
  "event.processed",
  "event.failed",
  "event.replayed",
  "submission.received",
  "submission.verified",
  "submission.rejected",
  "reward.accrued",
  "reward.claimed",
  "reward.failed",
];

const OUTCOMES: AuditOutcome[] = ["success", "failure", "skipped"];

export function createAuditRouter(store: AuditStore): Router {
  const router = Router();

  /**
   * GET /audit
   * Query: stream, action, outcome, subject, actor, ledger, from, to, limit, offset
   */
  router.get(
    "/",
    async (req: Request, res: Response): Promise<void> => {
      if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);

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

      const action = req.query.action ? String(req.query.action) : undefined;
      if (action && !ACTIONS.includes(action as AuditAction)) {
        res.status(400).json({ error: `action must be one of: ${ACTIONS.join(", ")}`, code: "INVALID_ACTION" });
        return;
      }
      const outcome = req.query.outcome ? String(req.query.outcome) : undefined;
      if (outcome && !OUTCOMES.includes(outcome as AuditOutcome)) {
        res.status(400).json({ error: `outcome must be one of: ${OUTCOMES.join(", ")}`, code: "INVALID_OUTCOME" });
        return;
      }

      // Date bounds are parsed once and rejected loudly, rather than being
      // handed to Postgres where an unparseable string becomes a 500 from the
      // driver instead of a 400 the caller can act on.
      const from = req.query.from ? new Date(String(req.query.from)) : undefined;
      if (from && Number.isNaN(from.getTime())) {
        res.status(400).json({ error: "from must be an ISO 8601 timestamp", code: "INVALID_DATE" });
        return;
      }
      const to = req.query.to ? new Date(String(req.query.to)) : undefined;
      if (to && Number.isNaN(to.getTime())) {
        res.status(400).json({ error: "to must be an ISO 8601 timestamp", code: "INVALID_DATE" });
        return;
      }
      if (from && to && from > to) {
        res.status(400).json({ error: "from must not be after to", code: "INVALID_RANGE" });
        return;
      }

      const ledger =
        req.query.ledger !== undefined ? Number(req.query.ledger) : undefined;
      if (ledger !== undefined && !Number.isInteger(ledger)) {
        res.status(400).json({ error: "ledger must be an integer", code: "INVALID_QUERY" });
        return;
      }

      const page = await store.listEntries({
        ...(req.query.stream ? { stream: String(req.query.stream) } : {}),
        ...(action ? { action: action as AuditAction } : {}),
        ...(outcome ? { outcome: outcome as AuditOutcome } : {}),
        ...(req.query.subject ? { subject: String(req.query.subject) } : {}),
        ...(req.query.actor ? { actor: String(req.query.actor) } : {}),
        ...(ledger !== undefined ? { ledger } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit: rawLimit,
        offset: rawOffset,
      });

      res.json({
        entries: page.entries.map(serializeEntry),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        has_more: page.hasMore,
      });
    }
  );

  /**
   * GET /audit/:stream/verify
   *
   * Recomputes the chain for a stream and reports the first entry that does not
   * verify. Reads the whole stream, so it is a maintenance or on-demand call
   * rather than something to put behind a request path.
   */
  router.get(
    "/:stream/verify",
    async (req: Request, res: Response): Promise<void> => {
      if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);

      const result = await store.verify(String(req.params.stream));
      res.json({
        stream: result.stream,
        valid: result.valid,
        checked: result.checked,
        broken_at: result.brokenAt,
        reason: result.reason,
      });
    }
  );

  return router;
}

/** Public shape of an audit entry. */
function serializeEntry(entry: {
  id: string;
  stream: string;
  action: string;
  actor: { kind: string; address?: string; component?: string };
  outcome: string;
  subject: string;
  ledger?: number;
  transactionHash?: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  hash: string;
  previousHash: string;
}): Record<string, unknown> {
  return {
    id: entry.id,
    stream: entry.stream,
    action: entry.action,
    actor: entry.actor,
    outcome: entry.outcome,
    subject: entry.subject,
    ledger: entry.ledger ?? null,
    transaction_hash: entry.transactionHash ?? null,
    // The context is returned verbatim: a forensic reviewer needs the detail
    // that was captured at the time, not a summary chosen by the reader.
    metadata: entry.metadata,
    occurred_at: entry.occurredAt.toISOString(),
    hash: entry.hash,
    previous_hash: entry.previousHash,
  };
}
