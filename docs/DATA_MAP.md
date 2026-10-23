# ChinaPoll data map

Every table and column in the shared D1 database, who can read it, how long it
is kept, and what a breach or legal request would reveal.

Legend for readers: **Public** = anyone through the public API; **User** = the
signed-in owner through `/api/user`; **Admin** = the admin dashboard; **CF** =
Cloudflare (edge and logs).

## topics

Poll topics, created by the admin. There is no seed data; the admin Settings
tab can insert the suggested set. A topic is deleted with `ON DELETE SET NULL`
on its polls, so those polls become untopicalized.

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | internal topic id | Public (as part of a poll), Admin | until deleted |
| slug | public identifier (`[a-z0-9-]`, 2 to 40 characters) used by `topic=<slug>` | Public, Admin | as above |
| name | display name, or the default English name for a suggested topic | Public, Admin | as above |
| position | display order | Public (ordering), Admin | as above |
| enabled | 1 when the topic is offered publicly | Public (enabled only), Admin | as above |
| created_at | creation timestamp | Admin | as above |

## polls

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | sequential poll id | Public, User, Admin | 30 days after close, then archived |
| title, description | submission text | Public, User, Admin | as above |
| mode, start_at, end_at, status, reviewed_at | lifecycle | Public, User, Admin | as above |
| poll_type | ballot shape: 1 verdict, 2 single choice, 3 multi choice | Public, User, Admin | as above |
| duration_seconds | length of the poll in seconds, or NULL for no end date | Public, User, Admin | as above |
| topic_id | the poll's topic, or NULL when untopicalized | Public, Admin | as above |
| owner_hash | one-way HMAC of the server secret with the account id and poll id | none | until the poll is deleted |
| created_at, updated_at | timestamps | Public (derived), Admin | as above |

Notes: `ip_prefix` was removed; no network value is stored for a poll.
The `owner_hash` message is `owner:<accountId>:<pollId>` and is fixed: it is how an
already-stored row is recognised as belonging to an account, so changing it would
make existing polls unrecognisable to the account that submitted them. The dashboard
lists the polls an account submitted by asking the server to confirm the poll ids the
browser remembers, and it never lists a poll the account only voted on.
`duration_seconds` replaced the submitted start and end times, and `start_at` is
no longer written for new polls. `end_at` is computed when the poll opens as
`open_time + duration_seconds`, so a poll that waits for review still gets its
full duration.

## poll_options

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | internal option id, the option identity used by every request and response | Public | until the poll is deleted |
| poll_id | poll reference | Public | as above |
| position | display position, 1 to 7 | Public | as above |
| label | option text, 1 to 80 characters | Public | as above |

Note: every poll has rows here, and every row is plain text the submitter wrote;
there is no preset or virtual column. A verdict poll, a single choice poll, and a
multiple choice poll all store their options the same way. `position` is display
order only. Admins may edit a pending poll's labels while it has no ballots, and
every change writes an audit entry.

The verdict type only differs in how the proposal form builds the rows: it
generates Approve, Neutral, and Oppose, and the submitter may then rename them,
drop to two, or add up to seven. Ballots are identical to a single choice poll
(exactly one option), and the stored `poll_type` keeps the type identifiable.

## votes

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | internal ballot id | none | 30 days after close |
| poll_id | poll reference | Admin (counts only published publicly) | as above |
| voter_token_hash | SHA-256 of a per-poll browser token | none | as above |
| created_at | hour-coarsened timestamp | none | as above |

Note: `votes` is a ballot table only. It holds **no choice data at all** - there
is no `option` column - so the only thing a ballot row carries is the one-way
token hash and the poll it belongs to. The unique index on
(poll_id, voter_token_hash) still enforces one ballot per browser.

## vote_selections

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| poll_id | poll reference | Public (aggregated counts only) | 30 days after close |
| vote_id | reference to the one anonymous ballot row | none | as above |
| option_id | reference to a `poll_options` row | Public (aggregated counts only) | as above |

