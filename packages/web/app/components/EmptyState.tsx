/**
 * Empty-state block for the web package.
 * Issue #119 — feed and explore pages render this when 0 results are available.
 *
 * Visual treatment matches the rest of the token-driven surfaces in
 * packages/web/app/styles/globals.css (no new dependencies required).
 */

"use client";

import type { CSSProperties, ReactElement } from "react";

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  testId?: string;
}

export default function EmptyState({
  icon = "📭",
  title,
  description,
  actionLabel,
  onAction,
  testId = "empty-state",
}: EmptyStateProps): ReactElement {
  return (
    <div role="status" data-testid={testId} style={container}>
      <div aria-hidden="true" style={iconStyle}>
        {icon}
      </div>
      <h3 style={titleStyle}>{title}</h3>
      {description && <p style={descriptionStyle}>{description}</p>}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          style={actionStyle}
          aria-label={actionLabel}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

const container: CSSProperties = {
  textAlign: "center",
  padding: "var(--spacing-xl)",
  color: "var(--color-text-secondary)",
  border: "1px dashed var(--color-border)",
  borderRadius: "12px",
  background: "var(--color-bg)",
};

const iconStyle: CSSProperties = {
  fontSize: "3rem",
  marginBottom: "var(--spacing-md)",
  display: "block",
};

const titleStyle: CSSProperties = {
  fontSize: "1.25rem",
  fontWeight: 600,
  color: "var(--color-text-primary)",
  margin: "0 0 var(--spacing-sm) 0",
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  maxWidth: "32rem",
  marginLeft: "auto",
  marginRight: "auto",
};

const actionStyle: CSSProperties = {
  marginTop: "var(--spacing-lg)",
  padding: "var(--spacing-sm) var(--spacing-lg)",
  background: "var(--color-primary)",
  color: "white",
  borderRadius: "8px",
  fontWeight: 600,
  fontSize: "0.95rem",
  minHeight: "var(--min-touch-target)",
};
