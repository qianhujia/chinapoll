-- Remove the legacy email-identity store and switch the anonymized network
-- bucket columns to unsigned integers.
--
-- SQLite has no unsigned integer type, so the columns are declared INTEGER and
-- every value is kept in the 0..4294967295 range. A dotted IPv4 address is
-- reduced to its /24 network as a 32-bit value (203.0.113.10 -> 203.0.113.0 =
-- 3405803776); any other value is left NULL (or 0 for NOT NULL columns) and is
-- recomputed by the application.
--
-- SQLite cannot change a column type in place, so the affected tables are
-- rebuilt. Existing rows are preserved; this file contains schema changes and
-- the in-place value transformation they require, and inserts no seed data.

-- The email-based submitter identity flow is superseded by authenticated
-- accounts (polls.user_id), so the identities table is removed.
DROP TABLE IF EXISTS identities;

-- polls: drop the legacy poller_id column and make ip_prefix an integer.
CREATE TABLE polls_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  mode INTEGER NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  status INTEGER NOT NULL,
  reviewed_at INTEGER,
  ip_prefix INTEGER,
  ts_bucket INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id INTEGER
);

INSERT INTO polls_new (id, title, description, mode, start_at, end_at, status, reviewed_at, ip_prefix, ts_bucket, created_at, updated_at, user_id)
SELECT id, title, description, mode, start_at, end_at, status, reviewed_at,
  CASE WHEN ip_prefix IS NULL OR instr(ip_prefix, '.') = 0 THEN NULL ELSE
    CAST(substr(ip_prefix, 1, instr(ip_prefix, '.') - 1) AS INTEGER) * 16777216 +
    CAST(CASE WHEN instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') > 0
              THEN substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), 1, instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') - 1)
              ELSE substr(ip_prefix, instr(ip_prefix, '.') + 1) END AS INTEGER) * 65536 +
    CAST(CASE WHEN instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') > 0
              THEN substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1, instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') - 1)
              ELSE substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1) END AS INTEGER) * 256
  END,
  ts_bucket, created_at, updated_at, user_id
FROM polls;

DROP TABLE polls;
ALTER TABLE polls_new RENAME TO polls;
CREATE INDEX IF NOT EXISTS idx_polls_rate_limit ON polls(ip_prefix, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_polls_user ON polls(user_id, created_at DESC, id DESC);

-- comments: make ip_prefix an integer.
CREATE TABLE comments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  comment TEXT NOT NULL,
  ip_prefix INTEGER,
  ts_bucket INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id INTEGER
);

INSERT INTO comments_new (id, poll_id, comment, ip_prefix, ts_bucket, created_at, user_id)
SELECT id, poll_id, comment,
  CASE WHEN ip_prefix IS NULL OR instr(ip_prefix, '.') = 0 THEN NULL ELSE
    CAST(substr(ip_prefix, 1, instr(ip_prefix, '.') - 1) AS INTEGER) * 16777216 +
    CAST(CASE WHEN instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') > 0
              THEN substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), 1, instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') - 1)
              ELSE substr(ip_prefix, instr(ip_prefix, '.') + 1) END AS INTEGER) * 65536 +
    CAST(CASE WHEN instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') > 0
              THEN substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1, instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') - 1)
              ELSE substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1) END AS INTEGER) * 256
  END,
  ts_bucket, created_at, user_id
FROM comments;

DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX IF NOT EXISTS idx_comments_poll_created ON comments(poll_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_comments_rate_limit ON comments(ip_prefix, ts_bucket);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id, created_at DESC, id DESC);

-- users: make ip_prefix an integer.
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  ip_prefix INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO users_new (id, username, password_hash, status, failed_attempts, locked_until, last_login_at, ip_prefix, created_at, updated_at)
SELECT id, username, password_hash, status, failed_attempts, locked_until, last_login_at,
  CASE WHEN ip_prefix IS NULL OR instr(ip_prefix, '.') = 0 THEN NULL ELSE
    CAST(substr(ip_prefix, 1, instr(ip_prefix, '.') - 1) AS INTEGER) * 16777216 +
    CAST(CASE WHEN instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') > 0
              THEN substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), 1, instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') - 1)
              ELSE substr(ip_prefix, instr(ip_prefix, '.') + 1) END AS INTEGER) * 65536 +
    CAST(CASE WHEN instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') > 0
              THEN substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1, instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') - 1)
              ELSE substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1) END AS INTEGER) * 256
  END,
  created_at, updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX IF NOT EXISTS idx_users_ip_prefix ON users(ip_prefix);

-- auth_attempts: make ip_prefix an integer (NOT NULL, so non-IPv4 becomes 0).
CREATE TABLE auth_attempts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_prefix INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ts_bucket INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO auth_attempts_new (id, ip_prefix, kind, ts_bucket, created_at)
SELECT id,
  CASE WHEN ip_prefix IS NULL OR instr(ip_prefix, '.') = 0 THEN 0 ELSE
    CAST(substr(ip_prefix, 1, instr(ip_prefix, '.') - 1) AS INTEGER) * 16777216 +
    CAST(CASE WHEN instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') > 0
              THEN substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), 1, instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') - 1)
              ELSE substr(ip_prefix, instr(ip_prefix, '.') + 1) END AS INTEGER) * 65536 +
    CAST(CASE WHEN instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') > 0
              THEN substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1, instr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), '.') - 1)
              ELSE substr(substr(substr(ip_prefix, instr(ip_prefix, '.') + 1), instr(substr(ip_prefix, instr(ip_prefix, '.') + 1), '.') + 1), 1) END AS INTEGER) * 256
  END,
  kind, ts_bucket, created_at
FROM auth_attempts;

DROP TABLE auth_attempts;
ALTER TABLE auth_attempts_new RENAME TO auth_attempts;
CREATE INDEX IF NOT EXISTS idx_auth_attempts_bucket ON auth_attempts(ip_prefix, kind, ts_bucket);

