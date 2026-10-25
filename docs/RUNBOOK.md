# ChinaPoll runbook

Operational procedures for the two Workers that make up ChinaPoll. All commands
are run from the repository root.

## Deployments

1. Apply D1 migrations: `npx wrangler d1 migrations apply chinapoll --env production --remote`.
   `migrations/0001_initial.sql` is the **immutable baseline**: it creates the entire
   schema as of the **2026-10-24** consolidation (earlier consolidations were done
   on 2026-10-18 and 2026-10-11) because nothing had been deployed when it was
   created. Do not edit the
   baseline after it has been applied to a database. Every later schema change gets its
   own numbered migration file (`0002_<summary>.sql`, `0003_<summary>.sql`, ...), and
   wrangler applies those files in filename order. Keep each file to schema changes only.
   The baseline creates the final shape of every table, index, and constraint - the poll
   types and per-poll options, `vote_selections` with `votes` reduced to a ballot row, the
   report and view tables, the ballot/view/option-count columns of the single-format
   snapshot chain, the `publish_state` and `publish_runs` tables, and the
   `polls.author_mark`/`comments.author_mark` columns - so no intermediate rebuild runs on a fresh database. A **fresh**
   database is created by applying the baseline and then every later migration in order;
   `npm run db:reset` does this locally.
   A one-off rename of `categories` to `topics` upgraded the production database that
   predated the baseline. It is already applied and must never be added to `migrations/`:
   the baseline already creates `topics` and `polls.topic_id`, so replaying it fails with
   `no such table: categories` and aborts `wrangler d1 migrations apply` - and with it
   `npm run dev` and `npm run dev:worker`, which apply migrations before starting the Worker.
   That rename intentionally left the legacy `categories` table and `polls.category_id`
   column in place (its cleanup statements were never run), so a production database from
   that lineage may still carry them; fresh and local databases do not.
   `polls.number` is the public poll number, and the baseline creates it, so a fresh
   database needs nothing more. A database created before the **2026-10-24**
   consolidation already recorded `0001_initial.sql`, so the baseline is skipped for
   it and it never gains the column: number its existing polls with one statement
   (a data change, so it is not in a migration file).
   `npx wrangler d1 execute chinapoll --env production --remote --command "WITH ordered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n FROM polls WHERE status IN (1,2,3)) UPDATE polls SET number = (SELECT n FROM ordered WHERE ordered.id = polls.id) WHERE id IN (SELECT id FROM ordered) AND number IS NULL"`.
   The number is assigned by the Worker from then on, and is never renumbered.
2. Set the required secret before the first deploy:
   `npx wrangler secret put SERVER_HMAC_KEY --env production` (a fresh 64-character hex value).
3. Build the SPA: `npm run build` (outputs to `dist/web`).
4. Deploy the public Worker: `npx wrangler deploy --env production`.
5. Deploy the admin Worker: `npx wrangler deploy --config admin/wrangler.toml --env production`.
6. Optional Turnstile. Set `TURNSTILE_SITE_KEY` as a plain variable under
   `[env.production.vars]` in `wrangler.toml` and `admin/wrangler.toml`, then store
   the secret with `npx wrangler secret put TURNSTILE_SECRET_KEY --env production`
   (add `--config admin/wrangler.toml` for the admin Worker). Turnstile is enabled
   on a Worker only when both keys are present there. The site key is public, so a
   plain variable under `[env.production.vars]` is enough, but
   `npx wrangler secret put TURNSTILE_SITE_KEY` works as well: keep the key in
   exactly one place, because a var and a secret cannot share a name.

Neither `wrangler.toml` file commits a production database UUID. The `[env.production]`
environment declares the D1 binding by database name only (variable `DB` ->
`chinapoll`), so wrangler resolves the real UUID through the API when it deploys and
when it applies migrations (`npx wrangler d1 migrations apply chinapoll --env production --remote`).
The `--env production` flag is required: without it wrangler resolves the database
against the top-level local binding (`chinapoll-local`) and fails with
`Couldn't find a D1 DB with the name or binding 'chinapoll'`.
Both Workers bind the same database, so they share one schema.

