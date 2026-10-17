-- ChinaPoll migration 0004: two poll types and one selection table.
--
-- Schema changes plus a one-time data copy. No seed or demo rows are added.
--
-- Design notes:
--   * A "verdict" poll was never a different shape on the database side: it is a
--     single choice poll whose options happen to be Approve, Neutral, and Oppose.
--     This migration converts every `poll_type = 1` poll into exactly that and
--     narrows the CHECK to `poll_type IN (2, 3)`, so only single choice (2) and
--     multiple choice (3) remain.
--   * `poll_options.label` is the whole option identity besides `id`: there is no
--     preset or virtual column, and every poll type stores plain text labels.
--   * `votes` becomes a ballot table only (`id`, `poll_id`, `voter_token_hash`,
--     `created_at`), and the chosen options live in `vote_selections`, one row
--     per selected option, for every poll type. Every reference cascades.
--   * `stats_snapshots.approve/oppose/neutral` are retained because they hold the
--     counts of records signed before schema version 3, which must stay
--     verifiable; they now default to 0 and new rows do not write them.
--
-- D1 runs a migration inside one transaction, and inside a transaction
-- `PRAGMA foreign_keys` and `PRAGMA legacy_alter_table` have no effect. Dropping
-- a parent table therefore performs its implicit DELETE and cascades the child
-- rows away. So every table that references `polls` is rebuilt to reference
-- `polls_new`, the old children are dropped first, and only then is `polls`
-- dropped and the new tables renamed into place.

PRAGMA defer_foreign_keys = ON;

-- 1. A verdict poll becomes a single choice poll with three labeled rows:
--    Approve (position 1), Neutral (2), and Oppose (3).
INSERT INTO poll_options (poll_id, position, label)
  SELECT id, 1, 'Approve' FROM polls WHERE poll_type = 1;
INSERT INTO poll_options (poll_id, position, label)
  SELECT id, 2, 'Neutral' FROM polls WHERE poll_type = 1;
INSERT INTO poll_options (poll_id, position, label)
  SELECT id, 3, 'Oppose' FROM polls WHERE poll_type = 1;

UPDATE polls SET poll_type = 2 WHERE poll_type = 1;

-- 2. Rebuild `polls` with the narrowed CHECK. Every column keeps its definition
-- except `poll_type`, whose default becomes 2.
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
  poll_type INTEGER NOT NULL DEFAULT 2 CHECK (poll_type IN (2, 3)),
  duration_seconds INTEGER
);

INSERT INTO polls_new (id, title, description, mode, start_at, end_at, status, reviewed_at,
                       owner_hash, closed_at, created_at, updated_at, poll_type, duration_seconds)
  SELECT id, title, description, mode, start_at, end_at, status, reviewed_at,
         owner_hash, closed_at, created_at, updated_at, poll_type, duration_seconds
  FROM polls;

-- `poll_options` keeps its shape; it is rebuilt only because it references
-- `polls`. The option rows are copied with their ids, so a selection keeps
-- pointing at the same option.
CREATE TABLE poll_options_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 7),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  UNIQUE (poll_id, position)
);

INSERT INTO poll_options_new (id, poll_id, position, label)
  SELECT id, poll_id, position, label FROM poll_options;

-- `votes` loses the verdict code: a ballot row holds no choice data any more.
CREATE TABLE votes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  voter_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO votes_new (id, poll_id, voter_token_hash, created_at)
  SELECT id, poll_id, voter_token_hash, created_at FROM votes;

-- `vote_selections` gains `poll_id` and holds one row per chosen option for
-- every poll type.
CREATE TABLE vote_selections_new (
  poll_id INTEGER NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
  vote_id INTEGER NOT NULL REFERENCES votes_new(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options_new(id) ON DELETE CASCADE,
  PRIMARY KEY (vote_id, option_id)
);

-- Copy the existing choice selections, filling `poll_id` from the ballot row.
INSERT INTO vote_selections_new (poll_id, vote_id, option_id)
  SELECT v.poll_id, vs.vote_id, vs.option_id
  FROM vote_selections vs
  JOIN votes v ON v.id = vs.vote_id;

-- Copy the old verdict ballots as one selection each, resolved by the label of
-- the option row: old code 1 -> Approve, 2 -> Oppose, 3 -> Neutral.
INSERT INTO vote_selections_new (poll_id, vote_id, option_id)
  SELECT v.poll_id, v.id, o.id
  FROM votes v
  JOIN poll_options_new o ON o.poll_id = v.poll_id
  WHERE v.option IN (1, 2, 3)
    AND o.label = CASE v.option
      WHEN 1 THEN 'Approve'
      WHEN 2 THEN 'Oppose'
      ELSE 'Neutral'
    END;

-- The remaining children of `polls` are rebuilt for the same reason: their rows
-- must survive the parent swap.
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


-- 3. Drop the obsolete tables and their indexes. The children go first, so
-- nothing references `polls` when it is dropped and no row is cascaded away.
DROP INDEX IF EXISTS idx_vote_selections_option;
DROP TABLE vote_selections;
DROP INDEX IF EXISTS idx_votes_poll_option;
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

-- 4. Recreate the indexes.
CREATE INDEX idx_polls_status_created ON polls(status, created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_votes_poll_voter_token ON votes(poll_id, voter_token_hash);
CREATE INDEX idx_votes_poll_id ON votes(poll_id);
CREATE INDEX idx_vote_selections_poll_option ON vote_selections(poll_id, option_id);
CREATE UNIQUE INDEX idx_comments_public_id ON comments(public_id);
CREATE INDEX idx_comments_poll_created ON comments(poll_id, created_at DESC, public_id DESC);
CREATE INDEX idx_poll_reports_open ON poll_reports(resolved_at, poll_id);
CREATE INDEX idx_poll_reports_poll ON poll_reports(poll_id, created_at DESC);

-- 5. Rebuild `stats_snapshots` so the three verdict columns may be omitted by
-- new rows. They stay in the table because earlier records were signed over
-- them and must stay verifiable.
CREATE TABLE stats_snapshots_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  ts_hour INTEGER NOT NULL,
  approve INTEGER NOT NULL DEFAULT 0,
  oppose INTEGER NOT NULL DEFAULT 0,
  neutral INTEGER NOT NULL DEFAULT 0,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  ballots INTEGER NOT NULL DEFAULT 0,
  option_counts TEXT,
  UNIQUE(poll_id, ts_hour)
);

INSERT INTO stats_snapshots_new (id, poll_id, ts_hour, approve, oppose, neutral, prev_hash, hash,
                                 final, views, ballots, option_counts)
  SELECT id, poll_id, ts_hour, approve, oppose, neutral, prev_hash, hash,
         final, views, ballots, option_counts
  FROM stats_snapshots;

DROP INDEX IF EXISTS idx_stats_snapshots_hour;
DROP TABLE stats_snapshots;
ALTER TABLE stats_snapshots_new RENAME TO stats_snapshots;
CREATE INDEX idx_stats_snapshots_hour ON stats_snapshots(ts_hour);

