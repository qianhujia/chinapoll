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

Public application settings use these self-explanatory keys: `default_locale` (`en`, `zh-CN`, or `zh-TW`), `site_name`, `site_slogan`, `data_repository_url`, `polls_per_page`, `comments_per_page`, `page_max_width_px`, `hero_title`, `hero_subtitle`, `hero_background_color`, `read_only_mode`, `turnstile_enable`, `turnstile_site_key`, `min_votes_to_display`, `min_views_to_display`, `report_rate_limit`, `report_auto_hide_threshold`, `report_auto_hide_priority_threshold`, `vote_rate_limit`, `comment_rate_limit`, `proposal_rate_limit`, and `ai_enable`. Page sizes are limited to 1–100; the page width is in pixels; `min_votes_to_display` (default 10) hides vote and ballot totals until a poll reaches that many votes — the threshold hides **results only**, so voting is always possible on an open poll from its poll page — and `min_views_to_display` (default 20) hides view totals until a poll reaches that many views. Missing or invalid settings fall back to built-in defaults. The locale supports `en`, `zh-CN`, and `zh-TW`; translations are loaded from `public/i18n/en.json`, `public/i18n/zh.json`, and `public/i18n/zh-TW.json`.

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
- Signing in on a new device keeps every other device signed in; "Sign out of all devices" on `/account` ends them all (including the current browser), and password recovery signs out everywhere.
- Submitting a poll and posting a comment both require a signed-in account. Newly submitted polls stay pending until an admin approves them, unless `auto_approve_polls` is enabled.

Public account endpoints (session state, register, login, logout, and recovery) live under `/api/auth`, and the self-service content and recovery-code endpoints live under `/api/user`.

## Local D1 + migrations

The local database schema is managed with versioned SQL migrations in the `migrations/` folder. `npm run db:migrate` applies every pending migration (the Wrangler tracking table is named `migrations`, set with `migrations_table` in `wrangler.toml`). Public settings fall back to built-in defaults until they are written, and the dashboard's Settings tab can insert any missing defaults.

**Applied migrations are never edited.** Migrations are immutable once recorded: schema changes go in a new file (numbered from `0002`). `migrations/0001_initial.sql` is the entire schema, frozen on 2026-10-11 when the earlier incremental files were folded into it because nothing had been deployed. `0002_reports_and_views.sql` adds anonymous reports and view counting, `0003_poll_types_and_options.sql` adds the poll types, the per-poll options, the choice ballot tables, `polls.duration_seconds`, and the `ballots`/`option_counts` columns of the snapshot chain, and `0004_unified_selections.sql` removes the verdict poll type and `votes.option` and records every selection in `vote_selections`: every `poll_type = 1` poll becomes a single choice poll with the rows `Approve`, `Neutral`, and `Oppose`, each old verdict ballot becomes one selection on the matching row (code 1 Approve, 2 Oppose, 3 Neutral), the CHECK narrows to `poll_type IN (2, 3)`, and the snapshot columns the version 1 and 2 payloads need are kept with a default of 0. Because the initial schema was consolidated, **only fresh databases are supported**: create a database from scratch (run `npm run db:reset` locally, or apply `0001_initial.sql` and any later files to an empty production database) rather than upgrading a database that recorded the earlier pre-consolidation migrations.

```bash
npm run db:migrate
```

This keeps schema changes reproducible across local development. Future schema updates should be added as new migration files in the same folder.

## Proposal approval

Review and publish pending submissions from the dashboard's Polls tab: set a poll's status to `open` to approve it or to `closed` to reject it. A poll keeps the same ID from submission through approval. Approving a poll that has no options is refused (`422`). Options can be corrected from the Polls tab (`PUT /api/admin/polls/:id/options`) while a poll is still **pending and has no ballots**: the label set is replaced by position. Once a poll is open (or has ballots) the option set is frozen, since it is part of the published question and of its counts.

## Poll types and options

A poll is one of two ballot shapes, selected on the proposal form and stored in `polls.poll_type`:

| Code | `poll_type` | Options | Selections per ballot |
| --- | --- | --- | --- |
| 2 | `single_choice` | 2 to 7 rows | exactly 1 |
| 3 | `multi_choice` | 2 to 7 rows | 1 to all |

