# ChinaPoll reference

Technical reference for the public Worker, the D1 schema, and the shared
services. For the overview and local setup, see [../README.md](../README.md).

## Settings

Application settings are rows in the D1 `settings` table, served publicly by
`/api/settings/public`, and edited from the admin dashboard. Missing or invalid
values fall back to built-in defaults; the admin Settings tab can insert any
missing defaults. `.dev.vars` holds Worker secrets, not settings.

When a settings page is saved, a blank non-secret input is not written to D1:
the row is removed so the loader serves the built-in default directly. An
explicitly entered value is always stored, even when it happens to equal the
default. A blank secret field keeps the stored secret, because the form masks
it. The audit log records only the settings whose effective value changed, and a
reset to the default is marked with `"default": true`.

Public keys: `default_locale` (`en`, `zh-CN`, or `zh-TW`), `site_name`,
`site_slogan`, `data_repository_url`, `polls_per_page`, `comments_per_page`,
`page_max_width_px`, `hero_title`, `hero_subtitle`, `hero_background_color`
(a CSS color or gradient; empty means none), `read_only_mode`,
`min_votes_to_display`, `min_views_to_display`, `report_rate_limit`,
`report_auto_hide_threshold`, `report_auto_hide_priority_threshold`,
`vote_rate_limit`, `comment_rate_limit`, `proposal_rate_limit`, and the derived
`ai_enable` flag (true whenever the private `ai_provider` is not `off`).

- Page sizes are 1-100; the page width is in pixels.
- `min_votes_to_display` (default 10) hides result counts until a poll reaches
  that many votes. The threshold hides results only, so voting is always
  possible on an open poll.
- `min_views_to_display` (default 20) hides view totals in the poll lists until a
  poll reaches that many views. A poll's own page always shows its total.
- Rate limits use `"<count>/<unit>"` with unit `w|d|h|m|s`.
- `hero_background_color` accepts any CSS color (hex, rgb/a, hsl/a, or named) or
  gradient.
- The header logo and favicon (`logo`, `favicon`) each hold an `https` URL or an
  uploaded base64 data URI; `/api/settings/public` returns the URL to use. An
  uploaded image is served from `/image/logo.<ext>` or `/image/favicon.<ext>`,
  versioned by the row's update time, so the payload never travels in the
  settings document.
- `/api/settings/public` also returns the read-only `turnstile_enable` and
  `turnstile_site_key` from the Worker environment; they cannot be changed from
  the settings table.
- Translations live in `public/i18n/en.json`, `zh.json`, and `zh-TW.json`. The
  document embeds the default locale's dictionary in the bootstrap island (see
  "Server-rendered documents and the bootstrap island"), so the client fetches the
  file only as a fallback.

Account keys (same table and endpoint): `user_poll_delay_minutes` (10) and
`user_comment_delay_minutes` (10) gate new accounts; `max_accounts_per_ip` (4)
caps accounts per network bucket; `login_max_failed_attempts` (5) and
`login_lock_minutes` (15) control the lock; `login_rate_limit` (`10/h`) and
`register_rate_limit` (`5/d`) limit sign-in and sign-up per bucket;
`login_badge_enable` (`false`) shows an optional badge next to the login and
sign-up links; `auto_approve_polls` (`false`) publishes submissions immediately
instead of leaving them pending.

Private keys (never served publicly): `ai_provider`, `ai_api_url`, `ai_api_key`,
`ai_model`, `ai_rate_limit`, `ai_review_prompt`, and `github_token`. The Turnstile
secret is an environment variable, not a setting.

## Poll types and options

A poll is one of three ballot shapes in `polls.poll_type`:

| Code | `poll_type` | Options | Selections per ballot |
| --- | --- | --- | --- |
| 1 | `verdict` | three pre-filled rows (Approve, Neutral, Oppose) | exactly 1 |
| 2 | `single_choice` | 2 to 7 rows | exactly 1 |
| 3 | `multi_choice` | 2 to 7 rows | 1 to all |

A verdict poll behaves like a single choice poll; the only difference is how the
proposal form builds its options. Options are plain labels in `poll_options`;
there is no preset, virtual, or translated column, and the type is kept so a
verdict poll stays identifiable.

