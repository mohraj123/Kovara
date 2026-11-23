-- Migration: Add composite index for follower-list pagination
-- Description: The follows table's PRIMARY KEY (follower, followee) already
-- supports efficient bounded/keyset pagination of the "following" list
-- (WHERE follower = $1 [AND followee > $2] ORDER BY followee). The
-- "followers" list is queried in the opposite direction
-- (WHERE followee = $1 [AND follower > $2] ORDER BY follower), which the
-- existing single-column idx_follows_followee index cannot satisfy without
-- an extra sort. This composite index covers that direction so both
-- relationship directions have a bounded, indexed pagination path.

CREATE INDEX IF NOT EXISTS idx_follows_followee_follower ON follows (followee, follower);
