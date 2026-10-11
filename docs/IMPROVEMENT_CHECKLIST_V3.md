# ChinaPoll improvement checklist v3

Status of the launch-blocker review. Consolidated after the terminal-snapshot
work, the migration consolidation, and the first integration-test suite.

---

## 1. Must fix before launch

### 1.1 A poll's final result is never captured in the hash chain

- Files: `worker/services/maintenance.ts`, `worker/api/user.ts`, `admin/api/polls.ts`, `worker/services/snapshot.ts`
- Fix: a snapshot (or upsert) is written from every close path — the cron close,
  `closeUserPoll`, and the admin `closed` branch — using the current hour. The
  cron runs `writeSnapshots` before the close step and also covers polls with
  `status = Closed AND closed_at >= now - 3600` that have no terminal snapshot. A
  `final` column marks the terminal record and the snapshots API exposes it.

### 1.2 The publish job archives only open polls and only the first 500 snapshots

- Files: `scripts/publish-snapshots.mjs`, `worker/api/polls.ts`
- Fix: `GET /api/polls/recent-closed?days=35` lists recently closed polls; the
  script iterates open and recently closed polls, follows `nextAfter` until
  `hasMore` is false, and appends to the existing JSON file without deleting it.

### 1.3 Deep links are served without the Content Security Policy

- Files: `wrangler.toml`, `worker/index.ts`
- Fix: `run_worker_first = true` and every non-API path is fetched from the
  assets binding and wrapped with `withHtmlCsp`. Unknown `/api/*` paths return
  JSON so they never fall through to the SPA shell.

### 1.4 The CI migration step targets a database that does not exist in configuration

- Files: `.github/workflows/ci.yml`, `wrangler.toml`, `admin/wrangler.toml`
- Fix: both Workers define `[env.production]` (including `vars`, `durable_objects`,
  and the Durable Object migration list, which are not inherited) binding the
  `chinapoll` database. CI applies migrations and deploys with `--env production`.

---

## 2. Anonymity and security

### 2.1 Fold the migrations into one file while nothing is deployed, then freeze

- Files: `migrations/0001_initial.sql`, `README.md`, `docs/RUNBOOK.md`
- Fix: the whole schema lives in `0001_initial.sql`, frozen on 2026-10-11. Later
  changes go in new numbered files.

### 2.2 Derive purpose-specific keys from the server HMAC key

- Files: `worker/services/ip.ts`, `worker/services/owner.ts`, `shared/crypto.ts`
- Fix: `deriveKey(master, purpose)` returns `HMAC(master, purpose)`; network
  hashing uses `'network'` and owner hashing uses `'owner'`. The secret is named
  `SERVER_HMAC_KEY`, with `IP_HASH_KEY` kept as a fallback for one release.

### 2.3 Rate limiter shards collapse for account-keyed scopes

- Files: `worker/services/rateLimit.ts`
- Fix: shard by the first two characters of `sha256Hex(key)` so `user:<id>` keys
  spread across shards.

### 2.4 `blockConcurrencyWhile` on every call blocks unrelated keys

- Files: `worker/services/rateLimiter.ts`
- Fix: the read-modify-write runs inside `storage.transaction(...)` instead.

### 2.5 Drop the unused owner index

- Files: `migrations/0001_initial.sql`
- Fix: `idx_polls_owner` is removed; ownership checks look up by `id`.

### 2.6 Document that "my polls" lives in the browser

- Files: `src/pages/account.ts`, `public/i18n/*.json`
- Fix: the account page explains the browser-local list and offers a field that
  adds a poll id after the server confirms ownership.

### 2.7 Admin "open" on a future-dated deadline poll

- Files: `admin/api/polls.ts`
- Fix: approving a deadline poll whose start is in the future stores `Pending`
  with `reviewed_at` set and returns `status: 'scheduled'`; the cron opens it on
  schedule.

---

## 3. Testing and housekeeping

### 3.1 Integration tests

- Files: `package.json`, `vitest.workers.config.ts`, `tests/integration/`
- Fix: `@cloudflare/vitest-pool-workers` runs a second Vitest project against a
  real workerd + D1 instance. Coverage: vote on a closed poll, duplicate vote,
  threshold hiding, register then comment before and after the delay, CSRF
  rejection, rate-limit exhaustion and reset, the cron close-hour terminal
  snapshot, the CSP header on `/poll/1`, and a full `verify` of a 600-row chain.

### 3.2 Remove superseded checklists

- Files: `docs/IMPROVEMENT_CHECKLIST.md`, `docs/IMPROVEMENT_CHECKLIST_V2.md`
- Fix: both are removed; this file supersedes them.

### 3.3 Publish workflow hygiene

- Files: `.github/workflows/publish-snapshots.yml`
- Pending: pin the bot identity, add `concurrency: publish-snapshots`, and fail
  the job when `/api/health` reports `ok: false`.

---

## 4. Future milestone: per-poll Durable Object as the vote ledger

Not for this release. One Durable Object per poll holds the token-hash set and the
three counts in SQLite storage, the vote endpoint returns counts from the object,
the hourly cron reads counts from each object and writes the snapshot row, and D1
stops storing individual votes. On finalisation the object writes the terminal
snapshot and deletes its storage.
