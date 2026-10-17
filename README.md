# ChinaPoll

A local-first privacy-focused polling app designed around the Cloudflare + D1 architecture described in the product spec.

## Local startup

```bash
npm install
npm run dev
```

This starts:

- Built front-end preview at http://127.0.0.1:5173
- Local Worker at http://127.0.0.1:8787
- Local D1 database persisted under .wrangler

The local start command builds the frontend and Worker before starting them without hot reload. To apply code or style changes, stop the running processes and start `npm run dev` again.

Application settings are stored in the local D1 `settings` table and served to the front end by `/api/settings/public`. The `settings` table is the single source of truth for feature flags: read-only mode (`read_only_mode`), Turnstile (`turnstile_enable` plus the private `turnstile_secret_key`, which is never exposed by the public endpoint), rate limits (`vote_rate_limit`, `comment_rate_limit`, `proposal_rate_limit`, `report_rate_limit` in `"<count>/<unit>"` format with unit `w|d|h|m|s`), and the homepage hero (`hero_title`, `hero_subtitle`, `hero_background_color` — a CSS color (hex, rgb/a, hsl/a, or named) or CSS gradient; empty means no background). `.dev.vars` still holds local Worker secrets, and Turnstile is disabled locally by default (`turnstile_enable=false`).

Public application settings use these self-explanatory keys: `default_locale` (`en`, `zh-CN`, or `zh-TW`), `site_name`, `site_slogan`, `data_repository_url`, `polls_per_page`, `comments_per_page`, `page_max_width_px`, `hero_title`, `hero_subtitle`, `hero_background_color`, `read_only_mode`, `turnstile_enable`, `turnstile_site_key`, `min_votes_to_display`, `min_views_to_display`, `report_rate_limit`, `report_auto_hide_threshold`, `report_auto_hide_priority_threshold`, `vote_rate_limit`, `comment_rate_limit`, and `proposal_rate_limit`. Page sizes are limited to 1–100; the page width is in pixels; `min_votes_to_display` (default 10) hides vote totals until a poll reaches that many votes and `min_views_to_display` (default 20) hides view totals until a poll reaches that many views. Missing or invalid settings fall back to built-in defaults. The locale supports `en`, `zh-CN`, and `zh-TW`; translations are loaded from `public/i18n/en.json`, `public/i18n/zh.json`, and `public/i18n/zh-TW.json`.

User-account settings are also stored in the `settings` table and served by the same endpoint: `user_poll_delay_hours` (default 48) and `user_comment_delay_hours` (default 24) set how long a new account must wait before it can submit a poll or post a comment, `max_accounts_per_ip` (default 4) caps how many accounts one anonymized network bucket may create, `login_max_failed_attempts` (default 5) and `login_lock_minutes` (default 15) control the lock after repeated failed sign-ins, and `login_rate_limit` (default `10/h`) and `register_rate_limit` (default `5/d`) rate limit sign-in and sign-up attempts per network bucket. Delay values are whole hours; the rate limits use the shared `"<count>/<unit>"` format with unit `w|d|h|m|s`. `login_badge_enable` (default `false`) is an optional navbar flag: when set to `true`, a small "Optional" badge is shown on the top-right corner of the login and sign-up links next to the header search to make clear that signing in is not required. `auto_approve_polls` (default `false`) controls moderation: when `true`, a submitted poll is published immediately; when `false`, it stays pending until an admin approves it from the dashboard's Polls tab.

