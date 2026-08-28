-- Migration: Create posts table
-- Description: Stores on-chain posts with soft delete support

CREATE TABLE IF NOT EXISTS posts (
    id BIGINT PRIMARY KEY,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    tip_total BIGINT NOT NULL DEFAULT 0,
    like_count BIGINT NOT NULL DEFAULT 0,
    created_ledger INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL,
    deleted_at TIMESTAMP DEFAULT NULL,
    
    -- Indexes for common queries
    INDEX idx_posts_author (author),
    INDEX idx_posts_created_at (created_at DESC),
    INDEX idx_posts_deleted_at (deleted_at)
);

-- Index for active posts (not deleted)
CREATE INDEX idx_posts_active ON posts (created_at DESC) WHERE deleted_at IS NULL;
