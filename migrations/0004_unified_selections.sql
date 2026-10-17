-- ChinaPoll migration 0004: remove `votes.option` and record every selection in
-- `vote_selections`.
--
-- Schema only changes plus a one-time data copy. No seed or demo rows are added.
--
-- Design notes:
--   * `votes` becomes a ballot table only: `id`, `poll_id`, `voter_token_hash`,
--     `created_at`. It no longer carries the verdict code, so a ballot row holds
--     no choice data at all and the unique index still enforces one ballot per
--     (poll, token).
--   * Every poll type now has rows in `poll_options`. A verdict poll holds the
--     preset rows `approve` and `oppose` (and optional `neutral`) with a NULL
--     label; a choice poll holds 2 to 7 custom rows with a label. `position` is
--     display order only.
--   * `vote_selections` records one row per chosen option for every type, so the
--     results pipeline is the same. It references the poll, the ballot, and the
--     option, and every reference cascades on delete.
--
-- Existing rows are preserved: a choice selection keeps its `option_id`, and a
-- verdict ballot's old `option` code is mapped to the poll's preset row
-- (1 -> approve, 2 -> oppose, 3 -> neutral).
--
-- SQLite cannot add foreign keys or relax the old CHECK in place, so the tables
-- are rebuilt. `defer_foreign_keys` makes the rebuild safe inside one
-- transaction: the constraint checks are evaluated at commit time, when the
-- renamed tables already exist.

PRAGMA defer_foreign_keys = ON;

-- 1. Rebuild `poll_options` with the preset columns. Existing rows are custom
-- option rows, so they keep their label and get a NULL `preset_key`.
CREATE TABLE poll_options_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 7),
  label TEXT CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 80),
  preset_key TEXT CHECK (preset_key IS NULL OR preset_key IN ('approve', 'oppose', 'neutral')),
  UNIQUE (poll_id, position),
  CHECK ((label IS NULL) <> (preset_key IS NULL))
);

INSERT INTO poll_options_new (id, poll_id, position, label, preset_key)
  SELECT id, poll_id, position, label, NULL FROM poll_options;

-- 2. Preset rows for every verdict poll: approve, oppose, then neutral. A
-- verdict poll keeps all three rows; the neutral row is removable later.
INSERT INTO poll_options_new (poll_id, position, label, preset_key)
  SELECT id, 1, NULL, 'approve' FROM polls WHERE poll_type = 1;
INSERT INTO poll_options_new (poll_id, position, label, preset_key)
  SELECT id, 2, NULL, 'oppose' FROM polls WHERE poll_type = 1;
INSERT INTO poll_options_new (poll_id, position, label, preset_key)
  SELECT id, 3, NULL, 'neutral' FROM polls WHERE poll_type = 1;

-- 3. Rebuild `votes` without `option`. The ballot row is copied unchanged; the
-- verdict code is carried into `vote_selections` below.
CREATE TABLE votes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO votes_new (id, poll_id, voter_token_hash, created_at)
  SELECT id, poll_id, voter_token_hash, created_at FROM votes;

-- 4. Rebuild `vote_selections`. The new table references `votes_new` and
-- `poll_options_new`, whose names are rewritten to `votes` and `poll_options`
-- when those tables are renamed below.
CREATE TABLE vote_selections_new (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  vote_id INTEGER NOT NULL REFERENCES votes_new(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options_new(id) ON DELETE CASCADE,
  PRIMARY KEY (vote_id, option_id)
);

-- Copy the choice selections, filling `poll_id` from the ballot row.
INSERT INTO vote_selections_new (poll_id, vote_id, option_id)
  SELECT v.poll_id, vs.vote_id, vs.option_id
  FROM vote_selections vs
  JOIN votes v ON v.id = vs.vote_id;

-- Copy the verdict ballots as one selection each, resolved through the preset
-- key: old code 1 -> approve, 2 -> oppose, 3 -> neutral.
INSERT INTO vote_selections_new (poll_id, vote_id, option_id)
  SELECT v.poll_id, v.id, o.id
  FROM votes v
  JOIN poll_options_new o ON o.poll_id = v.poll_id
  WHERE v.option IN (1, 2, 3)
    AND o.preset_key = CASE v.option
      WHEN 1 THEN 'approve'
      WHEN 2 THEN 'oppose'
      ELSE 'neutral'
    END;

-- 5. Drop the obsolete tables and indexes, then put the rebuilt tables in place.
DROP INDEX IF EXISTS idx_vote_selections_option;
DROP TABLE vote_selections;
DROP INDEX IF EXISTS idx_votes_poll_option;
DROP TABLE votes;
DROP TABLE poll_options;

ALTER TABLE poll_options_new RENAME TO poll_options;
ALTER TABLE votes_new RENAME TO votes;
ALTER TABLE vote_selections_new RENAME TO vote_selections;

-- 6. Recreate the indexes: the one-ballot-per-token rule, a poll lookup, and the
-- per-option count lookup.
CREATE UNIQUE INDEX idx_votes_poll_voter_token ON votes(poll_id, voter_token_hash);
CREATE INDEX idx_votes_poll_id ON votes(poll_id);
CREATE INDEX idx_vote_selections_poll_option ON vote_selections(poll_id, option_id);
