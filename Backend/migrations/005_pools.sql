CREATE OR REPLACE FUNCTION validate_pool_admin_list(admins jsonb, threshold integer)
RETURNS boolean AS $$
SELECT
  json_typeof(admins) = 'array'
  AND threshold BETWEEN 1 AND json_array_length(admins)
  AND json_array_length(admins) = (
    SELECT count(DISTINCT value) FROM json_array_elements_text(admins)
  )
  AND NOT EXISTS (
    SELECT 1 FROM json_array_elements_text(admins)
    WHERE value !~ '^G[A-Z2-7]{55}$'
  )
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS pools (
    pool_id        TEXT        PRIMARY KEY,
    token          TEXT        NOT NULL,
    balance        NUMERIC(39,0) NOT NULL DEFAULT 0,
    admins         JSONB       NOT NULL DEFAULT '[]',
    threshold      INTEGER     NOT NULL CHECK (validate_pool_admin_list(admins, threshold)),
    created_ledger INTEGER     NOT NULL,
    updated_ledger INTEGER     NOT NULL,
    CHECK (balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pools_token ON pools (token);
