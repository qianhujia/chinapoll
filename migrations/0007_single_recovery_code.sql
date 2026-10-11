-- Switch from a set of recovery codes to a single recovery code stored on the
-- account row.
--
-- A recovery code now has a 1:1 relationship with the user, so the dedicated
-- table is replaced by a column pair on `users`. `recovery_code_hash` is NULL
-- when no code is active. The code is rotated whenever it is used (see
-- worker/api/auth.ts), so an account always keeps a usable code.
-- Schema only: no seed or demo rows are inserted here.

ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;
ALTER TABLE users ADD COLUMN recovery_code_updated_at INTEGER;

DROP TABLE IF EXISTS user_recovery_codes;