Settings are managed from the standalone admin Worker dashboard (see [Admin Worker](#admin-worker)). Values are validated before they are written, and the Settings tab can insert any missing defaults.

Keep secrets out of `.env` and `wrangler.toml`: use the ignored `.dev.vars` file for local Worker secrets and `wrangler secret put <NAME>` for production secrets. The Turnstile secret key lives in the `settings` table (64-character hex when set); the Worker only verifies tokens when `turnstile_enable` is `true` and a secret key is present, and the public `turnstile_site_key` setting is rendered by the vote and auth forms. The public Worker also needs a `SERVER_HMAC_KEY` secret (a 64-character hex value) for keyed, daily-rotated network hashing and for owner hashing; the legacy `IP_HASH_KEY` name is still read as a fallback for one release but should be renamed. Without either secret, voting and account creation return `503`.

The homepage lists open polls stored in the local D1 `polls` table. An empty database shows no polls; the repository does not bundle poll seed or demo records.

## User accounts

Voting stays anonymous, but submitting a poll and posting a comment require an account. Users sign up with a username and password only; there is no email or recovery channel, so credentials must be kept safe (like a crypto recovery phrase). Passwords are hashed with PBKDF2-HMAC-SHA256 (600,000 iterations, set by the `PBKDF2_ITERATIONS` constant in `shared/password.ts`) and stored in the `users` table as `pbkdf2$iterations$salt$hash`. Sessions live in `user_sessions` with a thirty-day sliding expiry and are stored in an HttpOnly, SameSite=Strict cookie; only the SHA-256 hash of the token is kept.

- New accounts can submit a poll after `user_poll_delay_hours` and comment after `user_comment_delay_hours`, so brand-new accounts cannot post immediately.
- Repeated failed sign-ins lock the account after `login_max_failed_attempts` for `login_lock_minutes` minutes.
- Sign-up and sign-in are rate limited per anonymized network bucket, and one bucket may only register `max_accounts_per_ip` accounts. The bucket is stored as a 32-bit integer (`ip_prefix`): a dotted IPv4 address is reduced to its `/24` network, and other addresses (for example IPv6) are folded with a hash, so no full IP address is stored.
- An optional badge on the top-right corner of the login and sign-up links (enabled with `login_badge_enable`) tells visitors that logging in is not required; the badge text is localized (`Optional` / `可选`).
- Each account receives one high-entropy, single-use recovery code at sign-up. It is shown once (with a copy action) and only its SHA-256 hash is stored on the `users` row, so no plaintext code is ever persisted. The code resets a forgotten password from `/reset` (linked from the login page): it is rotated as it is consumed, the failed-attempt lock is cleared, and every session is signed out. A fresh code can also be generated from `/account`, which immediately invalidates the current one.
- Signed-in users manage their own content from `/account`: they can close or withdraw their polls and delete their own comments.
- Submitting a poll and posting a comment both require a signed-in account. Newly submitted polls stay pending until an admin approves them, unless `auto_approve_polls` is enabled.

Public account endpoints (session state, register, login, logout, and recovery) live under `/api/auth`, and the self-service content and recovery-code endpoints live under `/api/user`.

## Local D1 + migrations

The local database schema is managed with versioned SQL migrations in the `migrations/` folder. `npm run db:migrate` applies every pending migration (the Wrangler tracking table is named `migrations`, set with `migrations_table` in `wrangler.toml`). Public settings fall back to built-in defaults until they are written, and the dashboard's Settings tab can insert any missing defaults.

**Applied migrations are never edited.** Migrations are immutable once recorded: schema changes go in a new file (numbered from `0002`). `migrations/0001_initial.sql` is the entire schema, frozen on 2026-10-11 when the earlier incremental files were folded into it because nothing had been deployed. Because the initial schema was consolidated, **only fresh databases are supported**: create a database from scratch (run `npm run db:reset` locally, or apply `0001_initial.sql` and any later files to an empty production database) rather than upgrading a database that recorded the earlier pre-consolidation migrations.

```bash
npm run db:migrate
```

This keeps schema changes reproducible across local development. Future schema updates should be added as new migration files in the same folder.

## Proposal approval

Review and publish pending submissions from the dashboard's Polls tab: set a poll's status to `open` to approve it or to `closed` to reject it. A poll keeps the same ID from submission through approval.

## Poll reports and view counts

Visitors can report a poll from the poll page without an account:
`POST /api/polls/:id/report` accepts `{ "reason": "<label>", "note"?: "<text>" }`.
The reason labels are `spam`, `inappropriate`, `misleading`, `copyright`,
`personal_info`, `harassment`, `illegal`, and `other`; a note is accepted only
with `other` and is limited to 300 characters. The endpoint is rate limited with
`report_rate_limit` (default `3/d`) using the keyed, daily-rotated network hash,
and it never stores or returns any reporter identifier.

A report stores no address, network bucket, user id, or exact timestamp: the
creation time is coarsened to the hour, and the report id is not returned. Codes
`personal_info`, `harassment`, and `illegal` are treated as high priority. After
each report the open-report counts are checked against `report_auto_hide_threshold`
(default 5) and `report_auto_hide_priority_threshold` (default 2); when either is
reached the poll is set back to pending with `reviewed_at` cleared so it leaves
public listings until an admin reviews it, and an audit entry with action
`poll.auto_hidden` is written. Setting a threshold to `0` disables that rule.

Each poll also counts how often it is opened, without recording who opened it:
`POST /api/polls/:id/view` increments one per-poll, per-UTC-day counter
(`poll_views`). The browser calls it once per tab session, and the server rate
limits the call at `60/h` through the Durable Object, always answering `204` so
the response reveals nothing. `GET /api/polls/:id` and the poll list report
`views: { total, last7Days } | null`, where the value is `null` below
`min_views_to_display` (default 20). Cumulative views are included in the signed
hourly snapshot chain.

Retention: resolved reports are deleted 90 days after `resolved_at`, and view
rows older than 90 days are rolled up into a single per-poll row so long-term
totals survive while daily resolution is dropped. Both are removed with the poll
by the foreign key cascade.

## Admin Worker

The admin tools are packaged as a standalone Cloudflare Worker that shares the
main application's D1 database. It serves a browser dashboard plus a JSON API for
reviewing submissions, adjusting polls, reviewing poll reports, moderating comments, managing admin
users, managing public accounts, reviewing an audit log, and updating settings. Each dashboard view has a
dedicated URL (`/polls`, `/reports`, `/comments`, `/users`, `/admins`, `/audit`, `/settings`, and
`/overview`). See `admin/README.md` for the full endpoint reference.

```bash
cp admin/.dev.vars.example admin/.dev.vars        # optional local secrets
npm run db:migrate                                # applies the admin_users migration
npm run admin:worker:dev                          # http://127.0.0.1:8788
```

The Worker binds to the same local D1 database under `.wrangler`, so it can run
alongside the public Worker. Admin users sign in with a username and password
(PBKDF2-hashed). Because no admin exists yet, the dashboard first shows a setup
form; the first account becomes the super admin, and accounts added from the
Admins tab are regular admins. Sessions expire after 30 minutes of inactivity, five
failed sign-ins lock an account for 15 minutes, and the lock can be reset from the
Admins tab. Only super admins can open the audit log.

Optional Turnstile verification on login reuses the `turnstile_enable` and
`turnstile_secret_key` settings together with the public `TURNSTILE_SITE_KEY`
variable; it is skipped while the feature is disabled or keys are absent. The
dashboard is protected by a per-request CSP nonce, cookie-authenticated writes
are rejected unless they originate from the Worker itself, and the audit log
records admin actions without client IP addresses. Deploy with
`npm run admin:worker:deploy`.

## Testing and CI

`npm test` runs two Vitest projects:

- Node unit tests (`vitest.config.ts`) for pure functions.
- Workers-runtime integration tests (`vitest.workers.config.ts`, backed by
  `@cloudflare/vitest-pool-workers`) that run inside a real workerd instance with
  D1 and the RateLimiter Durable Object. They cover the vote path, threshold
  hiding, rate-limit exhaustion and reset, the account comment delay, CSRF
  rejection, the cron snapshot chain including the close-hour terminal snapshot,
  the Content Security Policy on a deep link, a full `verify` of a chain
  longer than one API page, poll reporting (validation, the hourly timestamp, the
  report rate limit, and both auto-hide thresholds), view counting (the daily
  counter, the display threshold, the 7-day window, and the always-204 rate
  limit), and the admin report list and resolve handlers. Every migration is
  applied to the isolated test database in order (`migrations/0001_initial.sql`,
  then `migrations/0002_reports_and_views.sql`).

```bash
npm test              # unit + integration
npm run test:unit
npm run test:workers
```

`.github/workflows/ci.yml` runs `npm run lint`, `npm run build`, `npm test`,
`npm run build:worker`, and `npm run admin:worker:dry-run` on every push and pull
request, fails if the built SPA references any external origin other than
`challenges.cloudflare.com`, and deploys both Workers with `--env production` on a
`v*` tag.

## Privacy documentation

- `docs/THREAT_MODEL.md` describes what the system protects and the Cloudflare
  settings that must stay disabled.
- `docs/DATA_MAP.md` lists every table and column, its readers, and its
  retention.
- `docs/RUNBOOK.md` covers deployment, monitoring, backups, restore, and
  failover.

Vote timestamps and comment timestamps are coarsened to the hour, network
buckets are stored only as keyed daily-rotated hashes, and account deletion is
self-service from `/account` (content is kept but carries no account link).

Two deliberate trade-offs are documented in `docs/THREAT_MODEL.md`: the
account-cap hash is linkable within a calendar month, and the browser vote token
rotates every 30 days (which lets a returning browser vote again on an evergreen
poll).

Password hashing uses PBKDF2-HMAC-SHA256 at 600,000 iterations, which needs the
Cloudflare Workers **paid plan** (the free plan allows only 10 ms of CPU per
request). Lower the iteration count in `shared/password.ts` if the free plan must
be used.

## Local workflow

`npm run db:migrate` applies pending migrations. `npm run db:reset` deletes the
local `.wrangler` state and reapplies every migration for a clean database.
Dashboard missing-default settings are inserted from the Settings tab.

## Production deployment

The SPA and the public API share **one hostname**: the public Worker serves the
built assets from `dist/web` and handles `/api/*`. The admin Worker uses a
**separate hostname** and a separate dashboard. Both `wrangler.toml` files define
an `[env.production]` environment that binds the production `chinapoll` database;
replace the placeholder `database_id` with the real database UUID. Deploy with
`npx wrangler deploy --env production` and
`npx wrangler deploy --config admin/wrangler.toml --env production`, as described
in `docs/RUNBOOK.md`.

## Build check

The Vite production build compiles Tailwind utilities and Lucide icons into the deployed CSS and JavaScript bundles; neither library is needed at runtime.

```bash
npm run build
```