Note: `vote_selections` records one row per chosen option for **both** poll types,
so every ballot is stored the same way and the options are always referenced by
ID. It links the chosen options to one anonymous ballot token hash: a database
leak therefore reveals which options were chosen together on a single ballot - for
a multiple choice poll that is the whole combination of one ballot - but the
ballot itself carries no identity. There is no account link, no address, no
network value, and only an hour-coarsened timestamp. The primary key is
(vote_id, option_id) and the index on (poll_id, option_id) serves the per-option
counts. Every reference cascades on delete, so purging a poll's ballots removes
their selections too. Public responses show per-option counts only and never the
combination, so the grouping is never published.

## comments

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | internal id | Admin | until deleted |
| public_id | random public identifier | Public | until deleted |
| poll_id | poll reference | Public | until deleted |
| comment | free text | Public | until deleted |
| created_at | hour-coarsened timestamp | Public (derived) | until deleted |
| owner_hash | one-way HMAC of the account that posted the comment (`NULL` for a row written before comments carried an owner, or when the server secret is unavailable) | Admin (never published) | until deleted |

Note: `ip_prefix` and `ts_bucket` were removed, and a comment carries no account
column: `owner_hash` is derived from the server secret over the comment's random
public id under a namespaced message (`owner:<accountId>:comment:<publicId>`), so it
can never collide with a poll owner hash and a database leak without the secret
reveals no author links. The
account dashboard uses it to list and delete the comments that account posted, and
the public comment API never returns it.

## poll_reports

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| id | internal report id | none (never returned) | 90 days after resolution |
| poll_id | poll reference | Admin (aggregated) | as above |
| reason | one of eight reason codes | Admin (aggregated) | as above |
| note | optional free text, only with reason `other` | Admin | as above |
| created_at | hour-coarsened timestamp | none | as above |
| resolved_at | hour-coarsened resolution time | Admin | as above |
| resolution | 1 dismissed, 2 action taken | Admin | as above |

Note: a report carries **no reporter identifier** — no address, no network
bucket, no user id — and the report id is never returned by the public API. Rate
limiting uses the keyed daily network hash in the Durable Object, which is never
written here. Reports are removed with the poll by the foreign key cascade.

## poll_views

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| poll_id | poll reference | Public (aggregated), Admin | until the poll is deleted |
| ts_day | UTC day bucket start, or 0 for the long-term rollup | Public (aggregated), Admin | 90 days at daily resolution, then rolled up |
| views | view counter for that day | Public (aggregated), Admin | as above |

Note: `poll_views` holds only per-poll daily counters. There are no per-view rows
anywhere, so a view cannot be attributed to a viewer, and no network value is
stored. Each view is buffered by the poll's `ViewCounter` Durable Object and
flushed to this table every five minutes; the object keeps only a pending count
and the per-network rate windows in its own memory (keyed by the daily-rotated
network hash, never persisted, never written here) and nothing about the visitor.
The counts are therefore approximate by design: an object evicted between flushes
loses up to five minutes of views and resets its in-memory rate windows, which
drops D1 writes from one per view to at most twelve per active poll per hour. Rows
older than 90 days are rolled up into a single `ts_day = 0` row per poll so
long-term totals survive while daily resolution is dropped. Rows are removed with
the poll by the foreign key cascade.

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
| user_id, expires_at | bookkeeping; `expires_at` is exact | Admin | as above |
| created_at | hour resolution | Admin | as above |

## auth_attempts

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| ip_hash | keyed, daily-rotated hash of the network bucket | Admin (count only) | 30 days |
| kind | `account` | Admin | 30 days |
| created_at | timestamp | Admin | 30 days |

## settings

