# ChinaPoll threat model

This document states what ChinaPoll protects, what it does not, and which
records would be exposed by a breach or a legal request. It is reviewed whenever
the schema or the network handling changes.

## Assets

- The integrity of published vote totals.
- The confidentiality of who voted, who commented, and who submitted which poll.
- The confidentiality of account credentials and recovery codes.

## What the system stores

- Votes: the SHA-256 hash of a per-poll browser token, and the chosen option as a
  reference to a stored option row. There is no account link and no network value.
- Comments: free text, a random public id, and one fixed `author_mark` value per
  account (see `worker/services/author.ts`). A comment is anonymous to the public:
  the mark never leaves the database for readers. "My comments" is an ordinary
  paginated query by that mark, so the browser remembers nothing and no comment id
  has to be claimed.
- Polls: free text, the same kind of fixed `author_mark`, and a creation timestamp
  coarsened to the hour, so the dashboard can list and close the polls an account
  submitted without the database naming the author. The mark proves submission only:
  a poll an account voted on is never listed as one of its polls.
- Accounts: username, a PBKDF2-HMAC-SHA256 password verifier (the public `pbkdf2w$`
  format), a single recovery code hash, and lock/bookkeeping fields. Each account
  has a random 32-byte author key that is stored only wrapped: once under a
  password-derived key (`users.author_key_pw`), once under a recovery-code-derived
  key (`users.author_key_rc`), and once per session under a session-derived key
  (`user_sessions.author_key`). Login time is rounded to the day.

A database copy, even together with the server secret, cannot link a poll or
comment to an account: the author key behind an `author_mark` is recoverable only
from the user's password or recovery code, never from the stored rows, and the
password verifier and the wrap keys are separate values derived from a PBKDF2
output that never leaves the `PasswordHasher` Durable Object. All rows of one
account share one author mark, so a database reader can tell that a set of rows
came from the same anonymous author even though it cannot say which account.
- The per-network account cap: a keyed, daily-rotated hash of the network bucket
  in `auth_attempts`. The raw address is never stored.
- Poll reports and comment reports: only the reference (the poll, or the comment and
  its poll), the reason code, an optional free-text note, and an hour-coarsened
  timestamp. There is no reporter identifier at all, for either target.
- Poll views: one counter per poll per UTC day. There are no per-view rows, so a
  view cannot be attributed to a viewer. Views are buffered in the poll's
  `ViewCounter` Durable Object (a pending count and nothing about the visitor) and
  flushed every five minutes, so the counts are approximate: an object evicted
  between flushes loses up to five minutes of views.

## Adversaries and mitigations

- **Network observer**: served over HTTPS with HSTS; no third-party origins are
  referenced by the application build.
- **Database attacker**: cannot reverse a vote to a person, cannot reverse a
  keyed network hash without `SERVER_HMAC_KEY`, and cannot use a stolen password
  hash offline faster than the PBKDF2 cost allows (`PBKDF2_ITERATIONS` in
  `shared/password.ts`: 100,000 iterations, the most Cloudflare's production
  WebCrypto accepts for PBKDF2). That derivation
  runs in the `PasswordHasher` Durable Object rather than on the request path, so
  the request Worker never performs it; hashing is sharded by username across 16
  instances, so one object is neither a single queue nor a single lockout target.
- **Spammer**: rate limiting is atomic and per-scope in a Durable Object; new
  accounts must age before they can submit; per-network account creation is
  capped.
- **Abusive session**: cookie mutations require a same-origin request, and
  rotating the recovery code or deleting the account both require the current
  password.
- **Driven by another page**: the anonymous mutations (`POST /api/vote`, the poll
  and comment report endpoints, and `POST /api/polls/:id/view`) require a
  same-origin request too, so a third-party page cannot make its visitors cast one
  ballot, file a report, or record a view from their own network buckets.
  Turnstile's hostname check covered that for voting while it was on; the Origin
  check makes it independent of Turnstile being enabled.