Both Workers also have a Deploy to Cloudflare button (see README.md) for deployments
driven from the dashboard instead of the CLI. Set the public deploy command to
`npm run deploy` and the admin one to `npm run deploy:admin:remote`; both apply
the migrations by database name with `--env production` and then deploy the
`[env.production]` Worker. Set each project's build command to `npm run build` so that
`dist/web` exists before the public Worker is deployed.

## Troubleshooting

### `binding DB of type d1 must have a valid database_id specified [code: 10021]`

The deploy ran without a target environment, so wrangler used the top-level
configuration, whose D1 binding is the local placeholder (`database_id = "local"`).
The same mistake also resets the Worker's routes from the local configuration,
which disables the custom domain and enables the `workers.dev` URL, so the
environment has to be named explicitly.

Use `npm run deploy` for the public Worker and
`npm run deploy:admin:remote` for the admin Worker, or pass the flag
directly with `npx wrangler deploy --env production`. When a Deploy to Cloudflare
button drives the build, set its deploy command to the matching script: the build
command loads `dist/web` and the deploy command has to select `[env.production]`.

## Uptime monitoring

Point an external monitor at `GET /api/health`. A healthy response is
`{ "ok": true, "db": "ok", "serverKey": true }`; `db` becomes `"error"` when D1 is
unreachable, `serverKey` is `false` when `SERVER_HMAC_KEY` is missing or malformed
(every vote then returns `503`), and `ok` is `false` in either case, so the
monitor should alert. The endpoint also returns the deployment `build` hash, the
timestamp of the most recent statistics snapshot, and the publish status:
`lastPublishAt` (the last publisher run) and `publishError` (true when the newest
run failed). Neither publish field affects `ok`, so a publishing problem is
visible without paging the whole site as down.

## Audit publishing

The public Worker copies the signed snapshot chain to a data repository once an
hour, after the snapshots are written and after the close step, so a poll that
closes this hour is published with its final counts. This replaces the former
GitHub Actions workflow. Configure it from the admin Settings tab, under
**Public audit repository**:

1. Create a **fine-grained personal access token** on GitHub, limited to the one
   data repository, with **Contents: Read and write** and no other permission.
2. Paste the token into the `github_token` field, set `publish_repository` in
   `owner/name` form, `publish_branch` (default `main`), and `publish_path`
   (default `snapshots`), and turn `publish_enable` on.
3. Use **Test connection** to confirm the repository is reachable and the token
   has write permission, and **Publish now** to run one pass immediately.

Where the token lives: the `github_token` value is a row in the shared D1
`settings` table as a secret row. It is masked in the
admin API and dashboard, stripped from the public settings endpoint, and never
written to the audit log or to any log line.

To rotate it, paste the new token into the `github_token` field and save; the new
value replaces the old one. Delete or expire the old token on GitHub afterwards.
Nothing else needs to change.

When `publishError` is true, `GET /api/health` reports the failed state and the
admin Overview shows the last five runs with their error text (the same rows live
in `publish_runs`). The failure never affects the rest of the site. Common causes
are an expired or rotated token (`401`), a token without write permission
(`403`), a wrong repository name (`404`), or a branch-protection rule that blocks
the bot (`422`). Fix the setting, then run **Publish now** to confirm.

## Backups and restore

1. Export the database: `npx wrangler d1 export chinapoll --remote --output backup.sql`.
2. Encrypt with `age`: `age -r <recipient> -o backup.sql.age backup.sql`.
3. Upload the encrypted file to the backup R2 bucket and keep 30 days.
4. To restore, decrypt, then apply to a fresh database with
   `npx wrangler d1 execute chinapoll --remote --file backup.sql`.

Test a restore at least quarterly against a staging database.

## Failover to a second account

