-- ChinaPoll consolidated schema.
--
-- This single migration creates the complete current schema. All migration SQL
-- lives in this one file: the incremental migrations were folded together here
-- because nothing had been deployed yet, so a fresh database can be created in one
-- step with no obsolete columns, indexes, or intermediate table rebuilds. Keep
-- every schema change in this file and do not add new numbered migration files.
-- The consolidation dates are recorded in docs/RUNBOOK.md.
--
-- Schema only: no seed or demo rows are inserted (repository rule).
--
-- Design notes:
--   * Votes are anonymous: a ballot is one row per (poll, browser token) and only
--     the SHA-256 hash of the token is stored. Rate limiting lives in a Durable
--     Object, so no IP-derived value is ever written to the database.
--   * `poll_type` selects the ballot shape: 1 verdict (a single-answer poll whose
--     options the proposal form pre-fills with Approve, Neutral, and Oppose), 2
--     single choice, 3 multiple choice. Every type stores plain text labels in
--     `poll_options`, and the chosen options of every type live in
--     `vote_selections`, one row per selected option. `votes` therefore holds no
--     option column at all.
--   * `vote_selections` also stores `poll_id`, denormalized from its ballot, so the
--     counts of one poll can be grouped without joining back to `votes`.
--   * `stats_snapshots` stores one row per poll per hour: `ballots` and, for a
--     choice poll, `option_counts`. The canonical payload signed by the hash chain
--     is schema version 3, which covers exactly those values, the cumulative view
--     total, and the chain link.
--   * Poll reports carry no reporter identifier at all: no address, no network
--     bucket, no user id, and only an hour-coarsened `created_at`.
--   * Views are counted per poll per UTC day in `poll_views`, and no per-view row
--     exists anywhere, so a view can never be attributed to a viewer. The
--     cumulative `views` total is signed into the hourly snapshot chain.
--   * Polls keep a one-way `owner_hash` (HMAC of the server secret over
--     "owner:<userId>:<pollId>") and comments keep a one-way hash over their random
--     public id ("owner:<userId>:comment:<publicId>"); see
--     worker/services/owner.ts. A database leak without the server secret therefore
--     reveals no author links.
--   * `duration_seconds` is the poll length, and NULL means the poll has no end
--     date. `start_at` is no longer written for new polls.
--   * `closed_at` records when a poll closed so retention does not depend on
--     `updated_at`, which any edit resets.
--   * Public comment identifiers are random (`comments.public_id`) so the global
--     insertion order is not revealed.

-- Poll categories. The admin creates them; the slug is a stable identifier used
-- by the public `category=<slug>` filter. There is no seed data (repository rule),
-- but the admin Settings tab can insert a suggested set. A category is deleted
-- with `ON DELETE SET NULL` on its polls, so those polls become uncategorised.
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9-]*' AND length(slug) BETWEEN 2 AND 40),
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Polls and user submissions.
CREATE TABLE IF NOT EXISTS polls (
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
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  poll_type INTEGER NOT NULL DEFAULT 2 CHECK (poll_type IN (1, 2, 3)),
  duration_seconds INTEGER,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_polls_status_created
  ON polls(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_polls_category_status
  ON polls(category_id, status, created_at DESC);

-- Options of a choice poll, ordered by `position`. A verdict poll keeps its three
-- verdict labels here like any other poll and needs no separate table.
CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 7),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  UNIQUE (poll_id, position)
);

-- Anonymous ballots. Only the hash of a per-poll browser token identifies a voter.
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_poll_voter_token
  ON votes(poll_id, voter_token_hash);
CREATE INDEX IF NOT EXISTS idx_votes_poll_id ON votes(poll_id);

-- Selections of a ballot. One row per (ballot, option), for every poll type.
CREATE TABLE IF NOT EXISTS vote_selections (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  vote_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  PRIMARY KEY (vote_id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_vote_selections_poll_option
  ON vote_selections(poll_id, option_id);

-- Public comments. `public_id` is the random identifier returned by the public
-- API. `owner_hash` is NULL when no author can be established: a row written before
-- comments carried an owner, or a deployment without the server secret. Those rows
-- stay public and simply cannot be claimed by an account.
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  public_id TEXT NOT NULL,
  owner_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_public_id ON comments(public_id);
CREATE INDEX IF NOT EXISTS idx_comments_poll_created
  ON comments(poll_id, created_at DESC, public_id DESC);

-- User-submitted reports about a poll. Reason codes: 1 spam, 2 inappropriate,
-- 3 misleading, 4 copyright, 5 personal_info, 6 harassment, 7 illegal, 8 other.
-- Resolution codes: 1 dismissed, 2 action taken.
CREATE TABLE IF NOT EXISTS poll_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  reason INTEGER NOT NULL CHECK (reason IN (1, 2, 3, 4, 5, 6, 7, 8)),
  note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution INTEGER CHECK (resolution IS NULL OR resolution IN (1, 2))
);

CREATE INDEX IF NOT EXISTS idx_poll_reports_open ON poll_reports(resolved_at, poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_reports_poll ON poll_reports(poll_id, created_at DESC);

-- Approximate per-poll view counters. One row per poll per UTC day holding only a
-- count; `ts_day` is the start of the day in Unix seconds and a rollup row uses
-- `ts_day = 0` so long-term totals survive while daily resolution is dropped.
CREATE TABLE IF NOT EXISTS poll_views (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  ts_day INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (poll_id, ts_day)
);

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
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

-- Signed hourly statistics snapshots forming an append-only hash chain. `final`
-- is 1 only on the terminal snapshot written when a poll closes, so the chain
-- always ends on the poll's real final counts. `views` is the cumulative view
-- total, `ballots` the number of ballots, and `option_counts` the per-option
-- counts of a choice poll as JSON.
CREATE TABLE IF NOT EXISTS stats_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  ts_hour INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  ballots INTEGER NOT NULL DEFAULT 0,
  option_counts TEXT,
  UNIQUE(poll_id, ts_hour)
);

CREATE INDEX IF NOT EXISTS idx_stats_snapshots_hour ON stats_snapshots(ts_hour);

-- Publish cursor for the Worker publisher: the newest snapshot hour that has been
-- copied to the public audit repository for a poll, and whether that hour was the
-- terminal (final) record. `final` is 0 while the poll is still open, so the next
-- run re-reads the closing hour when the poll ends. The reserved row with
-- `poll_id = 0` holds the publisher batch cursor in `published_through`: the last
-- poll id a run examined, so the unprocessed remainder of the tracked polls is
-- carried to the next run.
CREATE TABLE IF NOT EXISTS publish_state (
  poll_id INTEGER PRIMARY KEY,
  published_through INTEGER NOT NULL,
  final INTEGER NOT NULL DEFAULT 0
);

-- One row per publisher run, so the dashboard and /api/health can show the recent
-- history. Only the last 50 rows are kept. The error column is NULL on success.
CREATE TABLE IF NOT EXISTS publish_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  polls_updated INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
