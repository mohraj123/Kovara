import { Router, Request, Response } from "express";
import {
  PostgresSubmissionFeed,
  SUBMISSION_STATUSES,
  SubmissionStatus,
} from "../../submissions/feed";

/**
 * Submission feed endpoints.
 *
 * Issue #659. `GET /submissions` supports `limit`/`offset` plus status, user,
 * and date filters; `GET /submissions/:id` returns one.
 *
 * Every filter is optional and combines with AND. An unrecognised `status` is a
 * 400 rather than being ignored — silently returning everything because a
 * client typo'd its filter is the failure mode most likely to go unnoticed,
 * because the response is a plausible-looking list.
 *
 * An empty feed is a 200 with `submissions: []` and `total: 0`. A 404 would
 * tell a client the endpoint does not exist, which is a different and much
 * stronger claim.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** ISO 3166-1 alpha-2. */
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

export function createSubmissionsRouter(feed: PostgresSubmissionFeed): Router {
  const router = Router();

  /**
   * GET /submissions
   * Query: status, submitter, country, category, from, to, limit, offset, summary
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

      const status = req.query.status ? String(req.query.status) : undefined;
      if (status && !SUBMISSION_STATUSES.includes(status as SubmissionStatus)) {
        res.status(400).json({
          error: `status must be one of: ${SUBMISSION_STATUSES.join(", ")}`,
          code: "INVALID_STATUS",
        });
        return;
      }

      const country = req.query.country ? String(req.query.country).toUpperCase() : undefined;
      if (country && !COUNTRY_PATTERN.test(country)) {
        res.status(400).json({
          error: "country must be an ISO 3166-1 alpha-2 code, e.g. NG",
          code: "INVALID_COUNTRY",
        });
        return;
      }

      // from/to are parsed here rather than by the driver, so a malformed date
      // is a 400 the caller can fix instead of a 500 from Postgres.
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

      const filters = {
        ...(status ? { status: status as SubmissionStatus } : {}),
        ...(req.query.submitter ? { submitter: String(req.query.submitter) } : {}),
        ...(country ? { countryIso: country } : {}),
        ...(req.query.category ? { category: String(req.query.category) } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      };

      const page = await feed.listSubmissions({ ...filters, limit: rawLimit, offset: rawOffset });

      // Opt-in: the breakdown costs a second query, and most callers paging
      // through a feed do not need it.
      const summary =
        req.query.summary === "true" ? await feed.summarizeStatuses(filters) : undefined;

      res.json({
        submissions: page.submissions,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        has_more: page.hasMore,
        ...(summary ? { summary } : {}),
      });
    }
  );

  /**
   * GET /submissions/:id
   * A single submission, or 404 when it does not exist.
   */
  router.get(
    "/:id",
    async (req: Request, res: Response): Promise<void> => {
      if (req.correlationId) res.set("X-Correlation-Id", req.correlationId);

      const id = String(req.params.id);
      if (id.trim() === "" || id.length > 200) {
        res.status(400).json({ error: "id must be a non-empty identifier", code: "INVALID_ID" });
        return;
      }

      const submission = await feed.getSubmission(id);
      if (!submission) {
        res.status(404).json({ error: "Submission not found", code: "NOT_FOUND" });
        return;
      }
      res.json(submission);
    }
  );

  return router;
}