One engine, `worker/services/options.ts`, serves every type:

- `getPollOptions` reads `poll_options` ordered by position; options are
  identified by `id`.
- `validateSelections` accepts `{ optionIds: number[] }` (exactly 1 for verdict
  and single choice, 1-7 distinct for multiple choice); every id must belong to
  the poll.
- `countBallots` returns `{ ballots, counts }` from two aggregate queries: the
  ballot total from `votes` and per-option counts from `vote_selections` grouped
  by `(poll_id, option_id)`.
- `toPublicResults` returns `{ pollType, ballots, hidden, threshold, options }`;
  each option carries its own `count`. Below the threshold every count is
  withheld together while the ballot total is still returned.

`votes` is a ballot table only (`id`, `poll_id`, `voter_token_hash`,
`created_at`) and holds no choice data; each ballot writes one `votes` row and
its `vote_selections` rows, rolling back if the second step fails. A unique
index keeps one ballot per `(poll, token)`.

Endpoints: `POST /api/vote` (`{ pollId, tokenHash, turnstileToken?, optionIds }`),
`POST /api/vote/status` (returns `optionIds`), `GET /api/stats/:id`,
`GET /api/polls/:id`, and the poll list return `pollType`, `options`, and the
results shape. Which options were chosen together is never published.
`GET /api/polls/:id` additionally returns `prev` and `next`
(`{ id, title } | null`), the public polls on either side of it in the list
ordering (`created_at DESC, id DESC`), which the detail page renders as its
previous/next links. They are derived from the ordering rather than stored as
`prev_poll_id`/`next_poll_id` columns, so they cannot drift when a poll is added,
deleted, or changes status.

`POST /api/vote` requires a same-origin request: a browser sends an `Origin`
header on every POST, so a request without one, or from another origin, is refused
with `403` before the body is read. Without that check a third-party page could
post here from each visitor's browser and spend the visitor's own network budget.

## Duration model

The proposal form carries a duration, mapped in `worker/enums.ts` and shared
with the front end through `src/lib/poll.ts`:

| Label | Duration | Mode |
| --- | --- | --- |
| `none` | no end date | `evergreen` |
| `1d` / `3d` / `7d` / `14d` | 1 / 3 / 7 / 14 days | `deadline` |
| `1m` / `6m` / `1y` | 30 / 180 / 365 days | `deadline` |

`mode` is derived from the label and `duration_seconds` stores the length (or
`NULL`). `start_at` is no longer written. `end_at` is computed when the poll
opens as `unixepoch() + duration_seconds` (in the admin status update,
auto-approval, and the hourly task for any open deadline poll with no end date),
so a poll that waited for review still gets its full duration.

## Proposal approval

Pending submissions are reviewed from the dashboard's Polls tab: set a poll's
status to `open` to approve it or `closed` to reject it. When
`auto_approve_polls` is enabled, a submission is published immediately unless
both AI is on (`ai_provider` is not `off`) and `ai_review_prompt` is not empty: in
that case the AI model reviews the submission against the admin prompt and
publishes it only when the review approves. A rejected, failed, or unusable
review leaves the poll pending for an admin. A poll keeps the same id from
submission through approval. Approving a poll that has no options is refused
(`422`). Options can be corrected
with `PUT /api/admin/polls/:id/options` while a poll is still pending and has no
ballots: the label set is replaced by position.
Once a poll is open (or has ballots) the option set is frozen, since it is part
of the published question and of its counts.

## User accounts

Voting stays anonymous, but submitting a poll and posting a comment require an
account. Users sign up with a username and password only; there is no email or
recovery channel, so credentials must be kept safe like a crypto recovery phrase.

- Passwords are PBKDF2-HMAC-SHA256 (100,000 iterations, `PBKDF2_ITERATIONS` in
  `shared/password.ts`) stored in `users` as `pbkdf2$iterations$salt$hash`.
- Sessions live in `user_sessions` with a thirty-day sliding expiry in an
  HttpOnly, SameSite=Strict cookie; only the SHA-256 hash of the token is kept.
