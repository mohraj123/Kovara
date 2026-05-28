-- Migration 003: follows table
--
-- Maintains the current directed follow graph as:
-- follower -> followee

CREATE TABLE IF NOT EXISTS follows (
    follower   TEXT        NOT NULL,
    followee   TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower, followee)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee);