- **Content tampering**: hourly signed snapshots form an append-only hash chain
  published for external verification. There is one canonical format
  (`schemaVersion: 3`): each record's hash covers the poll id, the hour, the number
  of ballots, the per-option counts, the cumulative view total, and the previous
  record's hash, so rewriting any of those values is detectable. The earlier
  version 1 and version 2 payloads and the legacy verdict columns they signed were
  removed, so every chain uses the same format. The hourly maintenance run copies
  the chain to a public data repository with a fine-grained token that is stored as
  a secret in the `settings` table and is never exposed, logged, or sent anywhere
  except the GitHub API.

## Reports and views

Reporting is anonymous: `POST /api/polls/:id/report` stores no address, no network
bucket, no user id, and only an hour-coarsened `created_at`, and the report id is
never returned, so a report cannot be tied back to a person or correlated with
edge logs. Rate limiting uses the keyed, daily-rotated network hash through the
Durable Object, which is never written to D1. Reason codes 5 (personal
information), 6 (harassment), and 7 (illegal content) are treated as high
priority: when a poll collects `report_auto_hide_priority_threshold` (default 2)
open high-priority reports, or `report_auto_hide_threshold` (default 5) open
reports in total, it is set back to pending with `reviewed_at` cleared so it
leaves public listings until an admin reviews it. Setting a threshold to 0
disables that rule. Resolving a report never changes the poll status; an admin
does that from the Polls tab.

View counting is deliberately coarse. `POST /api/polls/:id/view` increments one
per-poll, per-UTC-day counter; there are no per-view rows anywhere, no network
value is stored, and the endpoint always answers `204` so the response reveals
nothing whether or not the rate limit was hit. The browser also deduplicates
itself per tab session. Counts are approximate and that is acceptable: they are
published only as an aggregate `{ total, last7Days }` per poll, and the poll list
withholds a total below `min_views_to_display` (default 20). A poll's own page
shows its count, which reveals how often that one poll was opened but never who
opened it. View rows older than 90 days are
rolled up into a single per-poll row, dropping daily resolution.

## Poll types, the options engine, and snapshots

A poll is one of three ballot shapes: a **verdict** poll (one option per ballot,
whose options the proposal form generates as Approve, Neutral, and Oppose), a
**single choice** poll (one option per ballot), or a **multiple choice** poll (one
to seven options per ballot). The verdict type keeps its own code and its own
option rows, and it accepts exactly the same ballots as a single choice poll.

**One engine** (`worker/services/options.ts`) serves all three: every poll
exposes a list of options stored in `poll_options`, every ballot is a set of
selected option IDs in `vote_selections`, and one counting function, one results
shape, and one snapshot shape are used throughout. Options are identified by `id`
in every request and response, and every option row is plain text: there is no
preset, virtual, or translated column, so one poll's labels are as ordinary as
another's.

`votes` is therefore a **ballot table only**: `id`, `poll_id`,
`voter_token_hash`, and `created_at`. It carries no `option` column, so a ballot
row holds no choice data at all, and the choice is recorded as one
`vote_selections` row per selected option for every poll type.

A ballot stays **one row per (poll, token)** in `votes`, so the existing unique
index still enforces one ballot per browser and a multiple choice vote cannot be
split across several rows.

Two exposures are worth stating explicitly:

- **Option combinations per anonymous ballot.** `vote_selections` links each
  chosen option to one ballot row, so a database reader can group the options
  chosen together on a single ballot — for a multiple choice poll that is the whole
  combination of one ballot. That grouping is the ballot's own data: the ballot
  still has no account link, no address, no network value, and only an
  hour-coarsened timestamp. A leak therefore reveals *combinations per anonymous
  ballot*, not who cast them. Public responses never publish the combination;
  they show per-option counts only.
- **The ballot threshold.** `min_votes_to_display` is applied to the number of
  ballots, and it hides **every** option count of the poll at once. That keeps the
  earlier guarantee intact: a poll with a couple of ballots cannot be used to
  infer how one person voted, because no option count is published at all below
  the threshold.

## The snapshot hash, what it covers, and its schema version

The canonical payload that `makeSnapshot` hashes (and that verification
recomputes) covers the number of ballots and the per-option counts of the poll, in
addition to the cumulative view total and the previous record's hash.
`optionCounts` is stored as JSON in `stats_snapshots.option_counts` and `ballots`
in `stats_snapshots.ballots`; both are normalized (sorted by position, numeric)
before hashing so the chain is stable. Rewriting a published ballot total or
option count after the fact therefore breaks verification.