1. In the standby Cloudflare account, create the D1 database and both Workers
   (adjust `database_id` in both `wrangler.toml` files).
2. Restore the most recent encrypted backup into the standby database.
3. Deploy the public and admin Workers in the standby account.
4. Move the DNS records for the public and admin hostnames to the standby
   Workers.
5. Set the `SERVER_HMAC_KEY` secret in the standby account so keyed hashing keeps
   working.

## Key rotation

`SERVER_HMAC_KEY` derives the keyed network hashes in `auth_attempts` and the
rate-limit network buckets, so rotating it only invalidates values already in
`auth_attempts`, which relaxes the rolling per-network account cap for the rest of
the current calendar month and resets the daily rate-limit buckets. Rotating the
server key does **not** affect poll or comment ownership: an `author_mark` is derived
from the account's own author key, never from the server secret, so "my polls" and
"my comments" and close, withdraw, and delete keep working unchanged after a
rotation.
Rotate the Turnstile secret by uploading a new value with
`npx wrangler secret put TURNSTILE_SECRET_KEY`, and rotate the
GitHub publish token the same way (see [Audit publishing](#audit-publishing)).
The key's name is `SERVER_HMAC_KEY`. The earlier `IP_HASH_KEY` alias is no longer
read, so a deployment that still sets only that name has no usable key and returns
`503` until the secret is uploaded under the current name.

## Migrating to another Cloudflare account

Secrets do not travel with the D1 database. Cloudflare returns a secret's value only
at upload time, so `SERVER_HMAC_KEY` and `TURNSTILE_SECRET_KEY` have to be saved where
you control them (a password manager or a secret vault) **before** the old account is
decommissioned; a D1 export contains neither. `github_token` is a settings row rather
than a secret, so it does travel with the data.

Reuse the same value on the new account
(`npx wrangler secret put SERVER_HMAC_KEY --env production`) and confirm
`GET /api/health` reports `"serverKey": true` before opening the site. A deployment
that starts with a *different* key still works and does not affect poll or comment
ownership (that no longer depends on the server secret); only the values already in
`auth_attempts` stop matching, which relaxes the rolling per-network account cap for
the rest of the current calendar month and resets the daily rate-limit buckets. A
deployment with *no* key refuses voting, reports, view counting, registration,
sign-in, and recovery with `503`; poll submission and comments no longer depend on
the key. The health check is the one signal that catches a missing or unusable key.

## Release notes

- **Optional AI assistance:** choose a provider in the admin Settings tab.
  `ai_provider` is `off` by default; `cloudflare` uses the Workers AI binding
  (`[ai] binding = "AI"`, repeated under `[env.production]`), and
  `openai_compatible` calls `<ai_api_url>/chat/completions` with the shared
  `ai_model`. The API key is optional and is sent as a bearer token when set.
  While the provider is `off`, `/api/ai/*` returns `404`. The provider powers the
  Worker's own review and topic classification; the public submit form renders no
  AI control. `ai_provider`, `ai_api_url`, `ai_api_key`, `ai_model`,
  `ai_rate_limit`, and `ai_review_prompt` stay private and are never served by
  the public settings endpoint. The review prompt applies only when
  `auto_approve_polls` is on and the provider is not `off`; when it is empty
  every auto-approved submission is published immediately.
- **Breaking: the `IP_HASH_KEY` fallback is gone.** The server key is read only as
  `SERVER_HMAC_KEY`. Rename the secret on every deployment
  (`npx wrangler secret put SERVER_HMAC_KEY --env production`) and in each
  developer's local `.dev.vars` before upgrading: a deployment that still sets only
  `IP_HASH_KEY` has no usable key, so voting, registration, sign-in, poll submission,
  and comments return `503` and `GET /api/health` reports `"serverKey": false`.
- **Submissions require the server key.** Poll submission and comment posting are
  refused with `503` when the key is missing, rather than stored with a `NULL` owner
  hash that their own author could never list, close, withdraw, or delete. Reading the
  site, and every existing row, is unaffected.