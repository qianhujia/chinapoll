-- Ownership, lifecycle timestamps, declared constraints, and indexes.
--
-- Policy: polls keep a one-way `owner_hash` (HMAC of the server secret with
-- "owner:<userId>:<pollId>"), and comments keep no owner at all. A database leak
-- without `IP_HASH_KEY` therefore reveals no author links. `closed_at` records
-- when a poll closed so retention does not depend on `updated_at`, which any edit
-- resets.
--
-- SQLite cannot add or remove constraints in place, so the affected tables are
-- rebuilt. Schema only: no seed or demo rows are inserted. Foreign-key checks are
-- deferred for the duration of the migration.

PRAGMA defer_foreign_keys = ON;

-- polls: drop user_id, add owner_hash and closed_at, and declare the checks the
-- application relies on.
DROP INDEX IF EXISTS idx_polls_user;
DROP INDEX IF EXISTS idx_polls_rate_limit;
CREATE TABLE polls_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT CHECK (title IS NULL OR length(trim(title)) > 0),
  description TEXT,
  mode INTEGER NOT NULL CHECK (mode IN (1, 2)),
  start_at INTEGER,
  end_at INTEGER,
  status INTEGER NOT NULL CHECK (status IN (1, 2, 3, 4)),
  reviewed_at INTEGER,
  owner_hash TEXT,
  closed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO polls_new (id, title, description, mode, start_at, end_at, status, reviewed_at, created_at, updated_at)
SELECT id, NULLIF(trim(title), ''), description, mode, start_at, end_at, status, reviewed_at, created_at, updated_at
FROM polls;

DROP TABLE polls;
ALTER TABLE polls_new RENAME TO polls;

-- votes: declare option and foreign-key checks and keep the per-poll uniqueness.
DROP INDEX IF EXISTS idx_votes_rate_limit;
CREATE TABLE votes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_token_hash TEXT NOT NULL,
  option INTEGER NOT NULL CHECK (option IN (1, 2, 3)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO votes_new (id, poll_id, voter_token_hash, option, created_at)
SELECT id, poll_id, voter_token_hash, option, created_at FROM votes;

DROP TABLE votes;
ALTER TABLE votes_new RENAME TO votes;

-- comments: drop the unused owner column, require a random public id, and
-- cascade with the poll.
DROP INDEX IF EXISTS idx_comments_user;
DROP INDEX IF EXISTS idx_comments_rate_limit;
DROP INDEX IF EXISTS idx_comments_poll_created;
CREATE TABLE comments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  public_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO comments_new (id, poll_id, comment, public_id, created_at)
SELECT id, poll_id, comment, COALESCE(public_id, lower(hex(randomblob(8)))), created_at
FROM comments;

DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;

-- user_sessions: cascade when the account row is deleted.
CREATE TABLE user_sessions_new (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

INSERT INTO user_sessions_new (token_hash, user_id, created_at, expires_at)
SELECT token_hash, user_id, created_at, expires_at FROM user_sessions;

DROP TABLE user_sessions;
ALTER TABLE user_sessions_new RENAME TO user_sessions;

-- Recreate the indexes that referenced the rebuilt tables, plus the ones the
-- list queries rely on. `idx_stats_snapshots_poll` duplicates the
-- UNIQUE(poll_id, ts_hour) constraint, so it is replaced by a ts_hour index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_poll_voter_token
  ON votes(poll_id, voter_token_hash);
CREATE INDEX IF NOT EXISTS idx_votes_poll_option ON votes(poll_id, option);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_public_id ON comments(public_id);
CREATE INDEX IF NOT EXISTS idx_comments_poll_created
  ON comments(poll_id, created_at DESC, public_id DESC);

CREATE INDEX IF NOT EXISTS idx_polls_status_created
  ON polls(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_polls_owner ON polls(owner_hash);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

DROP INDEX IF EXISTS idx_stats_snapshots_poll;
CREATE INDEX IF NOT EXISTS idx_stats_snapshots_hour ON stats_snapshots(ts_hour);