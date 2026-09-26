import { Router, Request, Response } from "express";
import { Database, PoolRecord } from "../../db";
import { ApiErrorResponse, PoolListResponse, PoolResponse } from "../contracts";
import { serializeBigInt } from "../index";
import { isFailure, validatePagination, validateString } from "../validation";

const MAX_LIMIT = 100;

function isThresholdValid(pool: PoolRecord): boolean {
  return pool.threshold > 0 && pool.threshold <= pool.admins.length;
}

function serializePool(
  pool: PoolRecord,
  meta?: { token_name?: string; token_symbol?: string; token_decimals?: number }
): Record<string, unknown> {
  return serializeBigInt({
    pool_id: pool.pool_id,
    token: pool.token,
    balance: pool.balance,
    admins: pool.admins,
    threshold: pool.threshold,
    created_ledger: pool.created_ledger,
    updated_ledger: pool.updated_ledger,
    ...meta,
  }) as Record<string, unknown>;
}

export function createPoolsRouter(db: Database): Router {
  const router = Router();

  /**
   * GET /pools?limit=<n>&offset=<n>
   * Lists pools with limit/offset pagination and has_more.
   */
  router.get(
    "/",
    async (req: Request, res: Response<PoolListResponse | ApiErrorResponse>): Promise<void> => {
      const pagination = validatePagination(req.query as Record<string, unknown>, {
        maxLimit: MAX_LIMIT,
      });
      if (isFailure(pagination)) {
        res.status(400).json(pagination.failure);
        return;
      }
      const { limit: rawLimit, offset: rawOffset } = pagination.value;

      const { pools, total } = await db.listPools({ limit: rawLimit, offset: rawOffset });

      const enriched = await Promise.all(
        pools.map(async (pool) => {
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
          return serializePool(pool, { token_name, token_symbol, token_decimals });
        })
      );

      res.json({
        pools: enriched,
        total,
        limit: rawLimit,
        offset: rawOffset,
        has_more: rawOffset + pools.length < total,
      } as unknown as PoolListResponse);
    }
  );

  /**
   * GET /pools/:id
   * Returns the current state of a pool by its ID.
   */
  router.get(
    "/:id",
    async (req: Request, res: Response<PoolResponse | ApiErrorResponse>): Promise<void> => {
      const validatedId = validateString(req.params.id, "pool id", { maxLength: 128, code: "INVALID_ID" });
      if (isFailure(validatedId)) {
        res.status(400).json(validatedId.failure);
        return;
      }

      const pool = await db.getPool(validatedId.value);
      if (!pool) {
        res.status(404).json({ error: "Pool not found", code: "NOT_FOUND" });
        return;
      }

      if (!isThresholdValid(pool)) {
        res.status(422).json({ error: "Pool threshold is invalid", code: "INVALID_THRESHOLD" });
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
