-- Migration: Add indexes for like membership and counts
-- Description: Adds indexes on likes(post_id) and likes(user_address) so
-- per-post like listings and per-user "did this user like this post"
-- membership checks are indexed, plus an index on created_at for
-- reverse-chronological listings. These were originally declared inside
-- 004_tips_likes.sql using MySQL-style inline "INDEX name (col)" table
-- items, which are not valid PostgreSQL syntax and fail to apply. They are
-- re-declared here as standard CREATE INDEX statements so they actually
-- take effect. The existing UNIQUE (post_id, user_address) constraint from
-- 004_tips_likes.sql is untouched, so duplicate-like protection is
-- unchanged.

CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes (post_id);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes (user_address);
CREATE INDEX IF NOT EXISTS idx_likes_created_at ON likes (created_at DESC);
