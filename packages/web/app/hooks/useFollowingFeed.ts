"use client";

import { useState, useEffect, useCallback } from "react";
import { KovaraClient, Post } from "Kovara-sdk";

const client = new KovaraClient({
  contractId: "CCYOURCONTRACTIDHERE",
  rpcUrl: "https://soroban-testnet.stellar.org",
});

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useFollowingFeed(walletAddress: string | null) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const loadFeed = useCallback(async () => {
    if (!walletAddress) return;

    try {
      setLoading(true);
      const offset = page * 10;
      const limit = 10;

      // Get list of followed accounts
      const following = await client.getFollowing(walletAddress);
      const followingPage = following.slice(offset, offset + limit);

      if (followingPage.length === 0 && page === 0) {
        setPosts([]);
        setHasMore(false);
        setLoading(false);
        return;
      }

      // Fetch posts from each followed account
      const allPosts: Post[] = [];
      for (const author of followingPage) {
        const postIds = await client.getPostsByAuthor(author, 0, 10);
        for (const postId of postIds) {
          const post = await client.getPost(postId);
          if (post) {
            const profile = await client.getProfile(author);
            allPosts.push({ ...post, username: profile?.username || post.username });
          }
        }
      }

      // Sort by timestamp descending
      allPosts.sort((a, b) => b.timestamp - a.timestamp);

      if (page === 0) {
        setPosts(allPosts);
      } else {
        setPosts((prev) => [...prev, ...allPosts]);
      }

      setHasMore(followingPage.length >= limit);
    } catch (err) {
      setError("Failed to load feed");
    } finally {
      setLoading(false);
    }
  }, [walletAddress, page]);

  useEffect(() => {
    if (walletAddress) {
      loadFeed();
    } else {
      setPosts([]);
      setLoading(false);
    }
  }, [walletAddress, loadFeed]);

  const loadMore = useCallback(() => {
    setPage((prev) => prev + 1);
  }, []);

  return {
    posts,
    loading,
    error,
    hasMore,
    loadMore,
    refresh: loadFeed,
  };
}
