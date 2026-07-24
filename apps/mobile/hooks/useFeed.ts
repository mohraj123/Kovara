import { useCallback, useEffect, useRef, useState } from "react";

import { Post } from "../components/PostCard";
import { IndexerError } from "../../../packages/sdk/src/errors";
import type { IndexerErrorCode } from "../components/states/ErrorState";
import { listPosts as fetchPostsFromIndexer } from "../utils/indexerClient";

const PAGE_SIZE = 10;

// Status codes rendered as badges in the ErrorState component. Anything
// outside this set falls back to `500` so the cast in `setErrorCode` stays
// type-safe.
const RENDERABLE_ERROR_CODES: ReadonlySet<IndexerErrorCode> = new Set([
  400, 401, 403, 404, 429, 500, 502, 503, 504,
]);

function clampStatusCode(raw: number | undefined): IndexerErrorCode {
  if (typeof raw === "number" && RENDERABLE_ERROR_CODES.has(raw as IndexerErrorCode)) {
    return raw as IndexerErrorCode;
  }
  return 500;
}

/**
 * Module-level listener set used to broadcast soft-deletes from any screen
 * to any useFeed instance. IDs are kept as strings to stay consistent with
 * the PostCard's key extraction.
 */
const deletionListeners = new Set<(deletedPostId: string) => void>();

/**
 * Notify every mounted `useFeed` that a post was soft-deleted so the post
 * can be removed from its local cache immediately. Used by `useDeletePost`
 * after a successful indexer delete-deletion, and by the post detail screen
 * after a confirmed deletion.
 */
export function markFeedPostDeleted(postId: string | number): void {
  const id = String(postId);
  deletionListeners.forEach((listener) => listener(id));
}

export function subscribeToFeedPostChanges(listener: (deletedPostId: string) => void): () => void {
  deletionListeners.add(listener);
  return () => {
    deletionListeners.delete(listener);
  };
}

export interface UseFeedReturn {
  posts: Post[];
  loading: boolean;
  error: string | null;
  errorCode: IndexerErrorCode | undefined;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

export function useFeed(): UseFeedReturn {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<IndexerErrorCode | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  const offsetRef = useRef(0);
  const loadingRef = useRef(false);

  const load = useCallback(async (offset: number, replace: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    setErrorCode(undefined);

    try {
      const { posts: fetched, hasMore: more } = await fetchPostsFromIndexer(PAGE_SIZE, offset, {});
      setPosts((prev) => (replace ? fetched : [...prev, ...fetched]));
      setHasMore(more);
      if (fetched.length > 0) {
        offsetRef.current = offset + fetched.length;
      }
    } catch (e) {
      if (e instanceof IndexerError) {
        setErrorCode(clampStatusCode(e.statusCode));
        setError(e.message);
      } else {
        setError("Failed to load posts. Please try again.");
      }
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    offsetRef.current = 0;
    void load(0, true);
  }, [load]);

  useEffect(() => {
    return subscribeToFeedPostChanges((deletedPostId) => {
      setPosts((current) => current.filter((post) => String(post.id) !== deletedPostId));
    });
  }, []);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      void load(offsetRef.current, false);
    }
  }, [loading, hasMore, load]);

  const refresh = useCallback(() => {
    offsetRef.current = 0;
    void load(0, true);
  }, [load]);

  return { posts, loading, error, errorCode, hasMore, loadMore, refresh };
}
