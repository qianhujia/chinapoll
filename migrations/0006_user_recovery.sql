-- Single-use recovery codes that let an account reset its own password.
--
-- Accounts sign up with a username and password only, so these codes are the
-- only recovery channel. A set of codes is generated at sign-up (and can be
-- regenerated while signed in); the plaintext codes are shown to the user once
-- and never stored. Only their SHA-256 hashes are kept here. A code is
-- single-use; when one is consumed the remaining unused codes are deleted.
-- Schema only: no seed or demo rows are inserted here.

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_user_recovery_codes_user ON user_recovery_codes(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_recovery_codes_hash ON user_recovery_codes(user_id, code_hash);