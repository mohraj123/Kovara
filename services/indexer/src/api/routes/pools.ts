import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, PoolResponse } from "../contracts";

export function createPoolsRouter(db: Database): Router {
  const router = Router();

  /**
   * GET /pools/:id
   * Returns the current state of a pool by its ID.
   */
  router.get(
    "/:id",
    async (req: Request, res: Response<PoolResponse | ApiErrorResponse>): Promise<void> => {
      const { id } = req.params;

      if (!id || typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "id is required", code: "INVALID_ID" });
        return;
      }

      const pool = await db.getPool(id);
      if (!pool) {
        res.status(404).json({ error: "Pool not found", code: "NOT_FOUND" });
        return;
      }

      res.json(pool);
    }
  );

  return router;
}
