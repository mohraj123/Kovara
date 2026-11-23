import { useCallback, useEffect, useRef, useState } from "react";

import type { IndexerErrorCode } from "../components/states/ErrorState";
import { mapIndexerError } from "../utils/mapIndexerError";
import { getPoolById, type Pool } from "../utils/indexerClient";

export interface UsePoolReturn {
  pool: Pool | null;
  loading: boolean;
  error: string | null;
  errorCode: IndexerErrorCode | undefined;
  /** True while a post-transaction refresh is in flight (the screen keeps showing data). */
  refreshing: boolean;
  isAdmin: (address: string) => boolean;
  /** Re-reads the pool. Resolves when the new values are in state. */
  refresh: () => Promise<void>;
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
  const [refreshing, setRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Read inside `loadPool` so the "do I already have data?" decision sees the
  // current pool without making the callback depend on it (which would tear
  // down and re-run the load effect on every successful fetch).
  const poolRef = useRef<Pool | null>(null);
  poolRef.current = pool;

  /**
   * @param options.silent keep the current pool on screen instead of showing the
   *   loading spinner. Used after a confirmed deposit/withdrawal: the balance is
   *   stale by one transaction and the user should watch it update, not stare at
   *   a spinner that blanks the whole screen (FE-21).
   */
  const loadPool = useCallback(
    async (options: { silent?: boolean } = {}): Promise<void> => {
      const silent = options.silent ?? false;
      // A refresh after a confirmed transaction is silent only while there is
      // something to keep showing.
      const keepData = silent && poolRef.current !== null;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (keepData) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      setErrorCode(undefined);

      const id = String(poolId ?? "").trim();
      if (!id) {
        // Missing / empty route param → "Not found" without hitting the network.
        setPool(null);
        setErrorCode(404);
        setError("Pool not found");
        setLoading(false);
        setRefreshing(false);
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
          setRefreshing(false);
        }
      }
    },
    [poolId]
  );

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

  // Returns the promise rather than discarding it (FE-21): a caller that needs
  // to know when the new balance is on screen — to clear a "deposited" banner,
  // say — could not before.
  const refresh = useCallback(() => loadPool({ silent: true }), [loadPool]);

  return { pool, loading, error, errorCode, refreshing, isAdmin, refresh };
}
