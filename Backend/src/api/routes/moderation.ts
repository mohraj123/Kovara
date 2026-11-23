import { Router, Request, Response } from "express";
import { ApiErrorResponse, PaginationResponse } from "../contracts";
import {
  DEFAULT_LIMIT,
  ModerationError,
  ModerationStore,
  parseAction,
  parseSeverity,
  parseStatus,
  parseSubject,
} from "../../verification/moderation";
import type {
  CaseFilters,
  ModerationAction,
  ModerationCase,
  ModerationStatus,
} from "../../verification/moderation";

/**
 * Moderation endpoints (issue #645).
 *
 * Thin HTTP layer over `ModerationStore`: parse, delegate, translate. Every
 * rule — valid transitions, required assignee, required text — lives in the
 * store, so the same rules apply to a future operator CLI or a direct call from
 * another route.
 */

interface CaseResponse {
  case: ModerationCase;
}

interface CaseListResponse extends PaginationResponse {
  cases: ModerationCase[];
  total: number;
}

interface ActionLogResponse extends PaginationResponse {
  actions: ModerationAction[];
  total: number;
}

function readQueryFilters(query: Request["query"]): CaseFilters {
  const filters: CaseFilters = {};
  if (query.status !== undefined) filters.status = parseStatus(query.status);
  if (query.subject !== undefined) filters.subject = parseSubject(query.subject);
  if (typeof query.subjectId === "string") filters.subjectId = query.subjectId;
  if (typeof query.assignedTo === "string") filters.assignedTo = query.assignedTo;
  if (query.limit !== undefined) filters.limit = Number(query.limit);
  if (query.offset !== undefined) filters.offset = Number(query.offset);
  return filters;
}

function readWindow(query: Request["query"]): { limit: number; offset: number } {
  return {
    limit: typeof query.limit === "string" ? Number(query.limit) : DEFAULT_LIMIT,
    offset: typeof query.offset === "string" ? Number(query.offset) : 0,
  };
}

/** Echo the correlation id so a client can tie a 4xx back to the server log. */
function echoCorrelationId(req: Request, res: Response): void {
  if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);
}

/** Translate a store error into an HTTP response. */
function fail(res: Response, err: unknown): void {
  if (err instanceof ModerationError) {
    res.status(err.status).json({ error: err.message, code: err.code } as ApiErrorResponse);
    return;
  }
  throw err;
}

export function createModerationRouter(store: ModerationStore): Router {
  const router = Router();

  /**
   * GET /moderation/cases?status=&subject=&subjectId=&assignedTo=&limit=&offset=
   * Lists cases newest-first. `total` reflects the filter, not the page.
   */
  router.get(
    "/cases",
    (req: Request, res: Response<CaseListResponse | ApiErrorResponse>): void => {
      echoCorrelationId(req, res);

      const window = readWindow(req.query);
      let result;
      try {
        // `readQueryFilters` re-reads limit/offset so the store's own validation
        // stays the single gate on paging; `window` is only the echoed values.
        result = store.list(readQueryFilters(req.query));
      } catch (err) {
        fail(res, err);
        return;
      }

      res.json({
        cases: result.cases,
        total: result.total,
        limit: window.limit,
        offset: window.offset,
        has_more: window.offset + result.cases.length < result.total,
      });
    }
  );

  /**
   * POST /moderation/cases
   * Body: { subject, subjectId, reason, severity?, actor }
   * Opens a fraud-review case. Returns 201.
   */
  router.post(
    "/cases",
    (req: Request, res: Response<CaseResponse | ApiErrorResponse>): void => {
      echoCorrelationId(req, res);

      const body = req.body ?? {};
      try {
        const created = store.create({
          subject: parseSubject(body.subject),
          subjectId: body.subjectId,
          reason: body.reason,
          ...(body.severity !== undefined ? { severity: parseSeverity(body.severity) } : {}),
          actor: body.actor,
        });
        res.status(201).json({ case: created });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  /**
   * GET /moderation/cases/:caseId
   * Returns one case with its full action log.
   */
  router.get(
    "/cases/:caseId",
    (req: Request, res: Response<CaseResponse | ApiErrorResponse>): void => {
      echoCorrelationId(req, res);

      try {
        res.json({ case: store.get(req.params.caseId) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  /**
   * POST /moderation/cases/:caseId/transitions
   * Body: { to, actor, note?, assignedTo? }
   *
   * Returns 409 when the transition is not legal from the current status —
   * a 400 would suggest the request was malformed, when in fact it was a
   * well-formed request for something the case's current state does not allow.
   */
  router.post(
    "/cases/:caseId/transitions",
    (req: Request, res: Response<CaseResponse | ApiErrorResponse>): void => {
      echoCorrelationId(req, res);

      const body = req.body ?? {};
      try {
        const to: ModerationStatus = parseStatus(body.to);
        const updated = store.transition(req.params.caseId, to, body.actor, {
          note: body.note,
          assignedTo: body.assignedTo,
        });
        res.json({ case: updated });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  /**
   * POST /moderation/cases/:caseId/actions
   * Body: { action, actor, note? }
   *
   * Records an action. `escalate` / `resolve` / `dismiss` additionally move the
   * case, so an action cannot be logged without the case reflecting it.
   */
  router.post(
    "/cases/:caseId/actions",
    (req: Request, res: Response<CaseResponse | ApiErrorResponse>): void => {
      echoCorrelationId(req, res);

      const body = req.body ?? {};
      try {
        const action = parseAction(body.action);
        const updated = store.recordAction(req.params.caseId, action, body.actor, {
          note: body.note,
        });
        res.json({ case: updated });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  /**
   * GET /moderation/actions?limit=&offset=
   * Flattened action history across every case, newest first — the audit view.
   */
  router.get(
    "/actions",
    (req: Request, res: Response<ActionLogResponse | ApiErrorResponse>): void => {
      echoCorrelationId(req, res);

      const window = readWindow(req.query);
      try {
        const result = store.actionLog(window.limit, window.offset);
        res.json({
          actions: result.actions,
          total: result.total,
          limit: window.limit,
          offset: window.offset,
          has_more: window.offset + result.actions.length < result.total,
        });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  return router;
}
