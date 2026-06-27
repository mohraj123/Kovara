import { useState, useEffect, useCallback } from "react";
import type { Pool } from "../../../packages/sdk/src/types";
import { IndexerError } from "../../../packages/sdk/src/errors";
import type { IndexerErrorCode } from "../components/states/ErrorState";

const MOCK_POOLS: Pool[] = [
  {
    pool_id: "pool-1",
    token: "USDC",
    balance: BigInt("50000"),
    admins: ["GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    threshold: 1,
  },
  {
    pool_id: "pool-2",
    token: "EUR",
    balance: BigInt("100000"),
    admins: [
      "GXYZ9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "GDEF5678901234ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    ],
    threshold: 2,
  },
  {
    pool_id: "pool-3",
    token: "BRL",
    balance: BigInt("25000"),
    admins: ["GHIJ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    threshold: 1,
  },
];

export interface UsePoolsReturn {
  pools: Pool[];
  loading: boolean;
  error: string | null;
  errorCode: IndexerErrorCode | undefined;
  refresh: () => void;
}

export function usePools(): UsePoolsReturn {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<IndexerErrorCode | undefined>(undefined);

  const loadPools = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorCode(undefined);

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      setPools(MOCK_POOLS);
    } catch (err) {
      if (err instanceof IndexerError) {
        setErrorCode(err.statusCode as IndexerErrorCode);
        setError(err.message);
      } else {
        setError("Failed to load pools. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPools();
  }, [loadPools]);

  const refresh = useCallback(() => {
    loadPools();
  }, [loadPools]);

  return { pools, loading, error, errorCode, refresh };
}
