-- Migration: Composite index for author + chronological post queries
-- Description:
--   listPosts with an author filter runs:
--     WHERE deleted_at IS NULL AND author = $1 ORDER BY created_at DESC
--   The existing idx_posts_author covers the equality but the planner must
--   still sort by created_at.  A composite partial index on
--   (author, created_at DESC) WHERE deleted_at IS NULL eliminates the sort
--   and narrows the scan to active rows in one step.
--
--   The global-feed path (no author filter) already benefits from
--   idx_posts_active on (created_at DESC) WHERE deleted_at IS NULL.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_author_created
  ON posts (author, created_at DESC)
  WHERE deleted_at IS NULL;
