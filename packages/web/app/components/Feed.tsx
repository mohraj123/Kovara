"use client";

import { PostCard, Post } from "./PostCard";
import EmptyState from "./EmptyState";
import { PostCardSkeletonList } from "./Skeleton";

interface FeedProps {
  posts: Post[];
  loading?: boolean;
  onLike?: (postId: number) => void;
  onTip?: (postId: number) => void;
  likedPosts?: Set<number>;
}

export function Feed({
  posts,
  loading,
  onLike,
  onTip,
  likedPosts = new Set(),
}: FeedProps) {
  if (loading) {
    return (
      <div style={styles.container}>
        <PostCardSkeletonList count={3} />
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div style={styles.container}>
        <EmptyState
          icon="👥"
          title="No posts yet"
          description="Follow accounts to see their updates in your feed."
        />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onLike={onLike}
          onTip={onTip}
          isLiked={likedPosts.has(post.id)}
        />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "600px",
    margin: "0 auto",
    padding: "var(--spacing-md)",
  },
};