Key/value configuration. The `github_token` secret is read
by the Workers only and are stripped from the public endpoint. The publish
settings (`publish_enable`, `publish_repository`, `publish_branch`,
`publish_path`) are private too: they are never served by the public endpoint.
The `logo` and `favicon` values hold either an `https` image URL or, for an
upload from the admin dashboard, a base64 image data URI. Both are public, but
the payload is not: `/api/settings/public` returns the URL the pages should
use — `/image/<key>.<extension>?v=<updated_at>` for an upload, which the Worker serves
from the settings row, or the pasted URL as it is. A visitor can therefore fetch
the image and read the URL, and nothing else about the row.

## stats_snapshots

Signed hourly counts per poll, published for verification. Contents are public
by design; the hash chain makes rewriting detectable.

| Column | Contents | Readers | Retention |
| --- | --- | --- | --- |
| poll_id, ts_hour | poll reference and hour bucket | Public | forever |
| ballots | number of ballots cast at that hour | Public | forever |
| option_counts | JSON array of `{ position, count }` for the poll | Public | forever |
| views | cumulative view total at that hour | Public | forever |
| prev_hash, hash | chain link and record hash | Public | forever |
| final | 1 on the terminal snapshot written when the poll closed, 0 otherwise | Public | forever |

Note: `ballots`, `option_counts`, and `views` are part of the canonical JSON
(schema version 3) that the record hash covers, so a rewritten ballot total or
option count breaks the chain. They are aggregate values for one poll at one
hour and cannot be traced back to a ballot. The legacy `approve`/`oppose`/`neutral`
columns and the version 1 and 2 payloads no longer exist.

## publish_state, publish_runs

Publisher bookkeeping for the public audit repository. Read by the Workers only;
never served to the public.

| Table | Column | Contents | Readers | Retention |
| --- | --- | --- | --- | --- |
| publish_state | poll_id, published_through | cursor: the newest snapshot hour copied out for the poll | none | until the poll is deleted |
| publish_state | poll_id = 0 | reserved row whose `published_through` is the publisher batch cursor (the last poll id a run examined) | none | forever |
| publish_state | final | 1 when that hour is the terminal record, 0 while the poll is open | none | as above |
| publish_runs | started_at, finished_at | run window | Admin | last 50 runs |
| publish_runs | polls_updated | number of poll files rewritten | Admin | last 50 runs |
| publish_runs | error | failure message, or NULL on success (never the token) | Admin | last 50 runs |


## admin_users, admin_sessions, admin_audit_log

Administrative credentials, sessions, and an action log that records no client
IP address. Read only by the admin Worker.

| Table | Column | Contents | Readers | Retention |
| --- | --- | --- | --- | --- |
| admin_sessions | token_hash | SHA-256 of the session token | none | 30 minutes sliding |
| admin_sessions | admin_user_id, expires_at | bookkeeping; `expires_at` is exact | Admin | as above |
| admin_sessions | created_at | hour resolution | Admin | as above |

## What a breach or legal request would reveal

- Vote totals and comment text, which are public anyway.
- Account usernames and password/recovery hashes, but not plaintext secrets.
- Poll rows carry only a one-way owner hash, and comments carry no owner, so no
  author link can be recovered from the tables alone. Contributions are not
  linked to votes and carry no network value.
- Per-network account-cap counters only as keyed hashes; the raw address cannot
  be recovered without `SERVER_HMAC_KEY`. Because the cap hash rotates per calendar
  month, rows sharing a hash are linkable within one month.
- Reports and views reveal nothing about who acted: `poll_reports` stores no
  reporter identifier and only an hour-coarsened timestamp, and `poll_views` is a
  per-poll daily counter with no per-view rows and no network value.
- `vote_selections` links the options chosen on one ballot to that ballot's
  anonymous token hash. A leak therefore shows the option combination per
  anonymous ballot — for a multi-choice poll that is the whole combination of one
  ballot — but nothing that identifies a person: no account link, no address, no
  network value, and only an hour-coarsened timestamp. The ballot table `votes`
  itself holds no choice data, so a leak of `votes` alone reveals only that some
  browser voted on a poll.