- New accounts can submit a poll after `user_poll_delay_minutes` and comment after
  `user_comment_delay_minutes`, so brand-new accounts cannot post immediately.
- Repeated failed sign-ins lock the account after `login_max_failed_attempts` for
  `login_lock_minutes` minutes.
- Sign-up and sign-in are rate limited per anonymized network bucket, and one
  bucket may register `max_accounts_per_ip` accounts. The bucket is a 32-bit
  integer (`ip_prefix`): a dotted IPv4 address is reduced to its `/24` network and
  an IPv6 address to its `/64` prefix; anything else is folded with a hash, so no
  full IP address is stored.
- Each account receives one single-use recovery code at sign-up, shown once;
  only its SHA-256 hash is stored. It resets a forgotten password from `/reset`,
  rotating as it is consumed, clearing the failed-attempt lock, and signing out
  every session. A fresh code can be generated from `/account`.
- Signing in on a new device keeps other devices signed in; "Sign out of all
  devices" on `/account` ends them all, and password recovery signs out
  everywhere.
- Submitting a poll and posting a comment both require an account; new polls stay
  pending until an admin approves them unless `auto_approve_polls` is enabled.
- Every poll and comment stores one fixed author mark for the account that wrote it,
  so "my polls" and "my comments" are plain paginated queries and the browser
  remembers nothing. Poll submission and comments no longer need the server key;
  voting, reports, view counting, registration, sign-in, and recovery still do.

Endpoints: `/api/auth` (session state, register, login, logout, recovery) and
`/api/user` (`GET /api/user/polls?page=`, `GET /api/user/comments?page=`,
`POST /api/user/polls/:id/close`, `DELETE /api/user/polls/:id`,
`DELETE /api/user/comments/:id`, and `GET`/`POST /api/user/recovery-code`).

Both list endpoints return one page of the account's own content, newest first, as
`{ polls/comment, page, hasMore }` with a page size of 20 and one extra row read to
detect the next page. A `page` that is not a positive integer answers
`400 INVALID_PAGE`. They share one per-account quota (60 requests per hour, a fixed
internal limit rather than a setting). Ownership is proved by the stored author
mark, so another account's row is answered as `404`.

## Account keys

Each public account has a random 32-byte author key, generated at registration. The
server never stores it in clear: it is stored only wrapped with AES-256-GCM.

| Column | Value |
| --- | --- |
| `users.password_hash` | `pbkdf2w$<iter>$<salt>$<verifier>` |
| `users.author_key_pw` | `wrapHex(wrapKeyHex from password, authorKeyHex)` |
| `users.recovery_code_hash` | `sha256Hex(normalizedCode)` |
| `users.author_key_rc` | `wrapHex(recoveryWrapKeyHex, authorKeyHex)` |
| `user_sessions.author_key` | `wrapHex(sessionWrapKeyHex, authorKeyHex)` |
| `polls.author_mark`, `comments.author_mark` | `authorMark(authorKeyHex)` |

The three wrap keys are:

- `recoveryWrapKeyHex = hmacSha256Hex(normalizeRecoveryCode(code), "recovery-wrap")`
- `sessionWrapKeyHex = hmacSha256Hex(token, "session-wrap")`
- the password wrap key, `deriveKey(M, "wrap")`, where
  `M = PBKDF2-HMAC-SHA256(password, salt, iterations)` is derived inside the
  `PasswordHasher` Durable Object and never leaves it.

`authorMark(authorKeyHex) = hmacSha256Hex(fromHex(authorKeyHex), "author")`, and
`deriveKey(masterHex, purpose) = hmacSha256Hex(fromHex(masterHex), purpose)`. Because
the author key is recoverable only from the password or the recovery code, a database
copy, even together with the server secret, cannot link a poll or comment to an
account. All rows of one account share one author mark, so a database reader can tell
that a set of rows came from the same anonymous author.

## Snapshot chain

