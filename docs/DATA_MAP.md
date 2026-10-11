# ChinaPoll data map

Every table and column in the shared D1 database, who can read it, how long it
is kept, and what a breach or legal request would reveal.

Legend for readers: **Public** = anyone through the public API; **User** = the
signed-in owner through `/api/user`; **Admin** = the admin dashboard; **CF** =
Cloudflare (edge and logs).

## polls

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | sequential poll id | Public, User, Admin | 30 days after close, then archived |
| title, description | submission text | Public, User, Admin | as above |
| mode, start_at, end_at, status, reviewed_at | lifecycle | Public, User, Admin | as above |
| owner_hash | one-way HMAC of the server secret with the account id and poll id | none | until the poll is deleted |
| created_at, updated_at | timestamps | Public (derived), Admin | as above |

Note: `ip_prefix` was removed; no network value is stored for a poll.

## votes

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| poll_id | poll reference | Admin (counts only published publicly) | 30 days after close |
| voter_token_hash | SHA-256 of a per-poll browser token | none | as above |
| option | approve/oppose/neutral | Public (aggregated) | as above |
| created_at | hour-coarsened timestamp | none | as above |

## comments

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | internal id | Admin | until deleted |
| public_id | random public identifier | Public | until deleted |
| poll_id | poll reference | Public | until deleted |
| comment | free text | Public | until deleted |
| created_at | hour-coarsened timestamp | Public (derived) | until deleted |

Note: `ip_prefix` and `ts_bucket` were removed, and comments carry no owner.

## users

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | account id | User (self), Admin | until account deletion |
| username | chosen handle (never shown publicly) | User (self), Admin | until deletion |
| password_hash | PBKDF2 600k hash | Admin (write only) | until deletion |
| status, failed_attempts, locked_until | lockout state | Admin | until deletion |
| last_login_at | day-coarsened | Admin | until deletion |
| recovery_code_hash | SHA-256 of the one recovery code | none | rotated on use, until deletion |

Note: `ip_prefix` was removed; account cap counters live in `auth_attempts`.

## user_sessions

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| token_hash | SHA-256 of the session token | none | 30 days sliding, purged hourly |
| user_id, created_at, expires_at | bookkeeping | Admin | as above |

## auth_attempts

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| ip_hash | keyed, daily-rotated hash of the network bucket | Admin (count only) | 30 days |
| kind | `account` | Admin | 30 days |
| created_at | timestamp | Admin | 30 days |

## settings

Key/value configuration. Secrets (`turnstile_secret_key`) are read by the
Workers only and are stripped from the public endpoint.

## stats_snapshots

Signed hourly counts per poll, published for verification. Contents are public
by design; the hash chain makes rewriting detectable.

## admin_users, admin_sessions, admin_audit_log

Administrative credentials, sessions, and an action log that records no client
IP address. Read only by the admin Worker.

## What a breach or legal request would reveal

- Vote totals and comment text, which are public anyway.
- Account usernames and password/recovery hashes, but not plaintext secrets.
- Poll rows carry only a one-way owner hash, and comments carry no owner, so no
  author link can be recovered from the tables alone. Contributions are not
  linked to votes and carry no network value.
- Per-network account-cap counters only as keyed hashes; the raw address cannot
  be recovered without `IP_HASH_KEY`. Because the cap hash rotates per calendar
  month, rows sharing a hash are linkable within one month.