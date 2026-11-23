import { useState, useEffect, useCallback, useRef } from 'react';

interface SearchParams {
  query: string;
  limit?: number;
}

export function useExploreSearch({ query, limit = 20 }: SearchParams) {
  const [items, setItems] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // References to track active request controllers and request sequence counters
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<number>(0);

  // Reset pagination and cancel pending requests when the query changes
  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    // Invalidate every in-flight response (FE-23). Aborting is not enough on its
    // own: once `fetch` has resolved, the remaining work is the `.json()` parse,
    // which an abort does not cancel. Without bumping the sequence here, a
    // response issued for the *previous* query still passes the
    // `currentRequestId !== requestIdRef.current` guard in `loadMore` and
    // appends the old query's rows to the new query's list.
    requestIdRef.current += 1;
    setItems([]);
    setCursor(null);
    setHasMore(true);
  }, [query]);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;

    // Abort any prior in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Increment request sequence ID to guard against out-of-order resolution
    const currentRequestId = ++requestIdRef.current;

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/indexer/search?q=${encodeURIComponent(query)}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        { signal: controller.signal }
      );
      const data = await response.json();

      // Guard: Ensure only the latest initiated request updates the component state
      if (currentRequestId !== requestIdRef.current) {
        return;
      }

      setItems((prevItems) => {
        const existingIds = new Set(prevItems.map((item) => item.id));
        const uniqueNewItems = data.results.filter((item: any) => !existingIds.has(item.id));
        return [...prevItems, ...uniqueNewItems];
      });

      setCursor(data.nextCursor || null);
      setHasMore(data.hasMore ?? false);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Failed to fetch explore search results:', error);
      }
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [query, cursor, hasMore, isLoading, limit]);

  return { items, loadMore, hasMore, isLoading };
}