-- ChinaPoll migration 0005: verdict is its own poll type again.
--
-- Schema change plus a one-time data copy. No seed or demo rows are added.
--
-- `poll_type = 1` is the verdict poll: a single-answer poll whose options the
-- proposal form pre-fills with Approve, Neutral, and Oppose. Its ballot rules are
-- identical to a single choice poll (exactly one option per ballot), so the shared
-- options engine in worker/services/options.ts needs no special case; the type is
-- stored so a verdict poll stays identifiable, and its rows are ordinary labels in
-- `poll_options`.
--
-- 0004 turned every old `poll_type = 1` row into a single choice poll carrying
-- those three rows. This migration turns them back: a single choice poll whose only
-- options are Approve, Neutral, and Oppose at positions 1 to 3 was produced by that
-- conversion (or is exactly the wording the Verdict template produces), and since
-- the two types accept the same ballots, the classification cannot change how a
-- poll is voted on.
--
-- As in 0004, D1 runs a migration inside one transaction, where
-- `PRAGMA foreign_keys` and `PRAGMA legacy_alter_table` have no effect: dropping
-- the populated `polls` table would cascade its child rows away. Every table that
-- references `polls` is therefore rebuilt around the swap.

PRAGMA defer_foreign_keys = ON;

-- 1. Rebuild `polls` so the CHECK accepts the verdict type again. Every column
-- keeps its definition except `poll_type`. The rows that 0004 converted are
-- restored to the verdict type further down, once the new CHECK is in place.
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
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  poll_type INTEGER NOT NULL DEFAULT 2 CHECK (poll_type IN (1, 2, 3)),
  duration_seconds INTEGER
);

INSERT INTO polls_new (id, title, description, mode, start_at, end_at, status, reviewed_at,
                       owner_hash, closed_at, created_at, updated_at, poll_type, duration_seconds)
  SELECT id, title, description, mode, start_at, end_at, status, reviewed_at,
         owner_hash, closed_at, created_at, updated_at, poll_type, duration_seconds
  FROM polls;


-- The six tables that reference `polls` are rebuilt to reference `polls_new`, so
-- no live table points at `polls` when it is dropped and no row is cascaded away.
-- Their shapes are unchanged; the rows are copied with their ids.
CREATE TABLE poll_options_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 7),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  UNIQUE (poll_id, position)
);

INSERT INTO poll_options_new (id, poll_id, position, label)
  SELECT id, poll_id, position, label FROM poll_options;

CREATE TABLE votes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  voter_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO votes_new (id, poll_id, voter_token_hash, created_at)
  SELECT id, poll_id, voter_token_hash, created_at FROM votes;

CREATE TABLE vote_selections_new (
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  vote_id INTEGER NOT NULL REFERENCES votes_new(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options_new(id) ON DELETE CASCADE,
  PRIMARY KEY (vote_id, option_id)
);

INSERT INTO vote_selections_new (poll_id, vote_id, option_id)
  SELECT poll_id, vote_id, option_id FROM vote_selections;

CREATE TABLE comments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  public_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO comments_new (id, poll_id, comment, public_id, created_at)
  SELECT id, poll_id, comment, public_id, created_at FROM comments;

CREATE TABLE poll_reports_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  reason INTEGER NOT NULL CHECK (reason IN (1, 2, 3, 4, 5, 6, 7, 8)),
  note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution INTEGER CHECK (resolution IS NULL OR resolution IN (1, 2))
);

INSERT INTO poll_reports_new (id, poll_id, reason, note, created_at, resolved_at, resolution)
  SELECT id, poll_id, reason, note, created_at, resolved_at, resolution FROM poll_reports;

CREATE TABLE poll_views_new (
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  ts_day INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (poll_id, ts_day)
);

INSERT INTO poll_views_new (poll_id, ts_day, views)
  SELECT poll_id, ts_day, views FROM poll_views;

-- 3. Drop the old tables and their indexes. The children go first, so nothing
-- references `polls` when it is dropped.
DROP INDEX IF EXISTS idx_vote_selections_poll_option;
DROP TABLE vote_selections;
DROP INDEX IF EXISTS idx_votes_poll_voter_token;
DROP INDEX IF EXISTS idx_votes_poll_id;
DROP TABLE votes;
DROP TABLE poll_options;
DROP INDEX IF EXISTS idx_comments_public_id;
DROP INDEX IF EXISTS idx_comments_poll_created;
DROP TABLE comments;
DROP INDEX IF EXISTS idx_poll_reports_open;
DROP INDEX IF EXISTS idx_poll_reports_poll;
DROP TABLE poll_reports;
DROP TABLE poll_views;
DROP INDEX IF EXISTS idx_polls_status_created;
DROP TABLE polls;

ALTER TABLE polls_new RENAME TO polls;
ALTER TABLE poll_options_new RENAME TO poll_options;
ALTER TABLE votes_new RENAME TO votes;
ALTER TABLE vote_selections_new RENAME TO vote_selections;
ALTER TABLE comments_new RENAME TO comments;
ALTER TABLE poll_reports_new RENAME TO poll_reports;
ALTER TABLE poll_views_new RENAME TO poll_views;

-- 4. Restore the verdict type on the polls that 0004 converted. A poll qualifies
-- only when it is a single choice poll with exactly three options and those options
-- are the verdict wording in the verdict order, which is what 0004 wrote when it
-- converted a verdict poll. A verdict poll created after this migration needs no
-- guessing: the API stores its type directly, and its labels may be in any
-- language or renamed, so they are deliberately not used to classify it.
-- The new CHECK accepts `1`, so the update has to run after the swap.
UPDATE polls
  SET poll_type = 1
  WHERE poll_type = 2
    AND (SELECT COUNT(*) FROM poll_options WHERE poll_id = polls.id) = 3
    AND (SELECT COUNT(*) FROM poll_options
         WHERE poll_id = polls.id
           AND ((position = 1 AND label = 'Approve')
             OR (position = 2 AND label = 'Neutral')
             OR (position = 3 AND label = 'Oppose'))) = 3;

-- 5. Recreate the indexes.
CREATE INDEX idx_polls_status_created ON polls(status, created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_votes_poll_voter_token ON votes(poll_id, voter_token_hash);
CREATE INDEX idx_votes_poll_id ON votes(poll_id);
CREATE INDEX idx_vote_selections_poll_option ON vote_selections(poll_id, option_id);
CREATE UNIQUE INDEX idx_comments_public_id ON comments(public_id);
CREATE INDEX idx_comments_poll_created ON comments(poll_id, created_at DESC, public_id DESC);
CREATE INDEX idx_poll_reports_open ON poll_reports(resolved_at, poll_id);
CREATE INDEX idx_poll_reports_poll ON poll_reports(poll_id, created_at DESC);