The hourly snapshot chain is the tamper-evident record of published results.
There is a single canonical payload, `schemaVersion: 3`. Each record's hash
covers the poll id, the hour, the number of ballots, the per-option counts, the
cumulative view total, and the previous record's hash, so rewriting any published
count is detectable. `optionCounts` carries the per-position counts as JSON in
`stats_snapshots.option_counts`, `ballots` is the ballot count at that hour, and
`views` is the cumulative view total. `makeSnapshot`, `verifySnapshotHash`,
`/api/snapshots/:id`, the `/api/snapshots/:id/verify` walk, and the publisher all
use this one format.

## Audit publishing

The hourly maintenance run copies the signed chain to a public GitHub data
repository, so the published counts are copied outside the operator's database.
Configure it in the admin Settings tab under **Public audit repository**:

- `publish_enable` (default `false`) turns the publisher on.
- `publish_repository` is the data repository in `owner/name` form.
- `publish_branch` (default `main`) and `publish_path` (default `snapshots`)
  select where files are written.
- `github_token` is a fine-grained personal access token limited to that one
  repository with **Contents: Read and write** only. It is stored as a secret
  `settings` row, masked in the admin API and dashboard, and never returned
  publicly or written to the audit log.

The publisher runs after the snapshots are written: it lists every open poll and
every poll closed in the last 35 days, reads the snapshot rows newer than the
last published hour for each, re-reads the closing hour while the stored last row
is not final, and merges the rows into the existing poll file by hour. One commit
per run is created through the Git Data API as `chinapoll-bot`. The
`publish_state` table stores the per-poll cursor, and the last 50 runs are kept in
`publish_runs`. `/api/health` reports `lastPublishAt` and `publishError`, and the
admin Overview lists the last five runs. See [RUNBOOK.md](RUNBOOK.md) for the
token and what to do when `publishError` is true.

## Reports and view counts

Visitors can report a poll without an account from the three-dot menu at the top
right of the poll title, and a comment from the three-dot menu in its own row.
`POST /api/polls/:id/report` accepts
`{ "reason": "<label>", "note"?: "<text>" }`. The reason labels are `spam`,
`inappropriate`, `misleading`, `copyright`, `personal_info`, `harassment`,
`illegal`, and `other`; a note is accepted only with `other` and is limited to
300 characters. The endpoint is rate limited with `report_rate_limit` (default
`3/d`) using the keyed, daily-rotated network hash, and it stores no reporter
identifier, address, network bucket, or exact timestamp (the creation time is
coarsened to the hour). Both report endpoints require a same-origin request, so a
third-party page cannot file reports from its visitors' browsers.

`POST /api/comments/:publicId/report` accepts the same body for one comment, named by
the random public id the comment list returns. It shares the rate-limit budget with
poll reports and stores the same fields minus the poll column: the comment already
carries it, and the row cascades away with the comment. A comment report never changes
a poll's status and never hides the comment; it is reviewed by hand, because hiding a
comment once a report count is reached would be cheap to abuse from one network, and
an admin has a direct delete for a comment. The admin Reports tab lists the two kinds
in separate tables, and resolving either writes an audit entry.

`personal_info`, `harassment`, and `illegal` are high priority. After each report
the open counts are checked against `report_auto_hide_threshold` (default 5) and
`report_auto_hide_priority_threshold` (default 2); when either is reached the poll
is set back to pending with `reviewed_at` cleared so it leaves public listings
until an admin reviews it, and a `poll.auto_hidden` audit entry is written.
Setting a threshold to `0` disables that rule.

`POST /api/polls/:id/view` increments one per-poll, per-UTC-day counter
(`poll_views`); the browser calls it once per tab session. It is a single call to
the poll's `ViewCounter` Durable Object, which enforces the `60/h` per-network
limit in its own memory and buffers the count, flushing to D1 on a five-minute
alarm, so an active poll costs at most twelve writes an hour instead of one per
view; an object evicted between flushes loses up to five minutes of views (counts
are approximate by design). A same-origin request is required, and a well-formed
one always answers `204` so the response reveals nothing. `GET /api/polls/:id` and
the poll list report
`views: { total, last7Days } | null`. A poll's own page always answers with its
total (zero for a poll with no views yet), while the list answers `null` below
`min_views_to_display` (default 20). Cumulative views are included in the signed
hourly snapshot chain.

