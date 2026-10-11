-- Terminal-snapshot marker.
--
-- Every close path writes a snapshot for the closing hour, and the hourly
-- maintenance task writes one for any recently closed poll whose terminal record
-- is still missing. `final` is set to 1 only on that terminal snapshot so the
-- published hash chain always ends on a poll's real final counts and verifiers
-- and the publish script can recognise the record.
--
-- Schema only: no seed or demo rows are inserted.
ALTER TABLE stats_snapshots ADD COLUMN final INTEGER NOT NULL DEFAULT 0;
