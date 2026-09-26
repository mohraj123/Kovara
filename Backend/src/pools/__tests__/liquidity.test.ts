import { PoolRecord } from "../../db";
import {
  PoolViewError,
  isThresholdValid,
  poolLiquidity,
  poolMembership,
  summarizeLiquidity,
  validateMembershipAddress,
} from "../liquidity";

const ADMIN_A = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";
const ADMIN_B = "GBVVJJFQ6XQ7XW5Z4QWJXQ5JQ5Z4QWJXQ5JQ5Z4QWJXQ5JQ5Z4QWJXQ5J";

function pool(overrides: Partial<PoolRecord> = {}): PoolRecord {
  return {
    pool_id: "pool-1",
    token: "GTOKEN",
    balance: 1_000n,
    admins: [ADMIN_A],
    threshold: 1,
    created_ledger: 10,
    updated_ledger: 20,
    ...overrides,
  };
}

describe("isThresholdValid", () => {
  it("accepts a threshold within the roster", () => {
    expect(isThresholdValid(1, 3)).toBe(true);
    expect(isThresholdValid(3, 3)).toBe(true);
  });

  it("rejects zero and above-roster thresholds", () => {
    expect(isThresholdValid(0, 3)).toBe(false);
    expect(isThresholdValid(4, 3)).toBe(false);
  });
});

describe("poolMembership (#677)", () => {
  it("reports an admin as a member with the admin role", () => {
    const result = poolMembership(pool({ admins: [ADMIN_A, ADMIN_B], threshold: 2 }), ADMIN_A);
    expect(result).toMatchObject({
      pool_id: "pool-1",
      member: true,
      role: "admin",
      admin_count: 2,
      threshold: 2,
    });
  });

  it("reports a non-admin as a non-member without failing", () => {
    const result = poolMembership(pool(), ADMIN_B);
    expect(result.member).toBe(false);
    expect(result.role).toBe("none");
  });

  it("matches case-insensitively and trims whitespace", () => {
    const result = poolMembership(pool(), `  ${ADMIN_A.toLowerCase()}  `);
    expect(result.member).toBe(true);
  });

  it("tolerates a pool with no admins", () => {
    const result = poolMembership(pool({ admins: [] }), ADMIN_A);
    expect(result).toMatchObject({ member: false, admin_count: 0 });
  });
});

describe("poolLiquidity (#677)", () => {
  it("returns the balance as a precision-safe decimal string", () => {
    const view = poolLiquidity(pool({ balance: 9_007_199_254_740_993n }));
    expect(view.balance).toBe("9007199254740993");
    expect(typeof view.balance).toBe("string");
  });

  it("marks a funded pool active and a drained pool inactive", () => {
    expect(poolLiquidity(pool({ balance: 5n })).active).toBe(true);
    expect(poolLiquidity(pool({ balance: 0n })).active).toBe(false);
  });

  it("marks a pool operational only when its threshold can be met", () => {
    expect(poolLiquidity(pool({ admins: [ADMIN_A], threshold: 1 })).operational).toBe(true);
    expect(poolLiquidity(pool({ admins: [], threshold: 1 })).operational).toBe(false);
    expect(poolLiquidity(pool({ admins: [ADMIN_A], threshold: 2 })).operational).toBe(false);
  });
});

describe("summarizeLiquidity (#677)", () => {
  it("counts active and inactive pools and sums balances exactly", () => {
    const summary = summarizeLiquidity([
      pool({ pool_id: "a", balance: 10n, token: "X" }),
      pool({ pool_id: "b", balance: 0n, token: "X" }),
      pool({ pool_id: "c", balance: 5n, token: "Y" }),
    ]);

    expect(summary.pool_count).toBe(3);
    expect(summary.active_pool_count).toBe(2);
    expect(summary.inactive_pool_count).toBe(1);
    expect(summary.total_balance).toBe("15");
    expect(summary.token_count).toBe(2);
    expect(summary.pools).toHaveLength(3);
  });

  it("returns a truthful all-zero summary for no pools", () => {
    const summary = summarizeLiquidity([]);
    expect(summary).toMatchObject({
      pool_count: 0,
      active_pool_count: 0,
      inactive_pool_count: 0,
      total_balance: "0",
      token_count: 0,
      pools: [],
    });
  });

  it("keeps counts and balance consistent with a large balance", () => {
    const big = 18_446_744_073_709_551_615n; // 2^64 - 1
    const summary = summarizeLiquidity([
      pool({ pool_id: "a", balance: big }),
      pool({ pool_id: "b", balance: big }),
    ]);
    expect(summary.total_balance).toBe("36893488147419103230");
  });
});

describe("validateMembershipAddress", () => {
  it("accepts a valid strkey and returns it trimmed", () => {
    expect(validateMembershipAddress(` ${ADMIN_A} `)).toBe(ADMIN_A);
  });

  it("rejects empty and malformed addresses", () => {
    expect(() => validateMembershipAddress("")).toThrow(PoolViewError);
    expect(() => validateMembershipAddress("not-an-address")).toThrow(PoolViewError);
    expect(() => validateMembershipAddress(undefined)).toThrow(PoolViewError);
  });
});
