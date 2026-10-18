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
- Comments: free text, a random public id, and a one-way owner hash derived from the
  server secret (`worker/services/owner.ts`). A comment is anonymous to the public:
  the hash never leaves the database for readers. The author can still claim it, and
  only through that hash: the account dashboard asks the server to confirm the
  comment ids the browser remembers against the owner hash, and the admin dashboard
  can list a user's comments only through the same hash check, never through a stored
  user ID (no such column exists).
- Polls: free text, the same kind of one-way `owner_hash`, and a creation timestamp
  coarsened to the hour, so the dashboard can list and close the polls an account
  submitted without the database naming the author. The hash message for a poll is
  fixed (`worker/services/owner.ts`), and the hash proves submission only: a poll an
  account voted on is never listed as one of its polls.
- Accounts: username, a PBKDF2-HMAC-SHA256 password hash, a single recovery
  code hash, and lock/bookkeeping fields. Login time is rounded to the day.
- The per-network account cap: a keyed, daily-rotated hash of the network bucket
  in `auth_attempts`. The raw address is never stored.
- Poll reports: only the poll reference, the reason code, an optional free-text
  note, and an hour-coarsened timestamp. There is no reporter identifier at all.
- Poll views: one counter per poll per UTC day. There are no per-view rows, so a
  view cannot be attributed to a viewer.

## Adversaries and mitigations

- **Network observer**: served over HTTPS with HSTS; no third-party origins are
  referenced by the application build.
- **Database attacker**: cannot reverse a vote to a person, cannot reverse a
  keyed network hash without `SERVER_HMAC_KEY`, and cannot use a stolen password
  hash offline faster than the 600k-iteration PBKDF2 cost allows.
- **Spammer**: rate limiting is atomic and per-scope in a Durable Object; new
  accounts must age before they can submit; per-network account creation is
  capped.
- **Abusive session**: cookie mutations require a same-origin request, and
  rotating the recovery code or deleting the account both require the current
  password.
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
published only as an aggregate `{ total, last7Days }`, and only once the poll
passes `min_views_to_display` (default 20), so a poll with a couple of views and
one vote cannot be used to guess the voter. View rows older than 90 days are
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

## Workers AI data flow

AI assistance is optional and off by default (`ai_enable` defaults to `false`).
When it is on:

- The draft the user typed (title and optional description) is sent from the
  browser to `POST /api/ai/enhance-title` or `POST /api/ai/suggest-options`, and
  the Worker forwards it to Cloudflare Workers AI through the `AI` binding. The
  validated suggestions are returned straight to the caller.
- **Nothing is stored.** The prompt and the model response are never logged and
  never written to D1. There is no prompt table, no response table, and no cache.
- The endpoints require a signed-in account, pass the same account-age gate as
  proposals, enforce the same Origin check, verify Turnstile when it is enabled,
  and are rate limited per account with scope `ai`.
- Workers AI is a third-party service. Turning `ai_enable` on therefore means the
  draft text leaves the operator's own systems and is processed by Cloudflare's
  model runtime under Cloudflare's terms; that is the same trade-off the threat
  model already documents for Turnstile, and the frontend states it in one line
  under the AI buttons.

## Explicit non-goals

- The system does not defend against an adversary who controls the Cloudflare
  edge and records metadata. Cloudflare-side Logpush, Web Analytics, and Bot
  Analytics must be disabled, and "Remove visitor IP headers" enabled in Managed
  Transforms. Record the date each setting was applied here.
- Accounts still link a person's polls and comments to one account row. Polls and
  comments are shown publicly without usernames, but a database reader sees the
  owner links. See `docs/DATA_MAP.md`.
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
  combination-per-anonymous-ballot exposure and the optional Workers AI data flow.
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
- Folded the schema back into the single consolidated `migrations/0001_initial.sql`
  (2026-10-18) now that nothing has been deployed: the file creates the final shape
  of every table, index, and constraint directly, so a fresh database needs no
  intermediate table rebuilds, and the removed incremental files are no longer part
  of the repository.
- Made the snapshot chain a single format: dropped the legacy `approve`/`oppose`/
  `neutral` columns and the version 1 and 2 payloads, leaving `schemaVersion: 3`
  only. Added the Worker publisher, which replaces the GitHub Actions workflow and
  copies the chain to a public data repository from the hourly maintenance run with
  a fine-grained token stored as a secret (`github_token`). Restored the CI workflow
  (`.github/workflows/ci.yml`), which had briefly been removed while the checks ran
  locally.

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