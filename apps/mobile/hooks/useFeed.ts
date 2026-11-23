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

/**
 * How a load treats the posts already on screen.
 *
 * `replace` overwrites the feed (first load, refresh) and always reads from
 * offset zero. `append` adds one page after the current cursor.
 */
type LoadMode = "replace" | "append";

/**
 * Paginated feed with **serialized** requests.
 *
 * ## Why requests are serialized
 *
 * `loading` is React state, so it does not change until the next render. Two
 * `loadMore()` calls in the same tick both observe `loading === false` and
 * both fire. Both read the same cursor, both request the same page, and the
 * feed ends up showing that page twice.
 *
 * Two mechanisms prevent that, and they solve different halves of the problem:
 *
 * 1. **A promise chain** (`chainRef`) guarantees only one request is ever in
 *    flight. Every load is appended to the chain, so ordering is explicit
 *    rather than implied by whichever `await` happened to resolve first.
 * 2. **A pending-append flag** (`appendPendingRef`) makes a burst of
 *    `loadMore()` calls enqueue *one* page request, not N. Without it the
 *    chain would faithfully serialize three identical appends.
 *
 * The cursor is read at **execution** time rather than at call time. A queued
 * append therefore uses the position the previous page left behind, which is
 * what makes the chain correct rather than merely ordered.
 *
 * ## Why a failed load leaves the feed alone
 *
 * `setPosts` is only reached on success. On failure the posts, the cursor and
 * `hasMore` all keep the values that describe what is on screen, so the feed
 * stays consistent and the next attempt resumes from a valid position.
 * `refresh()` always reads from offset zero, so a retry after a failed refresh
 * starts over from the first page rather than resuming mid-list.
 */
export function useFeed(): UseFeedReturn {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<IndexerErrorCode | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  // Cursor: how many records are already displayed. Advanced only by a
  // successful load, so it always describes the posts currently on screen.
  const offsetRef = useRef(0);

  // Tail of the serialized load chain.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  // Whether an append is queued or in flight, so a burst of `loadMore()`
  // calls enqueues a single page request.
  const appendPendingRef = useRef(false);

  const runLoad = useCallback(async (mode: LoadMode) => {
    // Read the cursor now, not when the request was queued: a serialized
    // append must start where the previous page finished.
    const offset = mode === "replace" ? 0 : offsetRef.current;

    setLoading(true);
    setError(null);
    setErrorCode(undefined);

    try {
      const { posts: fetched, hasMore: more } = await fetchPostsFromIndexer(PAGE_SIZE, offset, {});
      if (mode === "replace") {
        setPosts(fetched);
        offsetRef.current = fetched.length;
      } else {
        setPosts((prev) => [...prev, ...fetched]);
        offsetRef.current = offset + fetched.length;
      }
      setHasMore(more);
    } catch (e) {
      // Deliberately no `setPosts` here: a failed refresh must leave the
      // current feed on screen, and the cursor must keep describing it.
      if (e instanceof IndexerError) {
        setErrorCode(clampStatusCode(e.statusCode));
        setError(e.message);
      } else {
        setError("Failed to load posts. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(
    (mode: LoadMode): Promise<void> => {
      const run = chainRef.current.then(() => runLoad(mode));
      // Keep the chain usable after a rejection, so one failed load does not
      // poison every load that follows it.
      chainRef.current = run.catch(() => undefined);
      return run;
    },
    [runLoad],
  );

  useEffect(() => {
    void load("replace");
  }, [load]);

  useEffect(() => {
    return subscribeToFeedPostChanges((deletedPostId) => {
      setPosts((current) => current.filter((post) => String(post.id) !== deletedPostId));
    });
  }, []);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    // A page request is already queued or in flight; this tap adds nothing.
    if (appendPendingRef.current) return;
    appendPendingRef.current = true;
    void load("append").finally(() => {
      appendPendingRef.current = false;
    });
  }, [hasMore, load]);

  const refresh = useCallback(() => {
    // Queued behind anything already running, and always reads from offset 0.
    void load("replace");
  }, [load]);

  return { posts, loading, error, errorCode, hasMore, loadMore, refresh };
}