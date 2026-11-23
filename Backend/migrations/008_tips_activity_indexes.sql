-- Migration: Add indexes for tip activity lookups
-- Description: Adds indexes on tips(post_id) and tips(tipper) so tip
-- history can be filtered efficiently by post or by tipper, plus an index
-- on created_at to support reverse-chronological listings. These were
-- originally declared inside 004_tips_likes.sql using MySQL-style inline
-- "INDEX name (col)" table items, which are not valid PostgreSQL syntax and
-- fail to apply. They are re-declared here as standard CREATE INDEX
-- statements so they actually take effect.

CREATE INDEX IF NOT EXISTS idx_tips_post_id ON tips (post_id);
CREATE INDEX IF NOT EXISTS idx_tips_tipper ON tips (tipper);
CREATE INDEX IF NOT EXISTS idx_tips_created_at ON tips (created_at DESC);