The form also offers a **Verdict** card, which is a template rather than a type:
choosing it submits an ordinary `single_choice` poll whose options are pre-filled
with the three verdict words (Approve, Neutral, Oppose). Every row stays editable,
so the submitter may rename them, remove one to keep two, or add up to seven. The
request body is the same as any other single choice poll:
`{ "pollType": "single_choice", "options": [...] }`.

### One engine, two types

Every poll keeps its options in `poll_options` as plain text and records one
`vote_selections` row per chosen option. There is no preset, virtual, or
translated column: a verdict poll's rows are the three words the form pre-filled,
with nothing special about them on the database side. `votes` is a ballot table
only and holds **no choice data** (`id`, `poll_id`, `voter_token_hash`,
`created_at`).

In **code** there is one engine, `worker/services/options.ts`, and every poll goes through it:

- **Every poll exposes a list of options.** `getPollOptions` reads `poll_options`
  ordered by position. Options are identified by `id` in every request and
  response, and the frontend renders each stored label.
- **Every ballot is a set of selected option IDs.** `validateSelections` accepts `{ optionIds: number[] }`. A single choice poll requires exactly one option ID; a multiple choice poll requires 1 to 7 distinct option IDs. Every ID must belong to the poll, so a caller cannot vote with another poll's option. The verdict-era `option` label is gone.
- **One counting function.** `countBallots` returns `{ ballots, counts: Map<optionId, count> }` per poll from two aggregate queries total (paginate, then aggregate): the ballot total from `votes` and the per-option counts from `vote_selections` grouped by `(poll_id, option_id)`. The same two queries serve both poll types.
- **One results shape.** `toPublicResults` returns `{ pollType, ballots, hidden, threshold, options: [{ id, position, label, count }] | null }`. There is no separate counts object: each option carries its own `count`. Below `min_votes_to_display` **every** option count is withheld together while the ballot total is still returned. The threshold hides results only: the poll page always renders the vote controls for an open poll, and voting is disabled only for a poll that is not open, a visitor who has already voted, or a failed vote-status lookup. A visitor who votes below the threshold sees their stored options pre-checked while the numbers stay hidden. The home page lists every poll the same way — mode badge, type badge, ballot total, views, and a vote link to the poll page — and never votes in place.
- **One snapshot shape.** See the snapshot section below.

Voting happens on the poll page, where every poll renders one radio (single
choice) or checkbox (multiple choice) per option and a submit button. The results
list is built from the same options array.

A ballot stays **one row per (poll, token)** in `votes`, so the existing unique index keeps enforcing one ballot per browser. The ballot row is written first and its `vote_selections` rows second; if the second step fails the ballot is rolled back, so a partial ballot is never left behind.

### Endpoints

`POST /api/vote` accepts `{ pollId, tokenHash, turnstileToken?, optionIds }`. `POST /api/vote/status` returns `optionIds`. `GET /api/stats/:id`, `GET /api/polls/:id`, and the poll list return `pollType`, `options`, and the results shape above.

Public responses show per-option counts only. Which options were chosen together on one ballot is never published and is only visible to a database reader, who still sees anonymous ballots (see `docs/THREAT_MODEL.md`).

## Duration model

The proposal form has no start or end time. It carries a duration instead, and
the mapping is defined once in `worker/enums.ts` and shared with the frontend
through `src/lib/poll.ts`:

| Label | Duration | Mode |
| --- | --- | --- |
| `none` | no end date | `evergreen` |
| `1d` | 1 day | `deadline` |
| `3d` | 3 days | `deadline` |
| `7d` | 7 days | `deadline` |
| `14d` | 14 days | `deadline` |
| `1m` | 30 days | `deadline` |
| `1y` | 365 days | `deadline` |

The table names the stored lengths; the form shows the last two as **1 month** and
**1 year**, so the wording matches how long the poll runs rather than the exact day
count.

`mode` is derived from the label (`none` stores `PollMode.Evergreen`, anything
else `PollMode.Deadline`) and `duration_seconds` stores the length (or `NULL`).
`start_at` is no longer written. `end_at` is computed when the poll **opens** as
`unixepoch() + duration_seconds`, in the admin status update that sets `open`, in
auto-approval, and in the hourly task for any open deadline poll that still has no
end date, so a poll that waited for review still gets its full duration. Poll
pages show "Ends on &lt;date&gt;" once a deadline poll is open and "No end date"
otherwise.

