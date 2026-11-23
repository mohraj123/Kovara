import { useState, useCallback } from "react";

import { getPoolById, type Pool } from "../utils/indexerClient";

import { useNetwork } from "./useNetwork";
import { useWallet } from "./useWallet";
import { sdkPoolDeposit } from "../utils/sdkPoolDeposit";

export interface DepositState {
  pending: boolean;
  success: boolean;
  error: string | null;
  txHash?: string;
}

export interface UsePoolDepositReturn extends DepositState {
  deposit: (poolId: string, amount: string, token: string) => Promise<void>;
  reset: () => void;
}

/** Default Stellar asset precision when token metadata is unavailable. */
export const DEFAULT_TOKEN_DECIMALS = 7;

/**
 * Parse a human-readable decimal amount into integer base units for the token.
 * Rejects excess fractional digits, non-finite values, and amounts that cannot
 * be represented exactly as an integer number of base units.
 *
 * Returns the base-unit amount as a bigint string on success.
 */
export function parseAmountToUnits(
  amount: string,
  decimals: number
): { ok: true; units: string } | { ok: false; error: string } {
  if (typeof amount !== 'string') {
    return { ok: false, error: 'Amount must be a string' };
  }

  const trimmed = amount.trim();
  if (!trimmed) {
    return { ok: false, error: 'Amount is required' };
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { ok: false, error: 'Invalid token decimals' };
  }

  // Reject scientific notation and other non-decimal forms.
  if (/[eE]/.test(trimmed)) {
    return { ok: false, error: 'Scientific notation is not supported' };
  }

  if (!/^\+?\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: 'Amount must be a positive decimal number' };
  }

  const normalized = trimmed.replace(/^\+/, '');
  const [wholePart, fracPart = ''] = normalized.split('.');

  if (fracPart.length > decimals) {
    return {
      ok: false,
      error: `Amount has too many decimal places (max ${decimals})`,
    };
  }

  const paddedFrac = fracPart.padEnd(decimals, '0');
  const unitsStr = `${wholePart}${paddedFrac}`.replace(/^0+(?=\d)/, '') || '0';

  // Reject zero after scaling (e.g. 0, 0.0, 0.000).
  if (!/^[1-9]\d*$/.test(unitsStr)) {
    return { ok: false, error: 'Amount must be greater than zero' };
  }

  // Guard against values that exceed safe integer range when coerced via Number.
  // Base units are kept as strings/bigint so large balances remain exact.
  try {
    const asBigInt = BigInt(unitsStr);
    if (asBigInt <= 0n) {
      return { ok: false, error: 'Amount must be greater than zero' };
    }
  } catch {
    return { ok: false, error: 'Amount is not a valid integer amount' };
  }

  return { ok: true, units: unitsStr };
}

/**
 * Verify the pool exists and that the provided token matches the pool's
 * configured token before any signing/submit step.
 */
export async function validatePoolAndToken(
  poolId: string,
  token: string
): Promise<{ ok: true; pool: Pool } | { ok: false; error: string }> {
  const id = String(poolId ?? '').trim();
  if (!id) {
    return { ok: false, error: 'Pool ID is required' };
  }

  const tokenStr = String(token ?? '').trim();
  if (!tokenStr) {
    return { ok: false, error: 'Token is required' };
  }

  let pool: Pool | null;
  try {
    pool = await getPoolById(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to verify pool';
    return { ok: false, error: message };
  }

  if (!pool) {
    return { ok: false, error: 'Pool not found' };
  }

  if (!pool.token || pool.token.trim() === '') {
    return { ok: false, error: 'Pool has no token configured' };
  }

  if (pool.token !== tokenStr) {
    return {
      ok: false,
      error: `Token mismatch: pool is configured for ${pool.token}, got ${tokenStr}`,
    };
  }

  return { ok: true, pool };
}

// Global wallet kit reference (set by WalletContext) — same pattern as useTip.
declare global {
  // eslint-disable-next-line no-var, @typescript-eslint/no-explicit-any
  var __Kovara_WALLET_KIT__: any;
}

/**
 * MO-007: Signs, submits, and confirms a real pool deposit via the SDK and
 * wallet kit. Returns the Stellar transaction hash (not a random mock).
 *
 * FE-19: on failure the error is surfaced via `error` and the caller retains
 * the entered amount so the deposit can be retried. The hook does not clear
 * the amount or success state on failure, and the form keeps its controlled input
 * value intact.
 */
export function usePoolDeposit(): UsePoolDepositReturn {
  const { address, connected } = useWallet();
  const { contractId, rpcUrl } = useNetwork();
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string>();

  const deposit = useCallback(
    async (poolId: string, amount: string, token: string) => {
      if (pending) {
        return;
      }

      setPending(true);
      setError(null);
      setSuccess(false);
      setTxHash(undefined);

      try {
        if (!connected || !address) {
          throw new Error("Connect your wallet to deposit into this pool.");
        }

        // Validate amount precision, zero, and negative values before touching wallet
        const parseResult = parseAmountToUnits(amount, DEFAULT_TOKEN_DECIMALS);
        if (!parseResult.ok) {
          throw new Error(parseResult.error);
        }

        // Verify pool and token before wallet interaction
        const validationResult = await validatePoolAndToken(poolId, token);
        if (!validationResult.ok) {
          throw new Error(validationResult.error);
        }

        const walletKit = globalThis.__Kovara_WALLET_KIT__;
        if (!walletKit) {
          throw new Error("Wallet not initialized. Please reconnect.");
        }

        const amountBigInt = BigInt(parseResult.units);

        const result = await sdkPoolDeposit(
          contractId,
          rpcUrl,
          address,
          poolId,
          token,
          amountBigInt,
          walletKit
        );

        setTxHash(result.txHash);
        setSuccess(true);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Deposit failed. Please try again.";
        // FE-19: surface a retryable error while keeping the caller's amount intact.
        // We do not clear any amount state here (the hook does not own it) and we
        // keep the error available for the form to render a retry affordance.
        setError(message);
        setSuccess(false);
      } finally {
        setPending(false);
      }
    },
    [address, connected, contractId, rpcUrl, pending]
  );

  const reset = useCallback(() => {
    setPending(false);
    setSuccess(false);
    setError(null);
    setTxHash(undefined);
  }, []);

  return {
    pending,
    success,
    error,
    txHash,
    deposit,
    reset,
  };
}
