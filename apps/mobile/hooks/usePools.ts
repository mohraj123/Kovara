import { useState, useEffect, useCallback, useRef } from "react";
import { IndexerError } from "../../../packages/sdk/src/errors";
import type { IndexerErrorCode } from "../components/states/ErrorState";
import { listPools as fetchPoolsFromIndexer, type Pool } from "../utils/indexerClient";

const PAGE_SIZE = 20;

const RENDERABLE_ERROR_CODES: ReadonlySet<IndexerErrorCode> = new Set([
  400, 401, 403, 404, 429, 500, 502, 503, 504,
]);

function clampStatusCode(raw: number | undefined): IndexerErrorCode {
  if (typeof raw === "number" && RENDERABLE_ERROR_CODES.has(raw as IndexerErrorCode)) {
    return raw as IndexerErrorCode;
  }
  return 500;
}

export interface UsePoolsReturn {
  pools: Pool[];
  loading: boolean;
  error: string | null;
  errorCode: IndexerErrorCode | undefined;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

/**
 * Paginated pool list backed by the indexer API.
 * Additional pages append without duplicates; hasMore reflects end-of-list.
 */
export function usePools(): UsePoolsReturn {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<IndexerErrorCode | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (offset: number, replace: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setErrorCode(undefined);

    try {
      const { pools: fetched, hasMore: more } = await fetchPoolsFromIndexer(
        PAGE_SIZE,
        offset,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;

      setPools((prev) => {
        if (replace) {
          seenIdsRef.current = new Set(fetched.map((p) => p.pool_id));
          return fetched;
        }

        const next = [...prev];
        for (const pool of fetched) {
          if (!seenIdsRef.current.has(pool.pool_id)) {
            seenIdsRef.current.add(pool.pool_id);
            next.push(pool);
          }
        }
        return next;
      });

      setHasMore(more);
      if (fetched.length > 0) {
        offsetRef.current = offset + fetched.length;
      } else if (replace) {
        offsetRef.current = 0;
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof IndexerError) {
        setErrorCode(clampStatusCode(err.statusCode));
        setError(err.message);
      } else {
        setErrorCode(500);
        setError("Failed to load pools. Please try again.");
      }
    } finally {
      loadingRef.current = false;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    offsetRef.current = 0;
    seenIdsRef.current = new Set();
    void load(0, true);
    return () => abortRef.current?.abort();
  }, [load]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      void load(offsetRef.current, false);
    }
  }, [loading, hasMore, load]);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    loadingRef.current = false;
    offsetRef.current = 0;
    seenIdsRef.current = new Set();
    void load(0, true);
  }, [load]);

  return { pools, loading, error, errorCode, hasMore, loadMore, refresh };
}
