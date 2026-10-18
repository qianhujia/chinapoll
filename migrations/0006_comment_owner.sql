-- ChinaPoll migration 0006: comments keep a one-way owner hash.
--
-- The account dashboard lists the comments an account posted and lets the account
-- delete its own, so a comment stores the same kind of one-way owner hash a poll
-- does (see worker/services/owner.ts): an HMAC of the server secret over
-- "owner:<userId>:comment:<publicId>". A database leak without the server secret
-- therefore still reveals no author links, and the public comment API keeps its
-- shape - a comment is still anonymous to readers.
--
-- The hash is derived from the comment's random public id, which the API generates
-- before the insert, so it needs no extra round trip. Rows created before this
-- migration keep a NULL owner hash: they stay public and simply cannot be claimed.
--
-- `comments` is a child of `polls` and no table references it, so it is rebuilt on
-- its own (create, copy, drop, rename) rather than around a parent swap. Its
-- indexes are recreated after the rename.

CREATE TABLE comments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  public_id TEXT NOT NULL,
  owner_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO comments_new (id, poll_id, comment, public_id, owner_hash, created_at)
  SELECT id, poll_id, comment, public_id, NULL, created_at FROM comments;

DROP INDEX IF EXISTS idx_comments_public_id;
DROP INDEX IF EXISTS idx_comments_poll_created;
DROP TABLE comments;

ALTER TABLE comments_new RENAME TO comments;

-- The unique public id is what the dashboard looks a comment up by; the owner hash
-- is compared after that lookup, so it needs no index of its own.
CREATE UNIQUE INDEX idx_comments_public_id ON comments(public_id);
CREATE INDEX idx_comments_poll_created ON comments(poll_id, created_at DESC, public_id DESC);
