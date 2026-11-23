-- Migration: Persist the ledger that created each post
-- Description: Adds created_ledger for databases initialized before the field existed

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS created_ledger INTEGER NOT NULL DEFAULT 0;