Retention: resolved reports are deleted 90 days after `resolved_at`, and view
rows older than 90 days are rolled up into a single per-poll row so long-term
totals survive while daily resolution is dropped. Both are removed with the poll
by the foreign-key cascade.

## AI assistance

Optional AI assistance is configured with `ai_provider`. It powers the Worker's
own review and topic classification of a submission; the public submit form
renders no AI control, so nothing on the site calls the AI endpoints below.

| Provider | Behaviour |
| --- | --- |
| `off` | AI endpoints answer `404`. This is the default. |
| `cloudflare` | Calls Cloudflare Workers AI through the `AI` binding (`[ai] binding = "AI"` in `wrangler.toml`, repeated under `[env.production]`). |
| `openai_compatible` | Calls `<ai_api_url>/chat/completions` with the shared `ai_model`. If the URL already ends in `/chat/completions`, it is used as-is. `ai_api_key`, when set, is sent as `Authorization: Bearer <key>`. |

One `ai_model` is used for every AI feature and both providers. Set it to a
Workers AI model name for `cloudflare`, or to a model supported by the
OpenAI-compatible endpoint.

| Setting | Default | Public? |
| --- | --- | --- |
| `ai_provider` | `off` (`off`, `cloudflare`, `openai_compatible`) | no |
| `ai_api_url` | empty (HTTPS URL) | no |
| `ai_api_key` | empty | no |
| `ai_model` | `@cf/qwen/qwen3-30b-a3b-fp8` | no |
| `ai_rate_limit` | `10/h` | no |
| `ai_review_prompt` | empty (up to 4000 characters) | no |
| derived `ai_enable` | `false` | yes |

An existing installation that stored `ai_enable = true` before the provider
setting existed keeps using Workers AI until an `ai_provider` row is written.

Both endpoints require a signed-in account, pass the same account-age gate as
proposals, enforce the Origin check, verify Turnstile when it is enabled, and are
rate limited per account with scope `ai` and key `user:<id>`:

- `POST /api/ai/enhance-title` with `{ title, description?, locale }` returns
  `{ suggestions: string[] }` (up to 3 alternatives, each at most 200 characters).
- `POST /api/ai/suggest-options` with
  `{ title, description?, pollType, count?, locale }` returns
  `{ options: string[] }` (2 to 7 options, each at most 80 characters).

The title must be 10 to 200 characters after trimming and the description at most
2000; anything else is rejected with `400`. Workers AI is asked for structured
JSON through a JSON schema; the OpenAI-compatible provider uses JSON object mode.
Either answer passes a strict parser (array type, item count, string type, trimmed
length, no markdown, no duplicates). A malformed answer is `502`; a provider that
does not answer within 15 seconds is `504`. The prompt and the response are never
logged and never written to D1.

## API errors and translations

Every application-controlled error from the public Worker carries a stable code
next to the English text it always returned:

```json
{
  "error": { "code": "USERNAME_TAKEN", "params": {} },
  "message": "username is already taken"
}
```

- Codes and their canonical English text live in `shared/errors.ts`
  (`ERROR_MESSAGES`); the Worker builds responses with
  `apiError(code, status, { params, extra })` from `shared/http.ts`. `message` is
  kept for backward compatibility, and `params` carries the values of a templated
  message (for example `{ "hours": 48 }` for an account-age gate).
- The front end never shows the backend text. `src/lib/apiError.ts` parses the
  response, translates the code with the i18n dictionary (`errors.<CODE>`) and
  interpolates the params; `getErrorMessage` in `src/ui.ts` is the single entry
  point every form, toast, and dialog calls.
- Older shapes (`{ "detail": { "code": ... } }`, `{ "detail": "text" }`,
  `{ "message": "text" }`, a bare string, a validation array) are still accepted.
  Anything that cannot be identified reliably becomes one localized generic
  message instead of leaking internal text.
- `tests/apiError.test.ts` checks the parsing, the per-locale output, the
  interpolation, the legacy fallbacks, and that every code has a translation in
  all three dictionaries.

