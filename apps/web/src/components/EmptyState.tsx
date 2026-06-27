/**
 * Empty-state block for the web app.
 * Issue #119 — feed and explore pages render this when 0 results are available.
 *
 * Keeps the visual treatment consistent with the rest of the dark-themed
 * Tailwind surfaces in apps/web.
 */

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export default function EmptyState({
  icon = "📭",
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className="text-center py-12 px-4 rounded-lg border border-dashed border-gray-300 dark:border-[color:var(--border)] bg-gray-50 dark:bg-[color:var(--muted)]"
    >
      <div
        aria-hidden="true"
        className="text-5xl mb-3"
      >
        {icon}
      </div>

      <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
        {title}
      </h2>

      {description && (
        <p className="text-gray-600 dark:text-gray-400 max-w-sm mx-auto mb-6">
          {description}
        </p>
      )}

      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="inline-flex items-center justify-center px-6 py-2.5 bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)] text-white rounded-xl font-semibold transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
