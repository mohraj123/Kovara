import { Router, Request, Response } from "express";
import {
  LeaderboardScope,
  PostgresAnalyticsStore,
  QueryValidationError,
} from "./store";

/**
 * Historical index and country leaderboard endpoints.
 *
 * Issues #654 and #655. Both read the daily aggregates written by the
 * aggregation job; neither computes anything at request time, so a chart or a
 * leaderboard is as expensive to serve as a single indexed row.
 *
 * Error handling is uniform: a {@link QueryValidationError} carries a message
 * written for the caller ("limit cannot exceed 100") and becomes a 400 with a
 * matching `code`; anything else is left to the app-level handler, which
 * returns a generic 500 rather than leaking a database error.
 *
 * An empty result is a 200 with an empty list and `total: 0`, never a 404. A
 * country that has no submissions yet is a fact about the world the caller
 * needs to distinguish from a malformed request.
 */
export function createIndexRouter(store: PostgresAnalyticsStore): Router {
  const router = Router();

  /**
   * GET /index/history
   * Query: country, category, from, to, limit, offset
   *
   * Historical index values, newest first.
   */
  router.get(
    "/history",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const page = await store.getIndexHistory({
          ...(req.query.country ? { countryIso: String(req.query.country) } : {}),
          ...(req.query.category ? { category: String(req.query.category) } : {}),
          ...(req.query.from ? { from: String(req.query.from) } : {}),
          ...(req.query.to ? { to: String(req.query.to) } : {}),
          limit: req.query.limit as unknown as number,
          offset: req.query.offset as unknown as number,
        });

        res.json({
          entries: page.entries,
          total: page.total,
          limit: page.limit,
          offset: page.offset,
          has_more: page.hasMore,
        });
      } catch (err) {
        if (err instanceof QueryValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    }
  );

  /**
   * GET /index/leaderboard
   * Query: country, scope=global|contributors, from, to, limit, offset
   *
   * Ranks countries by their published index value over the window, or by
   * contribution volume when `scope=contributors`. Passing `country` ranks that
   * country's own categories instead.
   */
  router.get(
    "/leaderboard",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const scopeParam = req.query.scope ? String(req.query.scope) : "global";
        const countryParam = req.query.country ? String(req.query.country) : undefined;

        let scope: LeaderboardScope;
        if (countryParam) {
          scope = { kind: "country", countryIso: countryParam };
        } else if (scopeParam === "contributors") {
          scope = { kind: "contributors" };
        } else if (scopeParam === "global") {
          scope = { kind: "global" };
        } else {
          throw new QueryValidationError(
            "scope must be one of: global, contributors",
            "INVALID_SCOPE"
          );
        }

        const page = await store.getLeaderboard(scope, {
          ...(req.query.from ? { from: String(req.query.from) } : {}),
          ...(req.query.to ? { to: String(req.query.to) } : {}),
          limit: req.query.limit as unknown as number,
          offset: req.query.offset as unknown as number,
        });

        res.json({
          entries: page.entries,
          total: page.total,
          scope: page.scope.kind,
          from: page.from,
          to: page.to,
          limit: page.limit,
          offset: page.offset,
          has_more: page.hasMore,
        });
      } catch (err) {
        if (err instanceof QueryValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    }
  );

  /**
   * GET /index/:country/:category/decisions?date=YYYY-MM-DD
   *
   * The filter decisions behind a published index value (#653). Every
   * observation considered, whether it was included, and the threshold that
   * excluded it — so "why is this country off" is answerable from the API
   * rather than by re-running the aggregation and diffing.
   */
  router.get(
    "/:country/:category/decisions",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const dateParam = req.query.date ? String(req.query.date) : undefined;
        if (!dateParam) {
          throw new QueryValidationError(
            "date is required (YYYY-MM-DD)",
            "MISSING_DATE"
          );
        }
        const decisions = await store.getFilterDecisions(
          String(req.params.country),
          String(req.params.category),
          dateParam
        );

        res.json({
          country: String(req.params.country).toUpperCase(),
          category: String(req.params.category),
          date: dateParam,
          decisions,
          total: decisions.length,
        });
      } catch (err) {
        if (err instanceof QueryValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    }
  );

  return router;
}
