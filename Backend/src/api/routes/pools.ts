import { Router, Request, Response } from "express";
import { Database, PoolRecord } from "../../db";
import { ApiErrorResponse, PoolListResponse, PoolResponse } from "../contracts";
import { serializeBigInt } from "../index";
import {
  PoolViewError,
  poolLiquidity,
  poolMembership,
  summarizeLiquidity,
  validateMembershipAddress,
} from "../../pools/liquidity";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_OFFSET = 0;

/**
 * Upper bound on the number of pools a whole-system liquidity summary will
 * read. A summary walks the pool table in pages; without a cap a single request
 * could read an unbounded number of rows. Ten thousand pools is far beyond any
 * real deployment and still cheap.
 */
const MAX_SUMMARY_POOLS = 10_000;
const SUMMARY_PAGE_SIZE = 100;

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

async function loadTokenMeta(
  db: Database,
  token: string
): Promise<{ token_name: string; token_symbol: string; token_decimals: number }> {
  try {
    const meta = await db.getTokenMetadata(token);
    if (meta) {
      return {
        token_name: meta.name,
        token_symbol: meta.symbol,
        token_decimals: meta.decimals,
      };
    }
  } catch {
    // A metadata lookup failing must not hide the pool itself.
  }
  return { token_name: "unknown", token_symbol: "UNK", token_decimals: 7 };
}

/**
 * Read every pool, paging until `total` is reached or the cap is hit.
 *
 * The liquidity summary has to see the whole table to report a truthful total,
 * so this is the one read that is not paginated by the caller. The cap is a
 * safety valve, not a limit on correctness: it is chosen far above any real
 * pool count.
 */
async function collectAllPools(db: Database): Promise<PoolRecord[]> {
  const collected: PoolRecord[] = [];
  let offset = 0;

  while (collected.length < MAX_SUMMARY_POOLS) {
    const { pools, total } = await db.listPools({
      limit: SUMMARY_PAGE_SIZE,
      offset,
    });
    collected.push(...pools);

    offset += pools.length;
    // A short page means the table is exhausted; an empty page also terminates
    // when `total` and the rows disagree (e.g. a concurrent delete).
    if (pools.length === 0 || offset >= total) break;
  }

  return collected.slice(0, MAX_SUMMARY_POOLS);
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
      const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_LIMIT;
      const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : DEFAULT_OFFSET;

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

      const { pools, total } = await db.listPools({ limit: rawLimit, offset: rawOffset });

      const enriched = await Promise.all(
        pools.map(async (pool) => serializePool(pool, await loadTokenMeta(db, pool.token)))
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
   * GET /pools/liquidity
   *
   * Whole-system liquidity summary: pool counts, active/inactive split, total
   * balance and distinct tokens. An empty deployment returns all-zero counts
   * and `total_balance: "0"`, not a 404 — "there are no pools yet" is a fact
   * the caller needs to distinguish from a failed request.
   *
   * Registered before `/:id` so the literal path is not captured as a pool id.
   */
  router.get(
    "/liquidity",
    async (_req: Request, res: Response): Promise<void> => {
      const pools = await collectAllPools(db);
      const summary = summarizeLiquidity(pools);
      res.json(serializeBigInt(summary));
    }
  );

  /**
   * GET /pools/:id/liquidity
   *
   * The liquidity view of one pool. A pool that exists but holds nothing is a
   * 200 with `active: false`; only a pool that does not exist is a 404.
   */
  router.get(
    "/:id/liquidity",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;

      if (!id || typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "Invalid pool ID: must be a non-empty string", code: "INVALID_ID" });
        return;
      }

      const pool = await db.getPool(id);
      if (!pool) {
        res.status(404).json({ error: "Pool not found", code: "NOT_FOUND" });
        return;
      }

      res.json(serializeBigInt(poolLiquidity(pool)));
    }
  );

  /**
   * GET /pools/:id/membership/:address
   *
   * Whether an address belongs to a pool, and in what role. A non-member is a
   * 200 with `member: false, role: "none"` — absence of membership is a valid
   * answer, and turning it into a 404 would force a client to treat a normal
   * outcome as an error.
   */
  router.get(
    "/:id/membership/:address",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;

      if (!id || typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "Invalid pool ID: must be a non-empty string", code: "INVALID_ID" });
        return;
      }

      let address: string;
      try {
        address = validateMembershipAddress(req.params.address);
      } catch (err) {
        if (err instanceof PoolViewError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }

      const pool = await db.getPool(id);
      if (!pool) {
        res.status(404).json({ error: "Pool not found", code: "NOT_FOUND" });
        return;
      }

      res.json(serializeBigInt(poolMembership(pool, address)));
    }
  );

  /**
   * GET /pools/:id
   * Returns the current state of a pool by its ID.
   */
  router.get(
    "/:id",
    async (req: Request, res: Response<PoolResponse | ApiErrorResponse>): Promise<void> => {
      const { id } = req.params;

      if (!id || typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "Invalid pool ID: must be a non-empty string", code: "INVALID_ID" });
        return;
      }

      const pool = await db.getPool(id);
      if (!pool) {
        res.status(404).json({ error: "Pool not found", code: "NOT_FOUND" });
        return;
      }

      if (!isThresholdValid(pool)) {
        res.status(422).json({ error: "Pool threshold is invalid", code: "INVALID_THRESHOLD" });
        return;
      }

      const meta = await loadTokenMeta(db, pool.token);

      res.json(
        serializeBigInt({
          ...pool,
          ...meta,
        })
      );
    }
  );

  return router;
}
