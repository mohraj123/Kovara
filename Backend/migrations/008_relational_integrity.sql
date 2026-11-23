-- Migration: Add relational integrity constraints between activity tables and profiles
-- Description:
--   posts.author, follows.follower/followee, tips.tipper, and likes.user_address
--   store wallet addresses that may not yet have a profiles row -- an address can
--   post/tip/like/follow on-chain before it ever calls set_profile, and none of the
--   handlers check profile existence before inserting. Adding a foreign key without
--   accounting for that would break live indexing for any address without a profile.
--
--   1. Backfill a stub profiles row (username = address) for every address already
--      referenced by these tables but missing from profiles.
--   2. Add BEFORE INSERT triggers that upsert the same stub row so future inserts
--      always satisfy the constraint, regardless of event order.
--   3. Add the foreign keys with explicit ON DELETE policies: RESTRICT for
--      content/financial history (posts, tips) so a profile can't be removed out
--      from under existing records, CASCADE for the follow graph and likes since
--      those are pure bookkeeping edges.

-- 1. Backfill stub profiles for addresses already referenced but never indexed via ProfileSet
INSERT INTO profiles (address, username, creator_token, updated_ledger)
SELECT addr, addr, '', 0 FROM (
    SELECT author AS addr FROM posts
    UNION
    SELECT follower FROM follows
    UNION
    SELECT followee FROM follows
    UNION
    SELECT tipper FROM tips
    UNION
    SELECT user_address FROM likes
) referenced_addresses
WHERE addr <> ''
ON CONFLICT (address) DO NOTHING;

-- 2. Ensure future inserts always have a backing profile row, even if the
--    ProfileSet event for that address hasn't been indexed yet.
CREATE OR REPLACE FUNCTION ensure_profile_exists(addr TEXT) RETURNS void AS $$
BEGIN
  INSERT INTO profiles (address, username, creator_token, updated_ledger)
  VALUES (addr, addr, '', 0)
  ON CONFLICT (address) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_ensure_profile_for_post() RETURNS trigger AS $$
BEGIN
  PERFORM ensure_profile_exists(NEW.author);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_ensure_profile_for_follow() RETURNS trigger AS $$
BEGIN
  PERFORM ensure_profile_exists(NEW.follower);
  PERFORM ensure_profile_exists(NEW.followee);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_ensure_profile_for_tip() RETURNS trigger AS $$
BEGIN
  PERFORM ensure_profile_exists(NEW.tipper);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_ensure_profile_for_like() RETURNS trigger AS $$
BEGIN
  PERFORM ensure_profile_exists(NEW.user_address);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ensure_profile_before_post_insert ON posts;
CREATE TRIGGER ensure_profile_before_post_insert
  BEFORE INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION trg_ensure_profile_for_post();

DROP TRIGGER IF EXISTS ensure_profile_before_follow_insert ON follows;
CREATE TRIGGER ensure_profile_before_follow_insert
  BEFORE INSERT ON follows
  FOR EACH ROW EXECUTE FUNCTION trg_ensure_profile_for_follow();

DROP TRIGGER IF EXISTS ensure_profile_before_tip_insert ON tips;
CREATE TRIGGER ensure_profile_before_tip_insert
  BEFORE INSERT ON tips
  FOR EACH ROW EXECUTE FUNCTION trg_ensure_profile_for_tip();

DROP TRIGGER IF EXISTS ensure_profile_before_like_insert ON likes;
CREATE TRIGGER ensure_profile_before_like_insert
  BEFORE INSERT ON likes
  FOR EACH ROW EXECUTE FUNCTION trg_ensure_profile_for_like();

-- 3. Add the foreign keys now that every referenced address is guaranteed to exist
--    in profiles, with explicit delete policies.
ALTER TABLE posts
  ADD CONSTRAINT fk_posts_author
  FOREIGN KEY (author) REFERENCES profiles(address) ON DELETE RESTRICT;

ALTER TABLE follows
  ADD CONSTRAINT fk_follows_follower
  FOREIGN KEY (follower) REFERENCES profiles(address) ON DELETE CASCADE;

ALTER TABLE follows
  ADD CONSTRAINT fk_follows_followee
  FOREIGN KEY (followee) REFERENCES profiles(address) ON DELETE CASCADE;

ALTER TABLE tips
  ADD CONSTRAINT fk_tips_tipper
  FOREIGN KEY (tipper) REFERENCES profiles(address) ON DELETE RESTRICT;

ALTER TABLE likes
  ADD CONSTRAINT fk_likes_user_address
  FOREIGN KEY (user_address) REFERENCES profiles(address) ON DELETE CASCADE;
