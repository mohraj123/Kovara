-- Migration: Add profile uniqueness and non-empty constraints
-- Description: Ensures address and username are non-empty, and username is unique

ALTER TABLE profiles
  ADD CONSTRAINT chk_profile_address_not_empty
  CHECK (address <> '');

ALTER TABLE profiles
  ADD CONSTRAINT chk_profile_username_not_empty
  CHECK (username <> '');

ALTER TABLE profiles
  ADD CONSTRAINT uq_profile_username
  UNIQUE (username);
