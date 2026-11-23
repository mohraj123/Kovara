-- Cover each contributor activity branch and its newest-first ordering.
-- The INCLUDE columns are exactly the ones the activity page selects besides
-- the sort key, so a page can be served from the index alone (index-only scan)
-- instead of fetching every matching heap row only to discard it past the LIMIT.
CREATE INDEX IF NOT EXISTS idx_submissions_submitter_activity
  ON submissions (submitter, submitted_at DESC, id ASC) INCLUDE (status, value);
CREATE INDEX IF NOT EXISTS idx_verifications_verifier_activity
  ON verifications (verifier, recorded_at DESC, submission_id ASC) INCLUDE (verdict);
