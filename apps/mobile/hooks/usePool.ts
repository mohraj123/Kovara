import { useState, useEffect, useCallback } from "react";
import type { Pool } from "../../../packages/sdk/src/types";
import { IndexerError } from "../../../packages/sdk/src/errors";
import type { IndexerErrorCode } from "../components/states/ErrorState";

const MOCK_POOLS: Record<string, Pool> = {
  "pool-1": {
    pool_id: "pool-1",
    token: "USDC",
    balance: BigInt("50000"),
    admins: ["GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    threshold: 1,
  },
  "pool-2": {
    pool_id: "pool-2",
    token: "EUR",
    balance: BigInt("100000"),
    admins: [
      "GXYZ9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "GDEF5678901234ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ],
    threshold: 2,
  },
  "pool-3": {
    pool_id: "pool-3",
    token: "BRL",
    balance: BigInt("25000"),
    admins: ["GHIJ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    threshold: 1,
  },
};

export interface UsePoolReturn {
  pool: Pool | null;
  loading: boolean;
  error: string | null;
  errorCode: IndexerErrorCode | undefined;
  isAdmin: (address: string) => boolean;
  refresh: () => void;
}

export function usePool(poolId: string): UsePoolReturn {
  const [pool, setPool] = useState<Pool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<IndexerErrorCode | undefined>(undefined);

  const loadPool = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorCode(undefined);

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const foundPool = MOCK_POOLS[poolId] || null;
      if (!foundPool) {
        setErrorCode(404);
        setError("Pool not found");
      }
      setPool(foundPool);
    } catch (err) {
      if (err instanceof IndexerError) {
        setErrorCode(err.statusCode as IndexerErrorCode);
        setError(err.message);
      } else {
        setError("Failed to load pool. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [poolId]);

  useEffect(() => {
    loadPool();
  }, [loadPool]);

  const isAdmin = useCallback(
    (address: string) => {
      return pool?.admins.includes(address) ?? false;
    },
    [pool]
  );

  const refresh = useCallback(() => {
    loadPool();
  }, [loadPool]);

  return { pool, loading, error, errorCode, isAdmin, refresh };
}
