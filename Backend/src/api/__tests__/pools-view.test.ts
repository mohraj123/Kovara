import express from "express";
import request from "supertest";
import { Database, PoolRecord } from "../../db";
import { createPoolsRouter } from "../routes/pools";

const ADMIN = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
const OUTSIDER = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK4";

function pool(overrides: Partial<PoolRecord> = {}): PoolRecord {
  return {
    pool_id: "pool-1",
    token: "GTOKEN",
    balance: 42n,
    admins: [ADMIN],
    threshold: 1,
    created_ledger: 1,
    updated_ledger: 2,
    ...overrides,
  };
}

function makeDb(pools: PoolRecord[]): Database {
  return {
    getPool: jest.fn(async (id: string) => pools.find((p) => p.pool_id === id) ?? null),
    listPools: jest.fn(async ({ limit, offset }: { limit: number; offset: number }) => ({
      pools: pools.slice(offset, offset + limit),
      total: pools.length,
    })),
    getTokenMetadata: jest.fn(async () => null),
  } as unknown as Database;
}

function makeApp(pools: PoolRecord[]) {
  const app = express();
  app.use(express.json());
  app.use("/pools", createPoolsRouter(makeDb(pools)));
  return app;
}

describe("pool membership and liquidity views (#677)", () => {
  it("returns a whole-system liquidity summary with accurate counts and balances", async () => {
    const app = makeApp([
      pool({ pool_id: "a", balance: 10n }),
      pool({ pool_id: "b", balance: 0n }),
      pool({ pool_id: "c", balance: 5n, token: "GOTHER" }),
    ]);

    const res = await request(app).get("/pools/liquidity");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pool_count: 3,
      active_pool_count: 2,
      inactive_pool_count: 1,
      total_balance: "15",
      token_count: 2,
    });
    expect(res.body.pools).toHaveLength(3);
  });

  it("returns an empty but valid summary when there are no pools", async () => {
    const res = await request(makeApp([])).get("/pools/liquidity");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pool_count: 0,
      active_pool_count: 0,
      inactive_pool_count: 0,
      total_balance: "0",
      pools: [],
    });
  });

  it("returns a single pool's liquidity and flags a drained pool inactive", async () => {
    const app = makeApp([pool({ pool_id: "empty", balance: 0n })]);

    const res = await request(app).get("/pools/empty/liquidity");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pool_id: "empty",
      balance: "0",
      active: false,
      operational: true,
    });
  });

  it("returns 404 for liquidity of a missing pool", async () => {
    const res = await request(makeApp([])).get("/pools/nope/liquidity");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports membership for an admin", async () => {
    const res = await request(makeApp([pool()])).get(`/pools/pool-1/membership/${ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pool_id: "pool-1",
      member: true,
      role: "admin",
      admin_count: 1,
      threshold: 1,
    });
  });

  it("reports non-membership without an error", async () => {
    const res = await request(makeApp([pool()])).get(`/pools/pool-1/membership/${OUTSIDER}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ member: false, role: "none" });
  });

  it("rejects a malformed address with 400", async () => {
    const res = await request(makeApp([pool()])).get("/pools/pool-1/membership/nope");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_ADDRESS" });
  });

  it("returns 404 for membership in a missing pool", async () => {
    const res = await request(makeApp([])).get(`/pools/nope/membership/${ADMIN}`);
    expect(res.status).toBe(404);
  });
});
