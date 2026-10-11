\# ChinaPoll improvement checklist



Reviewed against commit `413623c` ("Add user accounts, a Worker-served admin

dashboard, and recovery codes"). Each item names the files to change, the

problem as it exists in the current code, and the concrete change to make.

Items are written so they can be handed to an AI coding assistant one at a

time. Work through sections in order: Anonymity, Security, Architecture,

Product.



Conventions used below:



\- "Public Worker" is `worker/`, "Admin Worker" is `admin/`, "frontend" is `src/`.

\- New schema changes go in a new file under `migrations/`, numbered from `0008`, schema only, no data.

\- New secrets go in `.dev.vars` locally and `wrangler secret put <NAME>` in production.

\- All comments, docs, and commit messages stay in English.



\## What changed in `413623c` and how it affects this list



\- Public user accounts were added (`users`, `user\_sessions`, `auth\_attempts`). Submitting a poll or a comment now requires a signed-in account, and both rows store `user\_id`.

\- The email identity flow, `identities` table, `poller\_id`, `/api/proposal/claim`, and `SERVER\_SECRET` were removed. The former items about email identities and the claim oracle are resolved.

\- IPv6 handling was fixed with `ipBucket()` in `worker/services/ip.ts` for comments, proposals, and auth. The vote handler still uses the old string split.

\- A shared `parseRateLimit()` exists in `worker/services/rateLimit.ts` but only `auth.ts` uses it. The three older copies remain.

\- The `/24` bucket is now stored as an integer in `polls.ip\_prefix`, `comments.ip\_prefix`, `users.ip\_prefix`, and `auth\_attempts.ip\_prefix`. An integer is not anonymized: it converts back to the network with one arithmetic step.

\- The admin dashboard exposes each user's `ip\_prefix` as `networkBucket` in `admin/api/users.ts`.

\- Accounts make the anonymity situation worse, not better. Every poll and comment a person writes is now permanently joined to one account row, and that row carries the network they registered from.



\---



\## 1. Anonymity



\### 1.1 Decide what accounts are for, then minimize what they link



\- Files: `README.md`, `docs/THREAT\_MODEL.md`, `worker/api/comments.ts`, `worker/api/proposal.ts`

\- Problem: the hero still says "Fully anonymous" while comments and polls now require an account, and `comments.user\_id` plus `polls.user\_id` join every contribution to one identity forever. The stated reason for accounts is spam control and a waiting period, neither of which needs a durable link to content.

\- Change, choose one:

&#x20; - Option A, keep accounts for gating only: after the account-age check passes, insert the comment or poll with `user\_id = NULL`. Self-service listing and deletion in `worker/api/user.ts` then cannot work, so remove those endpoints and the account page sections that use them, or keep deletion by returning a per-item random secret at creation time, stored hashed in a `delete\_token\_hash` column.

&#x20; - Option B, keep ownership but make it unlinkable at rest: store `owner\_hash = HMAC(server\_secret, user\_id || poll\_id)` instead of `user\_id`. Listing "my polls" requires recomputing the HMAC per candidate row, so limit it to the last 100 polls. A database leak without the secret reveals nothing.

&#x20; - Either way, update the hero text and the About page to describe exactly what is linked.



\### 1.2 Stop storing the network bucket on the account row



\- Files: `worker/api/auth.ts`, `migrations/0008\_users\_drop\_ip\_prefix.sql`, `admin/api/users.ts`, `admin/dashboard/script/pages/users.ts`

\- Problem: `register()` writes `ip\_prefix` into `users` and it is never deleted. It exists only for the `max\_accounts\_per\_ip` cap. Admins can read it as `networkBucket`.

\- Change:

&#x20; 1. Enforce the cap with a hashed, time-bounded counter instead. Insert `(ip\_hash, kind = 'account', created\_at)` into `auth\_attempts` on successful registration and count rows younger than 30 days. Reuse the daily-keyed HMAC from item 1.4.

&#x20; 2. Migration `0008`: `DROP INDEX IF EXISTS idx\_users\_ip\_prefix; ALTER TABLE users DROP COLUMN ip\_prefix;`

&#x20; 3. Remove `u.ip\_prefix` from the `SELECT` in `admin/api/users.ts` and the `networkBucket` field from the response and dashboard table.



\### 1.3 Stop storing raw network buckets in `polls`, `comments`, and `auth\_attempts`



\- Files: `worker/api/comments.ts`, `worker/api/proposal.ts`, `worker/api/auth.ts`, `migrations/0008\_users\_drop\_ip\_prefix.sql` (same migration as 1.2)

\- Problem: `ipBucket()` returns the `/24` as a 32-bit integer and the insert statements write it to `polls.ip\_prefix` and `comments.ip\_prefix` for the life of the row. Since contributions now carry `user\_id`, the prefix adds nothing to rate limiting that the account does not already provide.

\- Change:

&#x20; 1. Rate limit comments and proposals per `user\_id` instead of per network. Replace `WHERE ip\_prefix = ? AND ts\_bucket = ?` with `WHERE user\_id = ? AND ts\_bucket = ?` and keep `ts\_bucket` only if item 1.6 is not adopted.

&#x20; 2. Remove `ip\_prefix` from both inserts.

&#x20; 3. In the same migration:

&#x20;    ```sql

&#x20;    DROP INDEX IF EXISTS idx\_comments\_rate\_limit;

&#x20;    DROP INDEX IF EXISTS idx\_polls\_rate\_limit;

&#x20;    ALTER TABLE comments DROP COLUMN ip\_prefix;

&#x20;    ALTER TABLE polls DROP COLUMN ip\_prefix;

&#x20;    ```

&#x20; 4. For `auth\_attempts`, which has no account to key on, replace the integer with the keyed hash from item 1.4 and shorten `ATTEMPT\_RETENTION\_SECONDS` in `auth.ts` from seven days to the largest configured window plus one hour.

\- Done when: `grep -rn "ip\_prefix" worker/ admin/` returns only `auth\_attempts` references.



\### 1.4 Replace the hardcoded vote salt with a daily-rotated keyed hash



\- Files: `worker/api/vote.ts`, `worker/services/ip.ts`, `worker/index.ts`, `.dev.vars`, `README.md`

\- Problem: `const VOTE\_SALT = 'chinapoll-local-dev-salt'` at `worker/api/vote.ts:14` is public. There are only about 16 million `/24` prefixes, so `votes.ip\_prefix\_hash` is reversible with a lookup table. The vote handler also still uses `remoteIp.split('.')`, so IPv6 voters get their full address hashed.

\- Change:

&#x20; 1. Add `IP\_HASH\_KEY?: string` to `Env` in `worker/index.ts`. Document `wrangler secret put IP\_HASH\_KEY` and add a 64-hex value to `.dev.vars`.

&#x20; 2. Add `hashedNetworkBucket(address, keyHex, date = today)` to `worker/services/ip.ts`: compute `ipBucket(address)`, derive a day key as `HMAC(keyHex, 'YYYY-MM-DD')`, and return `HMAC(dayKey, bucket)` as hex. Move `toHex` and `fromHex` into a shared `worker/services/crypto.ts` so `password.ts`, `session.ts`, and `admin/lib/crypto.ts` share one copy.

&#x20; 3. In `vote.ts`, delete `VOTE\_SALT` and the string split, and call `hashedNetworkBucket`. Return 503 `ip hash key is not configured` when the key is missing or malformed.

&#x20; 4. Use the same helper in `auth.ts` for `auth\_attempts`.

\- Done when: no file contains `VOTE\_SALT` or `split('.')`.



\### 1.5 Move rate limiting out of D1 into a Durable Object



\- Files: new `worker/services/rateLimiter.ts`, `wrangler.toml`, `worker/index.ts`, `vote.ts`, `comments.ts`, `proposal.ts`, `auth.ts`

\- Problem: every limiter does `SELECT COUNT(\*)` then `INSERT`, which is not atomic, and the rows that make it work are the ones that leak origin data.

\- Change:

&#x20; 1. Create a Durable Object class `RateLimiter` with an in-memory `Map<string, { count: number; resetAt: number }>`. Do not use `this.state.storage`. Expose a `fetch` handler accepting `{ key, limit, windowMs }` and returning `{ allowed, remaining }`. Set an alarm to evict expired keys.

&#x20; 2. In `wrangler.toml` add:

&#x20;    ```toml

&#x20;    \[durable\_objects]

&#x20;    bindings = \[{ name = "RATE\_LIMITER", class\_name = "RateLimiter" }]



&#x20;    \[\[migrations]]

&#x20;    tag = "v1"

&#x20;    new\_classes = \["RateLimiter"]

&#x20;    ```

&#x20;    Note that `\[\[migrations]]` here is the Durable Object migration list and is unrelated to the D1 `migrations\_table` setting already present.

&#x20; 3. Add `RATE\_LIMITER: DurableObjectNamespace` to `Env`.

&#x20; 4. Add `checkRateLimit(env, scope, key, limitSetting, fallback)` to `worker/services/rateLimit.ts` that parses the setting with the existing `parseRateLimit` and calls the Durable Object with id `env.RATE\_LIMITER.idFromName(scope)`.

&#x20; 5. Call it from all four handlers. Keys: votes use the hashed network bucket from item 1.4, comments and proposals use `user:<id>`, register and login use the hashed network bucket.

&#x20; 6. Delete `auth\_attempts` and `votes.ip\_prefix\_hash`, `votes.ts\_bucket`, `comments.ts\_bucket`, `polls.ts\_bucket` in a migration once the Durable Object is live.

\- Done when: no handler writes any IP-derived value to D1.



\### 1.6 Coarsen timestamps on votes and comments



\- Files: `worker/api/vote.ts`, `worker/api/comments.ts`

\- Problem: `created\_at DEFAULT (unixepoch())` records the exact second, which correlates with edge logs and with `users.last\_login\_at`.

\- Change: pass `created\_at` explicitly in both inserts as `Math.floor(Date.now() / 1000 / 3600) \* 3600`. Also stop updating `users.last\_login\_at` on every login, or round it to the day.



\### 1.7 Replace sequential comment IDs with random public IDs



\- Files: `migrations/0009\_comment\_public\_id.sql`, `worker/api/comments.ts`, `worker/api/user.ts`, `admin/api/comments.ts`, `src/lib/poll.ts`

\- Problem: autoincrement `comments.id` reveals insertion order across the whole site.

\- Change:

&#x20; 1. Migration: `ALTER TABLE comments ADD COLUMN public\_id TEXT; CREATE UNIQUE INDEX idx\_comments\_public\_id ON comments(public\_id);`

&#x20; 2. On insert, set `public\_id` to 8 random bytes in hex.

&#x20; 3. Public and user APIs return `public\_id` as `id`. The admin API may keep the integer.

&#x20; 4. Order public lists by `created\_at DESC, public\_id` so order within an hour is not insertion order.



\### 1.8 Derive per-poll vote tokens on the client



\- Files: `src/pages/poll.ts`, `src/lib/poll.ts`

\- Problem: `createToken()` stores one UUID in `localStorage` and `hashToken(token)` is sent unchanged for every poll, so all votes from one browser share one hash in `votes.voter\_token\_hash`.

\- Change: in `src/pages/poll.ts` replace `hashToken(token)` with `hashToken(`${token}:${pollId}`)`. Add a comment explaining that the server only ever sees a per-poll value.



\### 1.9 Validate the token hash format on the server



\- Files: `worker/api/vote.ts`

\- Problem: `const tokenHash = String(body.tokenHash ?? '')` accepts any string.

\- Change: reject unless `/^\[0-9a-f]{64}$/i.test(tokenHash)`, exactly as `handleVoteStatusRequest` already does.



\### 1.10 Rotate the base browser token



\- Files: `src/lib/poll.ts`

\- Change: store the token together with a creation timestamp as JSON. If older than 30 days, generate a new one.



\### 1.11 Hide counts below a minimum vote threshold



\- Files: `worker/api/settings.ts`, `worker/index.ts`, `worker/api/polls.ts`, `worker/api/stats.ts`, `worker/api/vote.ts`, `admin/lib/settings.ts`, `src/pages/poll.ts`, `src/pages/home.ts`

\- Change:

&#x20; 1. Add setting `min\_votes\_to\_display` (integer 0 to 1000, default 10) to `DEFAULT\_PUBLIC\_SETTINGS` in `worker/api/settings.ts`, the duplicate in `worker/index.ts` (until item 3.5 removes it), and the admin validator.

&#x20; 2. Where `counts` is returned, if the total is below the threshold return `counts: null, hidden: true, threshold: <n>`.

&#x20; 3. Frontend renders "Results appear after N votes" when `hidden` is true.



\### 1.12 Keep usernames off public pages



\- Files: `worker/api/proposal.ts`, `worker/api/comments.ts`, `worker/api/polls.ts`

\- Problem: `handleProposalRequest` returns `submitter: auth.user.username`. Public comment and poll listings do not currently include usernames. Keep it that way.

\- Change: remove `submitter` from the proposal response. Add a test asserting that no public JSON response contains a `username` or `submitter` key.



\### 1.13 Make account deletion real



\- Files: `worker/api/user.ts`, `admin/api/users.ts`

\- Problem: the admin "delete user" keeps the user's polls and comments and only detaches them. There is no self-service deletion at all.

\- Change: add `DELETE /api/user/account` requiring the current password. It deletes sessions, nulls `user\_id` on polls and comments, and deletes the `users` row. Document in the privacy page that content remains but is detached.



\### 1.14 Serve everything from one origin with no third parties



\- Files: `index.html`, `src/`, `admin/dashboard/`, `vite.config.ts`

\- Change: audit the built output for external URLs (`grep -r "https://" dist/`). Fonts must be self-hosted or system. Add a CI step that fails if the build references any host other than `challenges.cloudflare.com`.



\### 1.15 Add privacy headers to every public Worker response



\- Files: `worker/index.ts`

\- Change: wrap the final response in `withSecurityHeaders(response)` that sets:

&#x20; ```

&#x20; cache-control: no-store

&#x20; referrer-policy: no-referrer

&#x20; x-content-type-options: nosniff

&#x20; x-frame-options: DENY

&#x20; strict-transport-security: max-age=31536000; includeSubDomains

&#x20; ```

&#x20; Add the CSP from the admin Worker to HTML responses once static assets are served by the Worker (item 3.11).



\### 1.16 Tor compatibility and onion mirror



\- Files: Cloudflare dashboard, `README.md`

\- Change: enable Onion Routing on the zone, lower the security level so Tor exits are not challenged, and document a manual test in Tor Browser at the Safest level.



\### 1.17 JavaScript-free read path



\- Files: `worker/index.ts`, new `worker/pages/`

\- Change: add server-rendered HTML routes `/read` and `/read/poll/:id` using the same escaping rules as `src/ui.ts`. Link them from the footer as "Text-only version".



\### 1.18 Disable Cloudflare-side logging



\- Files: Cloudflare dashboard, `docs/THREAT\_MODEL.md`

\- Change: turn off Logpush, Web Analytics beacon, and Bot Analytics. Enable "Remove visitor IP headers" in Managed Transforms. Record each setting and date in the threat model.



\### 1.19 Separate duties between Workers



\- Files: `wrangler.toml`, `admin/wrangler.toml`

\- Change: the public Worker gets only `DB`, `RATE\_LIMITER`, `IP\_HASH\_KEY`. The admin Worker gets `DB` and `TURNSTILE\_SITE\_KEY`. Long term, move `admin\_users`, `admin\_sessions`, and `admin\_audit\_log` to a second D1 database bound only to the admin Worker.



\### 1.20 Enforce in SQL that admin views never return origin data



\- Files: `admin/api/users.ts`, `admin/api/polls.ts`, `admin/api/comments.ts`

\- Change: after items 1.2 and 1.3 the columns no longer exist. Add a test that admin JSON contains no key matching `/ip|prefix|bucket|network/`.



\### 1.21 Write and publish a threat model and data map



\- Files: new `docs/THREAT\_MODEL.md`, `docs/DATA\_MAP.md`

\- Change: list every table and column, who can read it (public, user, admin, super admin, Cloudflare), retention, and what a breach or legal request would reveal. Include the new `users`, `user\_sessions`, and `auth\_attempts` tables. Link both from the About page.



\### 1.22 Ship the signed snapshot chain



\- Files: `worker/services/snapshot.ts`, `worker/services/hashchain.ts`, `migrations/0010\_stats\_snapshots.sql`, `wrangler.toml`, `worker/index.ts`, new `worker/api/snapshots.ts`

\- Problem: both services are unused and `makeSnapshot` returns `prevHash` instead of a new hash. Unchanged since the last review.

\- Change:

&#x20; 1. Migration:

&#x20;    ```sql

&#x20;    CREATE TABLE IF NOT EXISTS stats\_snapshots (

&#x20;      id INTEGER PRIMARY KEY AUTOINCREMENT,

&#x20;      poll\_id INTEGER NOT NULL,

&#x20;      ts\_hour INTEGER NOT NULL,

&#x20;      approve INTEGER NOT NULL,

&#x20;      oppose INTEGER NOT NULL,

&#x20;      neutral INTEGER NOT NULL,

&#x20;      prev\_hash TEXT NOT NULL,

&#x20;      hash TEXT NOT NULL,

&#x20;      UNIQUE(poll\_id, ts\_hour)

&#x20;    );

&#x20;    ```

&#x20; 2. Fix `makeSnapshot` to compute `hash = sha256(prevHash + ':' + canonicalJson)` and return both. Delete `hashString` and `hashPayload`.

&#x20; 3. Add `\[triggers] crons = \["0 \* \* \* \*"]` to `wrangler.toml` and a `scheduled()` export in `worker/index.ts` that writes one row per open poll.

&#x20; 4. Add `GET /api/snapshots/:pollId` and `GET /api/snapshots/:pollId/verify`.

&#x20; 5. Publish from a GitHub Actions job that fetches the endpoint hourly and commits JSON to the data repository.



\### 1.23 Automate purges and publish the finalized row count



\- Files: `worker/index.ts` scheduled handler, `scripts/finalize.sh`

\- Change: when a poll reaches `Closed`, write a final snapshot including `finalized\_rows`. Thirty days later delete that poll's vote rows. Delete expired `user\_sessions` and old `auth\_attempts` in the same job.



\### 1.24 Publish deployment configuration and a build hash



\- Files: `worker/index.ts`, `vite.config.ts`

\- Change: inject `\_\_BUILD\_SHA\_\_` with Vite `define` from `process.env.GITHUB\_SHA` and return it from `/api/health`.



\---



\## 2. Security



\### 2.1 Verify Turnstile server-side in the public Worker



\- Files: move `admin/services/turnstile.ts` to `worker/services/turnstile.ts`, `worker/api/vote.ts`, `worker/api/auth.ts`

\- Problem: `vote.ts` only checks that `turnstileToken` is non-empty. Register and login have no bot check, which matters more now that accounts gate comments and proposals.

\- Change:

&#x20; 1. Move `verifyTurnstile` to the public Worker and import it from the admin Worker. Do not send the `remoteip` field.

&#x20; 2. When `env.turnstile\_enable \&\& env.turnstile\_secret\_key`, require and verify the token in `vote`, `register`, and `login`. Return 403 `turnstile verification failed` on failure.

&#x20; 3. Add `turnstile\_site\_key` as a public setting and render the widget on the vote buttons and the auth forms.



\### 2.2 Check poll state before accepting votes and comments



\- Files: `worker/api/vote.ts`, `worker/api/comments.ts`

\- Problem: neither handler checks that the poll exists, is open, or is inside its deadline window.

\- Change: before rate limiting, run `SELECT status, mode, start\_at, end\_at FROM polls WHERE id = ?`. Return 404 if missing, 409 `poll is not open` unless `status = PollStatus.Open` and, for `PollMode.Deadline`, `start\_at <= now <= end\_at`.



\### 2.3 Make rate-limit checks atomic



\- Covered by item 1.5.



\### 2.4 Validate the poll ID on the stats endpoint



\- Files: `worker/api/stats.ts`

\- Change: copy the `/^\[1-9]\\d\*$/` check and `Number.isSafeInteger` guard from `getPoll` in `polls.ts`. Return 400 on failure.



\### 2.5 Generic login responses for both public users and admins



\- Files: `worker/api/auth.ts`, `admin/api/session.ts`

\- Problem: both `login()` functions return distinct messages for unknown user (401), disabled (403), and locked (423), which confirms that a username exists. The public `register()` also confirms existence with `username is already taken`, which is unavoidable, so the login side must not add a second oracle.

\- Change: return `{ message: 'invalid username or password' }` with status 401 for all three cases in both files. Keep the lockout logic and audit entries. Drop `remainingAttempts` and `retryAfter` from responses.



\### 2.6 Rate limit admin login and setup without storing addresses



\- Files: `admin/api/session.ts`, `admin/wrangler.toml`

\- Change: bind the `RateLimiter` Durable Object from item 1.5 to the admin Worker. Key login by `global:login` with limit `30/m` and by `user:<username>` with limit `10/m`. Key setup by `global:setup` with limit `3/m`.



\### 2.7 Raise PBKDF2 iterations and rehash on login



\- Files: `worker/services/password.ts`, `admin/lib/password.ts`, `worker/api/auth.ts`, `admin/api/session.ts`

\- Change: set `PBKDF2\_ITERATIONS = 600\_000` in both files. After a successful `verifyPassword`, if the stored iteration count is lower, rehash and update `password\_hash`. Deduplicate the two password modules into one shared file.



\### 2.8 Add CSRF protection to public user mutations



\- Files: `worker/api/user.ts`, `worker/api/auth.ts`, `worker/api/comments.ts`, `worker/api/proposal.ts`

\- Problem: the user session cookie is `SameSite=Lax`, which blocks cross-site POST in modern browsers, but there is no Origin check as there is in the admin Worker. Older browsers and some embedded webviews do not enforce Lax.

\- Change: reuse `enforceSameOrigin` from `admin/auth.ts` by moving it to `worker/services/csrf.ts`. Apply it to every cookie-authenticated non-GET request. Consider changing the cookie to `SameSite=Strict`.



\### 2.9 Raise the public password minimum



\- Files: `worker/services/users.ts`

\- Change: set `USER\_PASSWORD\_MIN\_LENGTH = 12` to match the admin rule, and reject passwords that equal the username.



\### 2.10 Protect recovery code regeneration



\- Files: `worker/api/user.ts`

\- Problem: `POST /api/user/recovery-code` rotates the code with no password confirmation, so a hijacked session can lock the real owner out of recovery.

\- Change: require `currentPassword` in the body and verify it before rotating.



\---



\## 3. Architecture and code quality



\### 3.1 Implement or remove dead hash chain and snapshot code



\- Covered by item 1.22.



\### 3.2 Replace stub scripts with scheduled Workers



\- Files: `scripts/\*.sh`, `worker/index.ts`

\- Change: delete `push-stats.sh` and `finalize.sh` once items 1.22 and 1.23 exist. Replace `failover.sh` with `docs/RUNBOOK.md`.



\### 3.3 Add a test suite



\- Files: `package.json`, new `vitest.config.ts`, new `tests/`

\- Change:

&#x20; 1. `npm i -D vitest @cloudflare/vitest-pool-workers`.

&#x20; 2. Unit tests: `parseRateLimit`, `ipBucket`, `hashedNetworkBucket`, settings validators, `makeSnapshot`, `normalizeRecoveryCode`, `checkAccountAge`.

&#x20; 3. Integration tests with the Workers pool: every public route for success, validation failure, and method-not-allowed; vote on a closed poll; duplicate vote; hidden counts; register, login, lockout, recover, account-age gating.

&#x20; 4. Admin tests: setup, login, CSRF rejection, super admin only audit access, user disable revokes sessions.

&#x20; 5. Add `"test": "vitest run"` to `package.json`.



\### 3.4 Add CI



\- Files: new `.github/workflows/ci.yml`

\- Change: on push and pull request run `npm ci`, `npm run lint`, `npm test`, `npm run build`, `npm run build:worker`, `npm run admin:worker:dry-run`. On tag `v\*`, deploy both Workers using a `CLOUDFLARE\_API\_TOKEN` secret.



\### 3.5 Deduplicate the settings loader



\- Files: `worker/index.ts`, `worker/api/settings.ts`

\- Problem: `getPublicSettings` in `index.ts` and `handlePublicSettingsRequest` in `settings.ts` each carry a full copy of `DEFAULT\_PUBLIC\_SETTINGS` and a switch over every key. The new account settings doubled the size of both copies.

\- Change: export `loadPublicSettings(db)` from `settings.ts` that performs the validated parse once. Delete the copy in `index.ts`. `handlePublicSettingsRequest` reuses the loaded object and strips secrets.



\### 3.6 Finish the rate-limit parser consolidation



\- Files: `worker/api/vote.ts`, `worker/api/comments.ts`, `worker/api/proposal.ts`

\- Problem: `worker/services/rateLimit.ts` exists but the three original handlers still define their own `parseRateLimit` and read the setting from D1 again.

\- Change: delete the local functions and the `get\*RateLimit` queries. Call `parseRateLimit(env.vote\_rate\_limit, '5/h')` and so on using the settings already merged into `env` by `index.ts`.



\### 3.7 Type the handler environment



\- Files: all `worker/api/\*.ts`

\- Change: export `type HandlerEnv = Env \& PublicSettings` from `worker/index.ts` and replace every `env: any` with it. `auth.ts` and `proposal.ts` already define partial interfaces; replace them with the shared type.



\### 3.8 Deduplicate crypto and HTTP helpers



\- Files: `worker/services/password.ts`, `worker/services/session.ts`, `worker/api/auth.ts`, `admin/lib/crypto.ts`, `admin/lib/http.ts`, `admin/lib/password.ts`

\- Problem: `toHex`, `fromHex`, `constantTimeEqual`, `readJsonBody`, `readString`, `noStoreJson`, and the whole PBKDF2 module now exist twice, once per Worker.

\- Change: create `shared/` at the repository root with `crypto.ts`, `http.ts`, `password.ts`, and `cookies.ts`. Import from both Workers. Add `shared/\*\*/\*.ts` to `tsconfig.json` includes.



\### 3.9 Make the HTML `lang` follow the locale



\- Files: `index.html`, `src/main.ts`

\- Change: set `<html lang="en">` statically. Call the existing `document.documentElement.lang` assignment in `start()` immediately after `setDefaultLocale`.



\### 3.10 Remove the magic fallback poll ID



\- Files: `src/main.ts`

\- Change: replace `route.split('/').pop() ?? '11'` with `?? '0'`.



\### 3.11 Serve the SPA from the public Worker



\- Files: `wrangler.toml`, `vite.config.ts`, `tsconfig.json`, `README.md`

\- Change:

&#x20; 1. Add to `wrangler.toml`:

&#x20;    ```toml

&#x20;    \[assets]

&#x20;    directory = "./dist/web"

&#x20;    not\_found\_handling = "single-page-application"

&#x20;    run\_worker\_first = \["/api/\*"]

&#x20;    ```

&#x20; 2. Set Vite `build.outDir` to `dist/web`. Confirm nothing else relies on `tsconfig.json` emitting to `./dist` now that `admin/cli.ts` is gone; if not, set `noEmit: true` and drop `outDir`.

&#x20; 3. Add `\[env.staging]` and `\[env.production]` sections with real `database\_id` values for both Workers.

&#x20; 4. Add a "Production deployment" section to `README.md` stating that the SPA and API share one hostname and the admin Worker uses a separate one.



\### 3.12 Clean up the local workflow after the CLI removal



\- Files: `README.md`, `package.json`

\- Problem: `admin/cli.ts` was deleted and `db:migrate` no longer initializes settings, but the README still refers to CLI commands in places.

\- Change: remove every `npm run admin -- ...` reference and describe the dashboard Settings tab "insert defaults" action instead. Add a `db:reset` script that deletes `.wrangler/state` and reapplies migrations for local testing.



\---



\## 4. Product features



\### 4.1 Automate the poll lifecycle



\- Files: `worker/index.ts` scheduled handler, `admin/api/polls.ts`

\- Change: in the hourly cron, close deadline polls whose `end\_at` has passed, archive closed polls after 30 days, and open approved deadline polls whose `start\_at` has arrived. Record `reviewed\_at` on approval so approval and opening are distinct, which `auto\_approve\_polls` already does for the immediate case.



\### 4.2 Countdown on deadline polls



\- Files: `src/pages/poll.ts`

\- Change: when `mode = 'deadline'`, render the remaining time from `end\_at`, updating every minute.



\### 4.3 Archive browse view



\- Files: `worker/api/polls.ts`, `src/pages/home.ts`, `src/main.ts`

\- Change: accept `status=open|closed|archived|all` and `sort=newest|ending|most\_votes`. Add route `/archive`.



\### 4.4 Canonical and Open Graph metadata



\- Change: emit `<link rel="canonical">` and `og:\*` tags from the server-rendered read path in item 1.17.



\### 4.5 Multiple-choice and ranked modes



\- Files: `migrations/0011\_poll\_options.sql`, `worker/enums.ts`, `worker/api/vote.ts`, `worker/api/polls.ts`, frontend

\- Change: table `poll\_options(id, poll\_id, label, position)` and a `poll\_type` column with values `ternary`, `single\_choice`, `ranked`. Gate creation behind an admin setting `allow\_choice\_polls`.



\### 4.6 Topics and tags



\- Files: `migrations/0012\_topics.sql`, `worker/api/polls.ts`, `worker/api/proposal.ts`, admin, frontend

\- Change: tables `topics(id, slug, name\_en, name\_zh)` and `poll\_topics(poll\_id, topic\_id)`. Proposals submit up to three slugs. List endpoint accepts `topic=<slug>`.



\### 4.7 Search in descriptions



\- Files: `worker/api/polls.ts`

\- Change: extend the `LIKE` clause to `title LIKE ? OR description LIKE ?`.



\### 4.8 Trend charts



\- Files: `src/pages/poll.ts`, `src/pages/home.ts`

\- Change: read `/api/snapshots/:pollId` from item 1.22 and render an inline SVG sparkline per option.



\### 4.9 Sharing



\- Files: new `worker/api/og.ts`, `worker/index.ts`

\- Change: `GET /og/:pollId.svg` renders a card with title and current split. Add a copy-link button. Provide `/embed/:pollId` with `frame-ancestors \*` on that route only.



\### 4.10 Comment reporting and moderation queue



\- Files: `migrations/0013\_comment\_reports.sql`, `worker/api/comments.ts`, `admin/api/comments.ts`, `admin/dashboard/script/pages/comments.ts`

\- Change: table `comment\_reports(id, comment\_id, reason INTEGER, created\_at)` with codes 1 spam, 2 abuse, 3 off topic, 4 other. Public `POST /api/comments/:publicId/report` requires login and is rate limited per user. Admin queue sorts by report count. Add `comments.removed\_at` and `removal\_reason`; the public API returns `removed: true` with no text.



\### 4.11 Submission rules



\- Files: `worker/api/proposal.ts`, `src/pages/content.ts`

\- Change: reject case-insensitive duplicate titles among pending and open polls, require `description.length >= 20`, and add a preview step showing the rules before the final submit.



\### 4.12 Submission status in the account page



\- Files: `worker/api/user.ts`, `src/pages/account.ts`

\- Change: the user poll list already shows status. Add `rejection\_reason` from item 4.13 and a link to the live poll once open.



\### 4.13 Approval and rejection reasons



\- Files: `migrations/0014\_review\_reasons.sql`, `admin/api/polls.ts`, `admin/dashboard/script/pages/polls.ts`

\- Change: add `polls.review\_reason INTEGER` with codes 1 duplicate, 2 unclear, 3 off topic, 4 policy, 5 other. The status endpoint requires a reason when rejecting. Record it in the audit log.



\### 4.14 Transparency reports



\- Files: new `worker/api/transparency.ts`, scheduled handler

\- Change: monthly cron aggregates submissions, approvals, rejections by reason, comments removed by reason, accounts disabled, and polls finalized into `transparency\_reports(month, data\_json)`. Public `GET /api/transparency/:month`, rendered on `/about`.



\### 4.15 Structured error logging



\- Files: `worker/index.ts`, `admin/index.ts`

\- Change: wrap `fetch` in try and catch, log `{ route, status, error }` with `console.error`, and return a generic 500. Never log headers, bodies, cookies, or addresses.



\### 4.16 Health endpoint details



\- Files: `worker/index.ts`

\- Change: `/api/health` returns `{ ok, build, db: 'ok' | 'error', lastSnapshotAt }`.



\### 4.17 Uptime check



\- Change: configure an external monitor against `/api/health`. Document the provider in `docs/RUNBOOK.md`.



\### 4.18 Backups



\- Files: `.github/workflows/backup.yml`, `docs/RUNBOOK.md`

\- Change: daily `wrangler d1 export` encrypted with `age` and uploaded to R2. Document and test restore.



\### 4.19 Failover runbook



\- Files: `docs/RUNBOOK.md`, delete `scripts/failover.sh`

\- Change: steps for deploying both Workers to a second account, restoring the latest backup, and moving DNS.



\### 4.20 Accessibility audit



\- Change: add `@axe-core/playwright` to the test suite and fail on serious violations for the home, poll, submit, login, and account pages.



\### 4.21 Traditional Chinese and editable hero copy



\- Files: `public/i18n/zh-TW.json`, `src/i18n.ts`, `worker/api/settings.ts`, `admin/lib/settings.ts`

\- Change: add `zh-TW` to the locale validator and loader. Replace `hero\_title` and `hero\_subtitle` with per-locale keys.



\### 4.22 Legal pages



\- Files: `src/pages/content.ts`, `public/i18n/\*.json`

\- Change: add `/privacy`, `/terms`, `/contact`. Generate the privacy page from `docs/DATA\_MAP.md`, including what accounts store and how deletion works.



