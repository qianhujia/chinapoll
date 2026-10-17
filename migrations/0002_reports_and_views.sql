-- ChinaPoll migration 0002: poll reports and poll view counting.
--
-- Schema only: no seed or demo rows are inserted.
--
-- Design notes:
--   * `poll_reports` carries no reporter identifier at all: no address, no
--     network bucket, no user id, and only an hour-coarsened `created_at`, so a
--     report cannot be tied back to a person or correlated with edge logs.
--   * `poll_views` stores one daily counter per poll per UTC day. There are no
--     per-view rows anywhere, so a view can never be attributed to a viewer.
--   * `stats_snapshots.views` adds the cumulative view total to the signed
--     hourly chain so published view counts are tamper-evident like votes.

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

-- Approximate per-poll view counters. One row per poll per UTC day holding only
-- a count; `ts_day` is the start of the day in Unix seconds and a rollup row uses
-- `ts_day = 0` so long-term totals survive while daily resolution is dropped.
CREATE TABLE IF NOT EXISTS poll_views (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  ts_day INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (poll_id, ts_day)
);

-- Cumulative views per poll, added to the signed hourly snapshot chain.
ALTER TABLE stats_snapshots ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
