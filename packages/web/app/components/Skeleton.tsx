/**
 * Loading skeleton primitives for the web package.
 * Issue #119 — feed and explore pages use these while data is being fetched.
 *
 * Uses the `pulse` keyframe and design-token CSS variables already defined
 * in packages/web/app/styles/globals.css.
 */

import type { CSSProperties, ReactElement } from "react";

const baseBarStyle: CSSProperties = {
  background: "var(--color-bg-secondary)",
  borderRadius: "var(--radius-md)",
  animation: "pulse 1.5s ease-in-out infinite",
};

interface SkeletonBarProps {
  width?: number | string;
  height?: number;
  style?: CSSProperties;
}

export function SkeletonBar({
  width = "100%",
  height = 12,
  style,
}: SkeletonBarProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      style={{ ...baseBarStyle, width, height, ...style }}
    />
  );
}

interface SkeletonCircleProps {
  size: number;
  style?: CSSProperties;
}

export function SkeletonCircle({ size, style }: SkeletonCircleProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      style={{
        ...baseBarStyle,
        width: size,
        height: size,
        borderRadius: "50%",
        ...style,
      }}
    />
  );
}

/**
 * Skeleton placeholder that mirrors the shape of a PostCard.
 * Renders N copies (default 3) so the feed feels alive while loading.
 */
export function PostCardSkeletonList({
  count = 3,
}: {
  count?: number;
}): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading posts"
      style={listContainer}
    >
      <span style={srOnly}>Loading…</span>
      {Array.from({ length: count }).map((_, i) => (
        <PostCardSkeleton key={i} />
      ))}
    </div>
  );
}

function PostCardSkeleton() {
  return (
    <article style={cardStyle} aria-hidden="true">
      <div style={headerStyle}>
        <SkeletonCircle size={40} />
        <div style={metaStyle}>
          <SkeletonBar width={104} height={14} />
          <SkeletonBar width={72} height={10} style={{ marginTop: 6 }} />
        </div>
        <SkeletonBar width={48} height={10} />
      </div>

      <SkeletonBar width="100%" height={12} style={{ marginTop: 16 }} />
      <SkeletonBar width="82%" height={12} style={{ marginTop: 8 }} />
      <SkeletonBar width="56%" height={12} style={{ marginTop: 8 }} />

      <div style={footerStyle}>
        <SkeletonBar width={56} height={10} />
        <SkeletonBar width={56} height={10} />
      </div>
    </article>
  );
}

const listContainer: CSSProperties = {
  maxWidth: 600,
  margin: "0 auto",
  padding: "var(--spacing-md)",
};

const cardStyle: CSSProperties = {
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  borderRadius: "12px",
  padding: "var(--spacing-lg)",
  marginBottom: "var(--spacing-md)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--spacing-sm)",
};

const metaStyle: CSSProperties = {
  flex: 1,
};

const footerStyle: CSSProperties = {
  display: "flex",
  gap: "var(--spacing-md)",
  marginTop: "var(--spacing-md)",
};

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
