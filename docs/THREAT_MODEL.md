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

## Adversaries and mitigations

- **Network observer**: served over HTTPS with HSTS; no third-party origins are
  referenced by the application build.
- **Database attacker**: cannot reverse a vote to a person, cannot reverse a
  keyed network hash without `IP_HASH_KEY`, and cannot use a stolen password
  hash offline faster than the 600k-iteration PBKDF2 cost allows.
- **Spammer**: rate limiting is atomic and per-scope in a Durable Object; new
  accounts must age before they can submit; per-network account creation is
  capped.
- **Abusive session**: cookie mutations require a same-origin request, and
  rotating the recovery code or deleting the account both require the current
  password.
- **Content tampering**: hourly signed snapshots form an append-only hash chain
  published for external verification.

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