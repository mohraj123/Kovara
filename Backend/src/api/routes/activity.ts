import { Router, Request, Response } from "express";
import { PostgresActivityFeed } from "../../submissions/activity";

export function createActivityRouter(feed: PostgresActivityFeed): Router {
  const router = Router();
  router.get("/:address", async (req: Request, res: Response): Promise<void> => {
    const { address } = req.params;
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!/^G[A-Z2-7]{55}$/.test(address)) {
      res.status(400).json({ error: "address must be a valid Stellar public key", code: "INVALID_ADDRESS" });
      return;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      res.status(400).json({ error: "limit must be 1-100 and offset must be non-negative integers", code: "INVALID_PAGINATION" });
      return;
    }
    res.json(await feed.list(address, limit, offset));
  });
  return router;
}
