-- Configurable rate limits use per-action time buckets (ts_bucket) instead of fixed-hour columns.
ALTER TABLE votes ADD COLUMN ts_bucket INTEGER;
ALTER TABLE votes DROP COLUMN ts_hour;

ALTER TABLE comments ADD COLUMN ip_prefix TEXT;
ALTER TABLE comments ADD COLUMN ts_bucket INTEGER;

ALTER TABLE issues ADD COLUMN ip_prefix TEXT;
ALTER TABLE issues ADD COLUMN ts_bucket INTEGER;

CREATE INDEX IF NOT EXISTS idx_votes_rate_limit
  ON votes(ip_prefix_hash, ts_bucket);

CREATE INDEX IF NOT EXISTS idx_comments_rate_limit
  ON comments(ip_prefix, ts_bucket);

CREATE INDEX IF NOT EXISTS idx_issues_rate_limit
  ON issues(ip_prefix, ts_bucket);
