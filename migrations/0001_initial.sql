-- ChinaPoll consolidated schema.
--
-- This single migration creates the complete current schema. It supersedes the
-- earlier incremental migrations (0001-0010), which were folded together here so
-- a fresh database can be created in one step with no obsolete columns, indexes,
-- or intermediate table rebuilds.
--
-- Schema only: no seed or demo rows are inserted.
--
-- Design notes:
--   * Votes are anonymous: only the SHA-256 hash of a per-poll browser token is
--     stored. Rate limiting lives in a Durable Object, so no IP-derived value is
--     ever written to the database.
--   * The per-network account cap is enforced from `auth_attempts`, which keeps
--     only a keyed, daily-rotated hash (see worker/services/ip.ts).
--   * Public comment identifiers are random (`comments.public_id`) so the global
--     insertion order is not revealed.

-- Polls and user submissions.
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  mode INTEGER NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  status INTEGER NOT NULL,
  reviewed_at INTEGER,
  user_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_polls_user ON polls(user_id, created_at DESC, id DESC);

-- Anonymous votes. Only the hash of a per-poll browser token identifies a voter.
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  voter_token_hash TEXT NOT NULL,
  option INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_poll_voter_token
  ON votes(poll_id, voter_token_hash);

-- Public comments. `user_id` is nullable (detached on account deletion) and
-- `public_id` is the random identifier returned by the public API.
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  comment TEXT NOT NULL,
  user_id INTEGER,
  public_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_comments_poll_created
  ON comments(poll_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_comments_user
  ON comments(user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_public_id ON comments(public_id);

-- Application settings (the single source of truth for feature flags).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Public user accounts. Passwords use PBKDF2 (pbkdf2$iterations$salt$hash); the
-- single recovery code is stored only as a hash.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  recovery_code_hash TEXT,
  recovery_code_updated_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
-- Keyed, daily-rotated network hashes used for the rolling per-network account
-- cap. The raw address is never stored.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_hash_kind
  ON auth_attempts(ip_hash, kind, created_at);

-- Admin authentication, sessions, and audit log for the standalone admin Worker.
-- role: 1 = admin, 2 = super admin. Audit entries never store client IP addresses.
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  role INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(admin_user_id);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action);

-- Signed hourly statistics snapshots forming an append-only hash chain.
CREATE TABLE IF NOT EXISTS stats_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  ts_hour INTEGER NOT NULL,
  approve INTEGER NOT NULL,
  oppose INTEGER NOT NULL,
  neutral INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE(poll_id, ts_hour)
);

CREATE INDEX IF NOT EXISTS idx_stats_snapshots_poll ON stats_snapshots(poll_id, ts_hour);