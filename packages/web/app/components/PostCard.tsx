"use client";

import { useLike } from "../hooks/useLike";

export interface Post {
  id: number;
  author: string;
  content: string;
  tip_total: number;
  timestamp: number;
  like_count: number;
  username?: string;
}

interface PostCardProps {
  post: Post;
  /** Optional notification fired after a like is committed (e.g. to refresh). */
  onLike?: (postId: number) => void;
  onTip?: (postId: number) => void;
  /** Initial liked state, derived from the contract's `has_liked`. */
  isLiked?: boolean;
}

export function PostCard({
  post,
  onLike,
  onTip,
  isLiked = false,
}: PostCardProps) {
  const { liked, likeCount, pending, error, like, unlike } = useLike({
    postId: post.id,
    initialHasLiked: isLiked,
    initialLikeCount: post.like_count,
  });

  const handleLike = async () => {
    if (pending) return;
    const committed = liked ? await unlike() : await like();
    if (committed) onLike?.(post.id);
  };

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts * 1000);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));

    if (hours < 1) return "Just now";
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  const formatTipTotal = (amount: number) => {
    return (amount / 10_000_000).toFixed(2);
  };

  return (
    <article style={styles.card}>
      <div style={styles.header}>
        <div style={styles.avatar}></div>
        <div style={styles.authorInfo}>
          <div style={styles.username}>
            {post.username || formatAddress(post.author)}
          </div>
          <div style={styles.timestamp}>{formatTimestamp(post.timestamp)}</div>
        </div>
      </div>

      <div style={styles.content}>{post.content}</div>

      <div style={styles.actions}>
<button
           onClick={handleLike}
           disabled={pending}
           style={{
             ...styles.actionButton,
             ...(liked ? styles.likedButton : {}),
           }}
           aria-label={liked ? "Unlike post" : "Like post"}
           aria-pressed={liked}
           title={error ?? undefined}
         >
           <span style={styles.icon}>{liked ? "❤️" : "🤍"}</span>
           <span>{likeCount}</span>
         </button>

        <div style={styles.tipBadge}>
          <span style={styles.icon}>💎</span>
          <span>{formatTipTotal(post.tip_total)} XLM</span>
        </div>

        {onTip && (
          <button
            onClick={() => onTip(post.id)}
            style={styles.tipButton}
            aria-label="Tip author"
          >
            Tip
          </button>
        )}
      </div>
    </article>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "var(--color-bg)",
    border: "1px solid var(--color-border)",
    borderRadius: "12px",
    padding: "var(--spacing-lg)",
    marginBottom: "var(--spacing-md)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    marginBottom: "var(--spacing-md)",
    gap: "var(--spacing-sm)",
  },
  avatar: {
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    background: "var(--color-bg-secondary)",
  },
  authorInfo: {
    flex: 1,
  },
  username: {
    fontWeight: 600,
    fontSize: "0.95rem",
  },
  timestamp: {
    fontSize: "0.85rem",
    color: "var(--color-text-secondary)",
  },
  content: {
    marginBottom: "var(--spacing-md)",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-md)",
  },
  actionButton: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-xs)",
    padding: "var(--spacing-sm) var(--spacing-md)",
    borderRadius: "8px",
    background: "var(--color-bg-secondary)",
    transition: "all 0.2s",
    minHeight: "var(--min-touch-target)",
  },
  likedButton: {
    background: "#fee2e2",
    color: "var(--color-like)",
  },
  icon: {
    fontSize: "1.1rem",
  },
  tipBadge: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-xs)",
    padding: "var(--spacing-sm) var(--spacing-md)",
    background: "var(--color-bg-secondary)",
    borderRadius: "8px",
    fontSize: "0.9rem",
  },
  tipButton: {
    marginLeft: "auto",
    padding: "var(--spacing-sm) var(--spacing-lg)",
    background: "var(--color-primary)",
    color: "white",
    borderRadius: "8px",
    fontWeight: 600,
    transition: "background 0.2s",
    minHeight: "var(--min-touch-target)",
  },
};
