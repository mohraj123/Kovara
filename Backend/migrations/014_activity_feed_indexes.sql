-- Cover each contributor activity branch and its newest-first ordering.
CREATE INDEX IF NOT EXISTS idx_submissions_submitter_activity
  ON submissions (submitter, submitted_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_verifications_verifier_activity
  ON verifications (verifier, recorded_at DESC, submission_id ASC);
