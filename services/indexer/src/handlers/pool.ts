/**
 * Handlers for PoolDeposit and PoolWithdraw contract events.
 */

import { Database } from "../db";

export interface PoolDepositEvent {
  depositor: string;
  pool_id: string;
  token: string;
  amount: bigint;
  ledger: number;
}

export interface PoolWithdrawEvent {
  recipient: string;
  pool_id: string;
  amount: bigint;
  ledger: number;
}

/**
 * Handle a PoolDeposit event.
 *
 * Adds the deposited amount to the pool's running balance.
 * Idempotent when replayed: the underlying upsert uses the pool_id as the
 * primary key and the balance adjustment is additive, so callers must
 * ensure events are not replayed (use the ledger watermark).
 */
export async function handlePoolDeposit(
  db: Database,
  event: PoolDepositEvent
): Promise<void> {
  if (!event.pool_id) {
    throw new Error("PoolDeposit event missing required field: pool_id");
  }
  if (event.amount <= BigInt(0)) {
    throw new Error("PoolDeposit event amount must be positive");
  }

  await db.adjustPoolBalance(event.pool_id, event.amount, event.ledger);
}

/**
 * Handle a PoolWithdraw event.
 *
 * Subtracts the withdrawn amount from the pool's running balance.
 */
export async function handlePoolWithdraw(
  db: Database,
  event: PoolWithdrawEvent
): Promise<void> {
  if (!event.pool_id) {
    throw new Error("PoolWithdraw event missing required field: pool_id");
  }
  if (event.amount <= BigInt(0)) {
    throw new Error("PoolWithdraw event amount must be positive");
  }

  await db.adjustPoolBalance(event.pool_id, -event.amount, event.ledger);
}
