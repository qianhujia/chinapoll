-- Unified initial schema: polls terminology, configurable rate-limit buckets.
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  mode INTEGER NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  status INTEGER NOT NULL,
  reviewed_at INTEGER,
  poller_id TEXT,
  ip_prefix TEXT,
  ts_bucket INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  voter_token_hash TEXT NOT NULL,
  ip_prefix_hash TEXT NOT NULL,
  option INTEGER NOT NULL,
  ts_bucket INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_poll_voter_token
  ON votes(poll_id, voter_token_hash);

CREATE INDEX IF NOT EXISTS idx_votes_rate_limit
  ON votes(ip_prefix_hash, ts_bucket);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  comment TEXT NOT NULL,
  ip_prefix TEXT,
  ts_bucket INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_comments_poll_created
  ON comments(poll_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_comments_rate_limit
  ON comments(ip_prefix, ts_bucket);

CREATE INDEX IF NOT EXISTS idx_polls_rate_limit
  ON polls(ip_prefix, ts_bucket);

CREATE TABLE IF NOT EXISTS identities (
  poller_id TEXT PRIMARY KEY,
  email_hmac TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

