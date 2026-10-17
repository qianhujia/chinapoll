# ChinaPoll threat model

This document states what ChinaPoll protects, what it does not, and which
records would be exposed by a breach or a legal request. It is reviewed whenever
the schema or the network handling changes.

## Assets

- The integrity of published vote totals.
- The confidentiality of who voted, who commented, and who submitted which poll.
- The confidentiality of account credentials and recovery codes.

## What the system stores

- Votes: the SHA-256 hash of a per-poll browser token and the chosen option.
  There is no account link and no network value.
- Comments and polls: free text, an optional owner (`user_id`), and a creation
  timestamp coarsened to the hour.
- Accounts: username, a PBKDF2-HMAC-SHA256 password hash, a single recovery
  code hash, and lock/bookkeeping fields. Login time is rounded to the day.
- The per-network account cap: a keyed, daily-rotated hash of the network bucket
  in `auth_attempts`. The raw address is never stored.
- Poll reports: only the poll reference, the reason code, an optional free-text
  note, and an hour-coarsened timestamp. There is no reporter identifier at all.

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
  published for external verification.

## Reports

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
- Added anonymous poll reports: no reporter identifier, hour-coarsened
  timestamps, and priority auto-hide thresholds.

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