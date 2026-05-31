import { useState, useEffect, useCallback, useRef } from "react";
import { Post } from "../components/PostCard";

const PAGE_SIZE = 10;

/**
 * Fetches a page of posts using cursor-based pagination.
 *
 * Replace the mock implementation with real `get_post` contract calls
 * once the Soroban client is wired up.
 */
async function fetchPostPage(cursor: number, limit: number): Promise<Post[]> {
  // Mock data — replace with LinkoraClient.getPost() calls
  const ALL_POSTS: Post[] = [
    {
      id: 1,
      author: "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      username: "stellar_dev",
      content: "Just deployed my first smart contract on Stellar! 🚀",
      tip_total: 100,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      like_count: 5,
    },
    {
      id: 2,
      author: "GXYZ9876543210ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      username: "crypto_enthusiast",
      content: "The SocialFi ecosystem is growing fast. Excited to be part of it!",
      tip_total: 50,
      timestamp: Math.floor(Date.now() / 1000) - 7200,
      like_count: 3,
    },
    {
      id: 3,
      author: "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      username: "stellar_dev",
      content: "Working on a new DeFi protocol. Stay tuned! 🔥",
      tip_total: 200,
      timestamp: Math.floor(Date.now() / 1000) - 14400,
      like_count: 12,
    },
    {
      id: 4,
      author: "GDEF5678901234ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      username: "linkora_fan",
      content: "Linkora is the future of decentralised social. #Stellar",
      tip_total: 75,
      timestamp: Math.floor(Date.now() / 1000) - 21600,
      like_count: 8,
    },
    {
      id: 5,
      author: "GHIJ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      username: "soroban_builder",
      content: "Soroban smart contracts make on-chain social possible. 🌟",
      tip_total: 300,
      timestamp: Math.floor(Date.now() / 1000) - 28800,
      like_count: 20,
    },
  ];

  // Simulate network latency
  await new Promise((r) => setTimeout(r, 400));

  // cursor is the last seen post id (0 = start from beginning)
  const startIndex = cursor === 0 ? 0 : ALL_POSTS.findIndex((p) => p.id === cursor) + 1;
  return ALL_POSTS.slice(startIndex, startIndex + limit);
}

export interface UseFeedReturn {
  posts: Post[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

export function useFeed(): UseFeedReturn {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // cursor = id of the last loaded post (0 = initial load)
  const cursorRef = useRef<number>(0);
  const loadingRef = useRef(false);

  const load = useCallback(async (cursor: number, replace: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      const fetched = await fetchPostPage(cursor, PAGE_SIZE);
      setPosts((prev) => (replace ? fetched : [...prev, ...fetched]));
      setHasMore(fetched.length >= PAGE_SIZE);
      if (fetched.length > 0) {
        cursorRef.current = fetched[fetched.length - 1].id;
      }
    } catch {
      setError("Failed to load posts. Please try again.");
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    load(0, true);
  }, [load]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      load(cursorRef.current, false);
    }
  }, [loading, hasMore, load]);

  const refresh = useCallback(() => {
    cursorRef.current = 0;
    load(0, true);
  }, [load]);

  return { posts, loading, error, hasMore, loadMore, refresh };
}
