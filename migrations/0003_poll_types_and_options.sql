-- ChinaPoll migration 0003: poll types, per-poll options, and choice ballots.
--
-- Schema only: no seed or demo rows are inserted.
--
-- Design notes:
--   * `polls.poll_type` selects the ballot shape: 1 verdict (approve, neutral,
--     oppose), 2 single choice, 3 multi choice. A verdict poll keeps its
--     behaviour exactly as before, including the `votes.option` column.
--   * A ballot stays one row per (poll, token) in `votes`, so the existing
--     unique index still enforces one ballot per browser. Choice selections
--     live in the child table `vote_selections`, which references that one
--     ballot row. A database leak can therefore group the options chosen on a
--     single anonymous ballot, but the ballot still carries no identity.
--   * `duration_seconds` replaced the proposal start/end fields. It is NULL when
--     the poll has no end date.
--   * `stats_snapshots.ballots` records the number of ballots for every poll
--     type and `option_counts` carries the per-option counts of a choice poll as
--     JSON, so both are covered by the signed hourly hash chain.

-- Poll type: 1 verdict, 2 single choice, 3 multi choice. Existing rows keep the
-- verdict behaviour.
ALTER TABLE polls ADD COLUMN poll_type INTEGER NOT NULL DEFAULT 1 CHECK (poll_type IN (1, 2, 3));

-- NULL means the poll has no end date. `start_at` is no longer written.
ALTER TABLE polls ADD COLUMN duration_seconds INTEGER;

-- Options of a choice poll, ordered by `position`. Type 1 polls have none.
CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 7),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  UNIQUE (poll_id, position)
);

-- Selections of a choice ballot. One row per (ballot, option).
CREATE TABLE IF NOT EXISTS vote_selections (
  vote_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  PRIMARY KEY (vote_id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_vote_selections_option ON vote_selections(option_id);

-- SQLite cannot relax the existing CHECK (option IN (1, 2, 3)) in place, so the
-- table is rebuilt with a NULL-able option column: a verdict ballot stores its
-- verdict and a choice ballot stores NULL. Existing rows are copied unchanged
-- and both indexes are recreated.
CREATE TABLE votes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_token_hash TEXT NOT NULL,
  option INTEGER CHECK (option IS NULL OR option IN (1, 2, 3)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO votes_new (id, poll_id, voter_token_hash, option, created_at)
  SELECT id, poll_id, voter_token_hash, option, created_at FROM votes;

DROP TABLE votes;
ALTER TABLE votes_new RENAME TO votes;

CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_poll_voter_token
  ON votes(poll_id, voter_token_hash);
CREATE INDEX IF NOT EXISTS idx_votes_poll_option ON votes(poll_id, option);

-- Ballots per poll and the per-option counts of a choice poll. Both are folded
-- into the signed snapshot hash.
ALTER TABLE stats_snapshots ADD COLUMN ballots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stats_snapshots ADD COLUMN option_counts TEXT;
