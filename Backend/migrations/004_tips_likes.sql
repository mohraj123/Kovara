-- Migration: Create tips and likes tracking tables
-- Description: Stores individual tip and like events for idempotency and analytics

CREATE TABLE IF NOT EXISTS tips (
    id SERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES posts(id),
    tipper TEXT NOT NULL,
    amount BIGINT NOT NULL,
    fee BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS likes (
    id SERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES posts(id),
    user_address TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,

    -- Unique constraint: one like per user per post
    UNIQUE (post_id, user_address)
);
