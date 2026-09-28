import { useCallback, useEffect, useRef, useState } from "react";

import type { IndexerErrorCode } from "../components/states/ErrorState";
import { mapIndexerError } from "../utils/mapIndexerError";
import { getPoolById, type Pool } from "../utils/indexerClient";

export interface UsePoolReturn {
  pool: Pool | null;
  loading: boolean;
  error: string | null;
  errorCode: IndexerErrorCode | undefined;
  isAdmin: (address: string) => boolean;
  refresh: () => void;
}

/**
 * Load a single pool's details from the configured indexer backend
 * (EXPO_PUBLIC_INDEXER_URL). No mock data is used: missing / empty route IDs
 * and indexer 404s surface as a typed 404 for ErrorState without a network
 * call, and all other failures map through mapIndexerError for stable
 * message + status-code rendering.
 */
export function usePool(poolId: string): UsePoolReturn {
  const [pool, setPool] = useState<Pool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<IndexerErrorCode | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const loadPool = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setErrorCode(undefined);

    const id = String(poolId ?? "").trim();
    if (!id) {
      // Missing / empty route param → "Not found" without hitting the network.
      setPool(null);
      setErrorCode(404);
      setError("Pool not found");
      setLoading(false);
      return;
    }

    try {
      const foundPool = await getPoolById(id, { signal: controller.signal });

      if (controller.signal.aborted) return;

      if (!foundPool) {
        // Indexer reported 404 (or a soft-deleted row) → ErrorState "Not found".
        setPool(null);
        setErrorCode(404);
        setError("Pool not found");
        return;
      }

      setPool(foundPool);
      setError(null);
      setErrorCode(undefined);
    } catch (err) {
      if (controller.signal.aborted) return;

      const mapped = mapIndexerError(err, "Failed to load pool. Please try again.");
      setPool(null);
      setErrorCode(mapped.statusCode);
      setError(mapped.message);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [poolId]);

  useEffect(() => {
    void loadPool();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [loadPool]);

  const isAdmin = useCallback(
    (address: string) => pool?.admins.includes(address) ?? false,
    [pool]
  );

  const refresh = useCallback(() => {
    void loadPool();
  }, [loadPool]);

  return { pool, loading, error, errorCode, isAdmin, refresh };
}
