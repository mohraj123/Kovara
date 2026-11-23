-- BA-026: a shared, monotonically increasing epoch used to coordinate the
-- in-memory caches of multiple indexer replicas that share this Postgres
-- backend. Every writer bumps the epoch; readers revalidate a cache entry by
-- comparing the entry's epoch against the latest shared value, so a mutation
-- performed on one replica is not served stale from another replica's cache.
CREATE TABLE IF NOT EXISTS cache_epoch (
  key   TEXT    PRIMARY KEY,
  epoch BIGINT  NOT NULL
);
