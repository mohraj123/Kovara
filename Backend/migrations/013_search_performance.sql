-- Migration: Search performance and unified search indexes
-- Description: Makes the search substring fallback index-backed (Issue #660).
--
-- Why this migration exists
-- -----------------------
-- The existing post search matches with:
--
--     search_vector @@ plainto_tsquery('simple', $1)
--     OR content ILIKE '%' || $1 || '%'
--
-- A leading-wildcard ILIKE cannot use a btree index, so the planner cannot use
-- an index to satisfy the OR: it must choose a sequential scan to avoid the risk
-- of the cheap branch not being selective. The existing GIN index on
-- search_vector therefore is never used, even though it exists.
--
-- The fix has two halves:
--
--   1. pg_trgm + a GIN trigram index on posts.content, so the substring branch
--      is itself index-backed. The planner can then satisfy either branch of the
--      OR from an index, which is what lets it prefer an index scan.
--   2. Supporting indexes for the other two searchable entities — profiles
--      (username) and categories (the post category column), so a unified search
--      does not sequentially scan either.
--
-- pg_trgm is created in its own transaction boundary, guarded so it is skipped
-- on managed Postgres where the installing role may lack permission and the
-- extension is already present. If it is genuinely unavailable the service still
-- works — it falls back to the sequential substring scan, exactly as it does
-- today — so this is a performance migration and never a hard startup failure.

-- ── pg_trgm ────────────────────────────────────────────────────────────────
-- CREATE EXTENSION IF NOT EXISTS cannot be run inside the migration runner's
-- implicit transaction together with the index DDL in some configurations, so
-- it is attempted separately and failure tolerated.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    -- No permission, or the extension is not available in this distribution.
    -- Substring search still works without it; only the speed does not.
    RAISE NOTICE 'pg_trgm unavailable; substring search falls back to sequential scan';
END
$$;

-- ── posts: trigram index for the substring fallback ────────────────────────
-- Only created when pg_trgm is actually present: a GIN index on an operator
-- class that does not exist is a hard error, and that would fail the migration
-- for every deployment without the extension.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    -- gin_trgm_ops supports ILIKE '%term%' and similarity().
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_content_trgm ON posts USING GIN (content gin_trgm_ops)';
    -- Older installations may predate a category column entirely; the search
    -- path guards on its presence, and so does the index.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'posts' AND column_name = 'category'
    ) THEN
      -- Category is searched by substring and grouped for counts.
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_category_trgm ON posts USING GIN (category gin_trgm_ops)';
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_posts_category_count ON posts (category) WHERE deleted_at IS NULL AND category IS NOT NULL';
    END IF;
  END IF;
END
$$;

-- ── profiles: substring/prefix search ──────────────────────────────────────
-- btree_prefix_ops supports ILIKE 'term%' (prefix) but not '%term%'. The unified
-- search uses a substring match for profiles, so a trgm index is the one that
-- serves it; this is created under the same pg_trgm guard.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_profiles_username_trgm ON profiles USING GIN (username gin_trgm_ops)';
  END IF;
END
$$;

-- Prefix search for the common "user types the start of a handle" case, which
-- btree_prefix_ops can serve directly and much more cheaply than a trigram scan.
-- Separate from the trgm index so the cheaper index is available even where
-- pg_trgm could not be installed.
CREATE INDEX IF NOT EXISTS idx_profiles_username_prefix
  ON profiles (username varchar_pattern_ops);

-- ── existing full-text index, made partial ─────────────────────────────────
-- Posts that are deleted can never be returned by search (every search path
-- filters `deleted_at IS NULL`), so carrying them in the index wastes space and
-- slows the index-only scans that ranking depends on. Recreated as a partial
-- index when the old full index is present, because CREATE INDEX IF NOT EXISTS
-- would otherwise silently keep the unfiltered version.
DROP INDEX IF EXISTS idx_posts_search_vector;
CREATE INDEX IF NOT EXISTS idx_posts_search_vector
  ON posts USING GIN (search_vector)
  WHERE deleted_at IS NULL;

-- ── cache_epoch, guaranteed present ─────────────────────────────────────────
-- Issue #662 depends on this table for cross-replica invalidation, and the
-- service already creates it defensively at startup (db.ts). This migration's
-- runner keys on the filename prefix, and the earlier 008_cache_coordination
-- file is one of several files sharing the 008 prefix — so on a fresh install
-- that file is skipped and this table is never created by the runner at all.
-- Creating it here as well makes the dependency explicit and ordered: if 008 was
-- skipped, this guarantees the table before any code reads it. IF NOT EXISTS
-- makes it a no-op on installs where 008 did apply.
CREATE TABLE IF NOT EXISTS cache_epoch (
  key   TEXT    PRIMARY KEY,
  epoch BIGINT  NOT NULL
);

-- The epoch counter is read on every cached read. Seeded so a reader never sees
-- NULL on a brand-new database.
INSERT INTO cache_epoch (key, epoch)
VALUES ('global', 0)
  ON CONFLICT (key) DO NOTHING;