## AI assistance

Optional AI assistance uses Cloudflare Workers AI through an `AI` binding
declared as `[ai] binding = "AI"` in `wrangler.toml`, repeated under
`[env.production]`. It is **off by default**: `ai_enable` defaults to `false`, and
while it is off the two endpoints answer `404` and the frontend does not render
the buttons at all.

| Setting | Default | Public? |
| --- | --- | --- |
| `ai_enable` | `false` | yes (only this flag is exposed) |
| `ai_model` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | no |
| `ai_rate_limit` | `10/h` | no |

Both endpoints require a signed-in account, pass the same account-age gate as
proposals, enforce the Origin check, verify Turnstile when it is enabled, and are
rate limited per account with scope `ai` and key `user:<id>`:

- `POST /api/ai/enhance-title` with `{ title, description?, locale }` returns
  `{ suggestions: string[] }` (up to 3 alternatives, each at most 200 characters).
- `POST /api/ai/suggest-options` with `{ title, description?, pollType, count?, locale }`
  returns `{ options: string[] }` (2 to 7 options, each at most 80 characters).

The title must be 10 to 200 characters after trimming and the description at most
2000; anything else is rejected with `400`. The model is asked for structured JSON
through `response_format` and the answer passes a strict parser (array type, item
count, string type, trimmed length, no markdown, no duplicates). A malformed
answer is `502`, a model that does not answer within 15 seconds is `504`. The
prompt and the response are never logged and never written to D1: the validated
suggestions go straight back to the caller. The frontend states this in one line
under the buttons, and `docs/THREAT_MODEL.md` documents the data flow.

## Snapshot chain and its schema version

The hourly snapshot chain is the tamper-evident record of published results. Each record's hash covers the poll id, the hour, the number of ballots, the per-option counts, the cumulative view total, and the previous record's hash.

The canonical payload carries a `schemaVersion`:

- **Version 1** — poll id, hour, the three verdict counts, the cumulative views, and the chain link. Chains published before the poll types release have this shape.
- **Version 2** — adds `ballots` and `optionCounts` next to the three verdict counts.
- **Version 3** — drops the three verdict counts, which are no longer a concept now that a verdict poll is an ordinary single choice poll. `makeSnapshot` always writes version 3.

`verifySnapshotHash` and the `/api/snapshots/:id/verify` walk reproduce a stored hash under any supported version, so a chain copied out before either change still verifies and is never reported as tampered with. `/api/snapshots/:id` and the publish script both report the schema version alongside the snapshots.

`optionCounts` carries the per-position counts of the poll as JSON in `stats_snapshots.option_counts`, and `ballots` is the number of ballots at that hour. The three verdict columns stay in the table because the version 1 and 2 payloads cannot be recomputed without them: a record written now leaves them at 0, and `/api/snapshots/:id` still reports them so an external verifier can reproduce an older payload.

## Poll reports and view counts

Visitors can report a poll from the poll page without an account. The report
entry sits in the three-dot menu at the top right of the poll title, and choosing
it opens the report dialog.
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
Admins tab. Only super admins can open the audit log. An admin holds a single
active session: signing in elsewhere ends the previous one, and a password reset
or a role change ends every session of that admin.

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
  limit), the admin report list and resolve handlers, both poll types (ballot
  validation, per-option counts, the ballot threshold, the stored selection rows,
  and a verdict template poll behaving as an ordinary single choice poll), the
  duration model (`duration_seconds`, the derived mode, and the end date computed
  at open), the admin option editor, and AI assistance (the disabled setting, the
  auth gate, the input limits, a malformed model answer, and a valid trimmed
  answer). Every migration is applied to the isolated test database in order
  (`migrations/0001_initial.sql`, `0002_reports_and_views.sql`,
  `0003_poll_types_and_options.sql`, then `0004_unified_selections.sql`);
  `tests/integration/migrationSelections.test.ts` additionally applies `0001` to
  `0003`, seeds the pre-`0004` shape (including ballots, comments, reports, views
  and snapshots), and then applies `0004` to check the data copy, that every child
  row survived, that `votes.option` is gone and that `poll_type = 1` is refused.

The AI binding has no local simulator, so `vitest.workers.config.ts` sets
`remoteBindings: false` and the AI tests stub `env.AI` with an object whose `run`
returns canned JSON; the real model is never called from a test.

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