## Server-rendered documents and the bootstrap island

The public Worker answers every HTML route itself: it fills `#app` with crawlable
markup (`worker/services/ssr.ts`) and injects the route's `<head>` metadata
(`worker/services/seo.ts`), so the first response already carries the headings, poll
titles, and copy.

The client bundle re-renders that container, so the data it needs travels with the
document instead of being fetched again. `worker/services/bootstrap.ts` serializes
the settings, the locale dictionary, and (on a poll page) the poll detail, its
results, and the requested comment page into an inert
`<script type="application/json" id="bootstrap">` element:

- The settings are exactly the body of `GET /api/settings/public`
  (`publicSettingsPayload` in `worker/api/settings.ts`), so no Worker binding and no
  server secret can reach the document in place of the private setting rows that
  are stripped. `tests/bootstrap.test.ts` locks the key set.
- `src/bootstrap.ts` reads the island; `src/config.ts`, `src/i18n.ts`, and
  `src/pages/poll.ts` consume it, validating it like an API response and falling
  back to the request when it is missing or describes another view (a client-side
  route change, or a comment page other than the one embedded).
- The anonymous vote status is deliberately absent: it is derived from the
  browser's own vote token, which the server never sees while rendering, so
  `POST /api/vote/status` stays a client call.
- `serializeJsonScript` (`worker/services/html.ts`) escapes every `<` so a poll
  title or translation cannot close the element, and the element is never
  executed, so the strict `script-src 'self'` policy holds without
  `'unsafe-inline'`.

## Caching

The public Worker answers every request, so it decides what a browser may store:

- HTML documents, `/api/*` responses, and any error are sent with
  `Cache-Control: no-store` (`isPrivateResponse` in `worker/index.ts`): a document
  carries the viewer's settings and bootstrap island, and API answers are per
  viewer, so neither may be reused.
- Static assets keep the headers of the asset layer, and `public/_headers`
  overrides them for the folders that are safe to cache. Vite copies that file
  into `dist/web`. `/assets/*` is the fingerprinted bundle
  (`public, max-age=31556952, immutable`), so a repeat visit reuses it instead of
  downloading it again. The `/i18n/*` dictionaries are deliberately not listed:
  a Worker-rendered document embeds the default locale's dictionary in the
  bootstrap island, so the file is fetched only as a fallback, and the asset layer
  default (revalidate) then beats a cache that a deploy has already replaced.
  Without the Worker passing these headers through, every response was wrapped in
  `no-store` and a repeat visit downloaded the whole bundle again.
- An uploaded branding image is served from `/image/<key>.<ext>?v=<updated_at>`
  with its own immutable cache header (`worker/api/branding.ts`), so replacing the
  image produces a new URL.
- `tests/integration/cacheHeaders.test.ts` keeps the document, the API, an error,
  the bundle, and the dictionaries pinned to those headers.

## Privacy and cryptography

- Vote and comment timestamps are coarsened to the hour, network buckets are
  stored only as keyed daily-rotated hashes, and account deletion is self-service
  from `/account` (content is kept but carries no account link).
- Two deliberate trade-offs are documented in [THREAT_MODEL.md](THREAT_MODEL.md):
  the account-cap hash is linkable within a calendar month, and the browser vote
  token rotates every 30 days (which lets a returning browser vote again on an
  evergreen poll).
- Every password hash is produced and checked by the `PasswordHasher` Durable
  Object, which runs the CPU-heavy PBKDF2 derivation with its own CPU budget so
  the request Worker only pays for the round trip; the raw primitives in
  `shared/password.ts` are never called directly. Hashing is sharded across 16
  instances by a hash of the username. The 100,000-iteration count is the maximum
  Cloudflare's production WebCrypto accepts for PBKDF2 (a higher count throws
  `NotSupportedError`), so keep `PBKDF2_ITERATIONS` at or below that ceiling.
- All Durable Object classes are SQLite-backed (`new_sqlite_classes`): the public
  Worker declares `RateLimiter`, `PasswordHasher`, and `ViewCounter`; the admin
  Worker declares `RateLimiter` and `PasswordHasher`.
