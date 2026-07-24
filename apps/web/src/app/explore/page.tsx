'use client';

import { useState } from 'react';
import SearchBar from '../../components/SearchBar';
import EmptyState from '../../components/EmptyState';
import { PostCardSkeletonList } from '../../components/Skeleton';

interface Post {
  id: string;
  author: string;
  content: string;
  tip_total: string;
  timestamp: string;
}

interface SearchResponse {
  posts: Post[];
  total: number;
  has_more: boolean;
}

export default function ExplorePage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (query: string) => {
    setLoading(true);
    setError(null);

    try {
      const INDEXER_API_URL = 'http://localhost:3001';

      const response = await fetch(
        `${INDEXER_API_URL}/api/search/posts`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query,
            limit: 20,
            offset: 0,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data: SearchResponse = await response.json();

      setPosts(data.posts);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Search failed'
      );

      setPosts([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      className="container mx-auto px-4 py-8"
      aria-labelledby="explore-heading"
    >
      <h1
        id="explore-heading"
        className="text-3xl font-bold mb-8"
      >
        Explore Posts
      </h1>

      <div className="mb-8">
        <SearchBar onSearch={handleSearch} />
      </div>

      <div>
        {loading && (
          <div className="my-4">
            <PostCardSkeletonList count={3} />
          </div>
        )}

        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4"
          >
            {error}
          </div>
        )}
      </div>

      {posts.length > 0 && (
        <section
          aria-label="Search Results"
          className="space-y-4"
        >
          {posts.map((post) => (
            <article
              key={post.id}
              tabIndex={0}
              role="article"
              className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <div className="flex justify-between items-start mb-2">
                <span className="text-sm text-gray-600">
                  By {post.author}
                </span>

                <time className="text-sm text-gray-500">
                  {new Date(
                    parseInt(post.timestamp) * 1000
                  ).toLocaleDateString()}
                </time>
              </div>

              <p className="text-gray-900 mb-2">
                {post.content}
              </p>

              <p className="text-sm text-gray-600">
                Tips: {post.tip_total}
              </p>
            </article>
          ))}
        </section>
      )}

      {!loading &&
        !error &&
        posts.length === 0 && (
          <EmptyState
            icon="🔍"
            title="No posts yet"
            description="Enter a search query above to discover posts from across the network."
          />
        )}
    </main>
  );
}