The payload carries a **schema version**. Version 1 is the original shape (poll
id, hour, the three verdict counts, the cumulative views, and the chain link);
version 2 adds `ballots` and `optionCounts`; version 3 drops the three verdict
counts and is what the Worker writes from now on. Verification accepts a record
without the newer fields and reproduces the stored hash under any supported
version, so a chain copied out before either change still verifies and is never
falsely reported as tampered with. The version is included in the
`/api/snapshots/:id` response and in the published JSON file, so an external
verifier can tell which payload a given chain was hashed with.

## AI provider data flow

AI assistance is optional and off by default (`ai_provider` defaults to `off`).
When it is on, the Worker uses it for its own review and topic classification of a
submission, and the AI endpoints stay available to API callers; the public submit
form renders no AI control, so a visitor's draft leaves the browser only when they
submit the poll:

- A submission's text (title and optional description) is sent by the Worker to
  the configured provider: Cloudflare Workers AI through the `AI` binding, or the
  admin-configured OpenAI-compatible endpoint. The same provider answers
  `POST /api/ai/enhance-title` and `POST /api/ai/suggest-options`, which return
  validated suggestions straight to the caller.
- **Nothing is stored.** The prompt and the model response are never logged and
  never written to D1. There is no prompt table, no response table, and no cache.
- The endpoints require a signed-in account, pass the same account-age gate as
  proposals, enforce the same Origin check, verify Turnstile when it is enabled,
  and are rate limited per account with scope `ai`.
- Workers AI and any configured OpenAI-compatible endpoint are third-party
  services. Turning AI on therefore means the submitted text leaves the operator's
  own systems and is processed by the selected provider under that provider's
  terms; the About page discloses this in one line. The
  OpenAI-compatible API key is stored as a secret setting and is only sent to
  the configured endpoint.

## Explicit non-goals

- The system does not defend against an adversary who controls the Cloudflare
  edge and records metadata. Cloudflare-side Logpush, Web Analytics, and Bot
  Analytics must be disabled, and "Remove visitor IP headers" enabled in Managed
  Transforms. Record the date each setting was applied here.
- The design does not defend against an operator who modifies the Worker to log
  keys at request time.
- Accounts still group a person's polls and comments under one author mark. Polls
  and comments are shown publicly without usernames, and a database reader cannot
  say which account the mark belongs to, but it can tell which rows share one
  author. See `docs/DATA_MAP.md`.
- Turnstile is a third-party service and is the only external origin the
  application may contact.

## Configuration log

| Setting | Value | Date applied |
| --- | --- | --- |
| Logpush | disabled | pending |
| Web Analytics beacon | disabled | pending |
| Bot Analytics | disabled | pending |
| Managed Transforms "Remove visitor IP headers" | enabled | pending |
| Onion Routing | enabled (manual Tor test at Safest) | pending |

## Review history

- Initial version covering the user-account release and the anonymized bucket
  migration.
- Poll ownership moved to a one-way owner hash; comments carry no owner; the
  account-cap hash rotates per calendar month and is linkable within a month.
- Added anonymous poll reports (no reporter identifier, hour-coarsened timestamps,
  priority auto-hide thresholds) and coarse per-poll daily view counters; the
  signed snapshot hash now also covers the cumulative view total.
- Added poll types (verdict, single choice, multiple choice) with per-poll options,
  replaced the proposal start/end times with a fixed duration, and extended the
  snapshot hash to cover ballots and per-option counts. Documented the
  combination-per-anonymous-ballot exposure and the optional AI provider data flow.
- Unified the three poll types behind one options engine, so a verdict poll now
  exposes three options and a verdict ballot still stores only a single small
  integer. Added `schemaVersion` to the canonical snapshot payload (version 2) and
  taught verification to accept version 1 chains, so chains published before this
  release still verify.
- Gave the verdict type its own stored code again: `poll_type = 1` is a
  single-answer poll whose options the proposal form generates as Approve, Neutral,
  and Oppose, and the CHECK accepts `poll_type IN (1, 2, 3)`, so a verdict poll is
  identifiable again. Ballot rules, counting, and the snapshot payload are
  unchanged, and the earlier work stays in place:
  `poll_options` holds plain text labels only (no `preset_key`), the legacy
  `option` label is gone from `/api/vote` and `/api/vote/status`, the
  `{ approve, oppose, neutral }` counts object is gone from every response, and the
  canonical snapshot payload is version 3 (verification still reproduces versions 1
  and 2).
