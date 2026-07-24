import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, PoolResponse } from "../contracts";
import { serializeBigInt } from "../index";

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

      let token_name: string | undefined;
      let token_symbol: string | undefined;
      let token_decimals: number | undefined;
      try {
        const meta = await db.getTokenMetadata(pool.token);
        if (meta) {
          token_name = meta.name;
          token_symbol = meta.symbol;
          token_decimals = meta.decimals;
        }
      } catch {
        token_name = "unknown";
        token_symbol = "UNK";
        token_decimals = 7;
      }

      res.json(
        serializeBigInt({
          ...pool,
          token_name,
          token_symbol,
          token_decimals,
        })
      );
    }
  );

  return router;
}
