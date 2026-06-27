/**
 * Loading skeleton primitives for the web app.
 * Issue #119 — feed and explore pages use these while data is being fetched.
 *
 * Uses Tailwind's built-in `animate-pulse` so no extra CSS or dependencies
 * are required.
 */

interface SkeletonBarProps {
  className?: string;
}

export function SkeletonBar({ className = "" }: SkeletonBarProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={`bg-gray-200 dark:bg-[color:var(--muted)] rounded animate-pulse ${className}`}
    />
  );
}

interface SkeletonCircleProps {
  size?: number;
  className?: string;
}

export function SkeletonCircle({
  size = 40,
  className = "",
}: SkeletonCircleProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={`bg-gray-200 dark:bg-[color:var(--muted)] rounded-full animate-pulse ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Skeleton placeholder that mirrors the shape of a post result card.
 * Renders three copies so the list feels alive while loading.
 */
export function PostCardSkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading posts"
      className="space-y-4"
    >
      <span className="sr-only">Loading posts…</span>
      {Array.from({ length: count }).map((_, i) => (
        <PostCardSkeleton key={i} />
      ))}
    </div>
  );
}

function PostCardSkeleton() {
  return (
    <article className="bg-white dark:bg-[color:var(--background)] border border-gray-200 dark:border-[color:var(--border)] rounded-lg p-6 shadow-sm">
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-3">
          <SkeletonCircle size={36} />
          <div className="space-y-2">
            <SkeletonBar className="h-3 w-24" />
            <SkeletonBar className="h-3 w-16" />
          </div>
        </div>
        <SkeletonBar className="h-3 w-12" />
      </div>

      <div className="space-y-2 mb-4">
        <SkeletonBar className="h-3 w-full" />
        <SkeletonBar className="h-3 w-5/6" />
        <SkeletonBar className="h-3 w-2/3" />
      </div>

      <SkeletonBar className="h-3 w-20" />
    </article>
  );
}