- Folded the schema into the baseline `migrations/0001_initial.sql`
  (2026-10-18) now that nothing had been deployed: the file creates the final shape
  of every table, index, and constraint directly, so a fresh database needs no
  intermediate table rebuilds. The baseline is now immutable; every later schema
  change is a separate numbered migration file applied in filename order.
- Made the snapshot chain a single format: dropped the legacy `approve`/`oppose`/
  `neutral` columns and the version 1 and 2 payloads, leaving `schemaVersion: 3`
  only. Added the Worker publisher, which replaces the GitHub Actions workflow and
  copies the chain to a public data repository from the hourly maintenance run with
  a fine-grained token stored as a secret (`github_token`). Restored the CI workflow
  (`.github/workflows/ci.yml`), which had briefly been removed while the checks ran
  locally.
- Moved every password hash into the `PasswordHasher` Durable Object and converted
  both Durable Object classes to the SQLite storage backend (`new_sqlite_classes`),
  so the CPU-heavy PBKDF2 derivation never runs on the request path and all hashing
  is centralised.
- Reduced Durable Object cost: the password hasher is sharded by username across 16
  instances, the view counter keeps its per-network rate window in its own memory
  instead of calling the rate limiter (one object request per page view, no
  rate-limit rows), and the rate limiter writes a bucket only when its window
  starts or the count crosses a threshold and arms its alarm once per window. Also
  verified the Turnstile response hostname, returned `423` for read-only votes
  instead of sharing the missing-key `503`, and batched the publisher to 40 polls
  per run with a `publish_state` batch cursor.
- Required the site origin on the anonymous mutations: voting, the poll and comment
  report endpoints, and view counting now answer `403` for a request that carries no
  `Origin` header or one from another origin. Before this, a third-party page could
  POST from each visitor's browser with a fresh token hash, one ballot per visitor
  from a distinct network bucket, which walked around the per-network vote limit
  while Turnstile was off.
- Closed the remaining exact timestamps and address buckets: a submitted poll's
  `created_at`, `updated_at`, and `reviewed_at` are written at the hour, a successful
  login no longer stamps an exact `updated_at`, an IPv6 address is bucketed by its
  `/64` prefix instead of the whole text, and every admin response now carries the
  same security headers as the public Worker. The iteration count quoted in the docs
  is now the `PBKDF2_ITERATIONS` constant rather than a stale 600k.
- Replaced the server-keyed owner hashes with user-held author keys: polls and
  comments now store one fixed `author_mark` per account, the random author key is
  stored only wrapped under password-, recovery-code-, and session-derived keys, and
  "my polls" and "my comments" are ordinary paginated queries, so the browser
  remembers nothing and there is no claim step. A database copy, even with the
  server secret, cannot link a row to an account.

## Known trade-offs

- **Account-cap hash.** The per-network account cap uses a keyed hash of the
  network bucket rotated per calendar month. Two accounts created from the same
  network in the same month share a hash (linkable within that month).
- **Browser token rotation.** The browser vote token rotates after 30 days. When
  it rotates, local "already voted" markers are re-keyed per poll, so a returning
  browser may vote again on an *evergreen* poll. This is a deliberate trade-off
  between linkability and the strength of one-token-per-device; polls with a
  deadline are unaffected once they close.
- **Undocumented host settings.** Cloudflare-side logging (Logpush, Web
  Analytics, Bot Analytics), Managed Transforms "Remove visitor IP headers", and
  Onion Routing are recorded in the configuration log above.
- **Rewritten closing hour.** A poll's terminal counts are written when it
  closes, which can rewrite that hour's snapshot row (counts, hash, and `final`
  flag) in place. A verifier who copied the chain between the hourly snapshot run
  and the close may therefore see a different hash for that hour than the server
  later reports. Only the row marked `final` is authoritative for the closing
  hour, and at most one hour per poll is ever rewritten; earlier hours and their
  hashes never change.