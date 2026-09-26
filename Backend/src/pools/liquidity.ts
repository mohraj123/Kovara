/**
 * Pool membership and liquidity views (#677).
 *
 * The indexer already stores the raw pool state — `balance`, `admins`,
 * `threshold` — but there was no way to ask the API the two questions a client
 * actually has:
 *
 *   1. *Is this address a member of this pool, and in what role?* — membership
 *      is derived from the admin roster, so it must be answered from the same
 *      snapshot the rest of the pool view is built from.
 *   2. *What does this pool (or the system as a whole) actually hold?* — a
 *      liquidity summary, with counts and balances.
 *
 * Everything here is **pure**: it takes a {@link PoolRecord} (or a list of
 * them) and returns a JSON-safe view. That keeps the arithmetic and the
 * membership rule testable without a database, and guarantees the count a
 * summary reports is the count of the records it was given — a summary can
 * never disagree with the rows behind it, because it does not query for them.
 *
 * Balances are `bigint` and are emitted as decimal **strings**. A pool balance
 * is a Stellar token amount in the smallest unit, which routinely exceeds
 * `Number.MAX_SAFE_INTEGER`; coercing to `number` would silently round the
 * balance and publish a wrong figure.
 */

import { PoolRecord } from "../db";
import { isValidStellarAddress, normalizeStellarAddress } from "../utils/stellar-address.utils";

/** The role an address holds in a pool. Only admins exist today. */
export type PoolMembershipRole = "admin" | "none";

/** Membership of one address in one pool. */
export interface PoolMembership {
  pool_id: string;
  /** The address as supplied by the caller (trimmed). */
  address: string;
  /** Whether the address is on the pool's roster. */
  member: boolean;
  role: PoolMembershipRole;
  /** Size of the roster, so a client can render "1 of 3". */
  admin_count: number;
  /** Signatures an admin action requires. */
  threshold: number;
}

/** A liquidity view of one pool. */
export interface PoolLiquidity {
  pool_id: string;
  token: string;
  /** Balance in the token's smallest unit, as a decimal string. */
  balance: string;
  admin_count: number;
  threshold: number;
  /**
   * A pool is **active** when it holds a positive balance. An empty pool is a
   * normal state — it was created and never funded, or fully drained — not an
   * error, and callers need to distinguish it from a pool whose balance is
   * unknown.
   */
  active: boolean;
  /**
   * A pool is **operational** when its threshold can actually be met: at least
   * one admin, and a threshold between 1 and the roster size. A created pool
   * that has been drained of admins is still returned, but flagged, rather than
   * hidden.
   */
  operational: boolean;
}

/** Aggregate liquidity across a set of pools. */
export interface LiquiditySummary {
  pool_count: number;
  active_pool_count: number;
  inactive_pool_count: number;
  /** Total balance across every pool in the set, as a decimal string. */
  total_balance: string;
  /** Total distinct tokens across the set. */
  token_count: number;
  /** Per-pool breakdown, in the same order the pools were supplied. */
  pools: PoolLiquidity[];
}

/**
 * Whether `threshold` can be met by `adminCount` admins.
 *
 * A threshold of zero would authorize anyone; a threshold above the roster can
 * never be met and would freeze the pool. Both are invalid, matching the rule
 * the contract's `set_sentinels`/pool validation enforces.
 */
export function isThresholdValid(threshold: number, adminCount: number): boolean {
  return Number.isInteger(threshold) && threshold >= 1 && threshold <= adminCount;
}

/**
 * Resolve one address's membership in a pool.
 *
 * Comparison is case-insensitive and whitespace-trimmed: Stellar strkeys are
 * canonically upper-case, but a caller may send lower-case, and treating
 * `gabc…` as a different address from `GABC…` would report a member as a
 * non-member.
 */
export function poolMembership(pool: PoolRecord, address: string): PoolMembership {
  const normalizedInput = normalizeStellarAddress(address);
  const rosters = Array.isArray(pool.admins) ? pool.admins : [];

  const member = rosters.some(
    (admin) => normalizeStellarAddress(String(admin)) === normalizedInput
  );

  return {
    pool_id: pool.pool_id,
    address: address.trim(),
    member,
    role: member ? "admin" : "none",
    admin_count: rosters.length,
    threshold: pool.threshold,
  };
}

/** Build the liquidity view of one pool. */
export function poolLiquidity(pool: PoolRecord): PoolLiquidity {
  const adminCount = Array.isArray(pool.admins) ? pool.admins.length : 0;
  const balance = typeof pool.balance === "bigint" ? pool.balance : BigInt(pool.balance ?? 0);

  return {
    pool_id: pool.pool_id,
    token: pool.token,
    balance: balance.toString(),
    admin_count: adminCount,
    threshold: pool.threshold,
    active: balance > 0n,
    operational: adminCount > 0 && isThresholdValid(pool.threshold, adminCount),
  };
}

/**
 * Aggregate a set of pools into a summary.
 *
 * The counts are derived from the same array that produces the per-pool rows,
 * so `active_pool_count + inactive_pool_count === pool_count` always holds and
 * `total_balance` is exactly the sum of the rows. An empty set is a valid,
 * truthful summary of "no pools": every count is zero and the total balance is
 * `"0"`. That is deliberately not an error — a deployment with no pools yet is
 * a fact about the world, not a bad request.
 */
export function summarizeLiquidity(pools: PoolRecord[]): LiquiditySummary {
  const views = pools.map(poolLiquidity);

  let total = 0n;
  let activeCount = 0;
  const tokens = new Set<string>();

  for (const view of views) {
    total += BigInt(view.balance);
    if (view.active) activeCount += 1;
    tokens.add(view.token);
  }

  return {
    pool_count: views.length,
    active_pool_count: activeCount,
    inactive_pool_count: views.length - activeCount,
    total_balance: total.toString(),
    token_count: tokens.size,
    pools: views,
  };
}

/** Validate an address for the membership endpoint. Returns the trimmed form. */
export function validateMembershipAddress(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new PoolViewError(
      "address must be a non-empty Stellar address",
      "INVALID_ADDRESS"
    );
  }
  const normalized = normalizeStellarAddress(raw);
  if (!isValidStellarAddress(normalized)) {
    throw new PoolViewError(
      "address must be a valid Stellar public key",
      "INVALID_ADDRESS"
    );
  }
  return raw.trim();
}

/** Raised for input the caller can correct. The route maps it to 400. */
export class PoolViewError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PoolViewError";
    this.code = code;
  }
}
