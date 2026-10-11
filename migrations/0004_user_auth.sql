-- Public user accounts, sessions, and auth rate-limit tracking.
-- Schema only: no seed or demo rows are inserted here.
--
-- Users sign up with a username and password only. There is no email or
-- recovery channel, so `password_hash` uses the same PBKDF2 format as the admin
-- login (`pbkdf2$iterations$salt$hash`). `ip_prefix` stores the anonymized
-- network bucket (first three octets) used for the per-IP registration cap.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  ip_prefix TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_ip_prefix ON users(ip_prefix);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- Rate-limit buckets for register and login attempts, keyed by anonymized
-- network prefix. `ts_bucket` is a millisecond bucket start, matching the vote
-- and comment rate-limit columns.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_prefix TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts_bucket INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_bucket ON auth_attempts(ip_prefix, kind, ts_bucket);

-- Polls and comments are now owned by the account that created them.
ALTER TABLE polls ADD COLUMN user_id INTEGER;
ALTER TABLE comments ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_polls_user ON polls(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id, created_at DESC, id DESC);
