# ChinaPoll runbook

Operational procedures for the two Workers that make up ChinaPoll. All commands
are run from the repository root.

## Deployments

1. Apply D1 migrations: `npx wrangler d1 migrations apply chinapoll --env production --remote`.
   `migrations/0001_initial.sql` holds the entire schema in a single consolidated
   file, most recently consolidated on **2026-10-18** (an earlier consolidation was
   done on 2026-10-11) because nothing had been deployed yet. All migration SQL
   stays in that one file: never add numbered migration files, and keep every schema
   change in `0001_initial.sql`. Only a **fresh** database is supported; create the
   production database empty and apply `0001_initial.sql`
   in order. The file creates the final shape of every
   table, index, and constraint - the poll types and per-poll options,
   `vote_selections` with `votes` reduced to a ballot row, the report and view
   tables, the ballot/view/option-count columns of the single-format snapshot
   chain, the `publish_state` and `publish_runs` tables, and the nullable
   `comments.owner_hash` - so no intermediate rebuild runs on a fresh database.
2. Set the required secret before the first deploy:
   `npx wrangler secret put SERVER_HMAC_KEY --env production` (a fresh 64-character hex value).
3. Build the SPA: `npm run build` (outputs to `dist/web`).
4. Deploy the public Worker: `npx wrangler deploy --env production`.
5. Deploy the admin Worker: `npx wrangler deploy --config admin/wrangler.toml --env production`.
6. Optional Turnstile. Set `TURNSTILE_SITE_KEY` as a plain variable under
   `[env.production.vars]` in `wrangler.toml` and `admin/wrangler.toml`, then store
   the secret with `npx wrangler secret put TURNSTILE_SECRET_KEY --env production`
   (add `--config admin/wrangler.toml` for the admin Worker). Turnstile is enabled
   on a Worker only when both keys are present there.

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
`npm run deploy` and the admin one to `npm run admin:worker:deploy:remote`; both apply
the migrations by database name with `--env production` and then deploy the
`[env.production]` Worker. Set each project's build command to `npm run build` so that
`dist/web` exists before the public Worker is deployed.

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

`SERVER_HMAC_KEY` may be rotated at any time: values already in `auth_attempts` stop
matching, which only relaxes the rolling account cap for one day. Rotate the
Turnstile secret by uploading a new value with
`npx wrangler secret put TURNSTILE_SECRET_KEY`, and rotate the
GitHub publish token the same way (see [Audit publishing](#audit-publishing)).
The legacy `IP_HASH_KEY` name is still read as a fallback, so a deployment can
move to `SERVER_HMAC_KEY` without downtime.

## Release notes

- **Optional AI assistance:** the public Worker binds Cloudflare Workers AI as
  `AI` (`[ai] binding = "AI"`, repeated under `[env.production]`). The feature is
  **off** by default: `ai_enable` is a normal setting in the `settings` table and
  can be turned on from the admin Settings tab. When it is off, `/api/ai/*`
  returns `404` and the frontend hides the buttons. `ai_model` and
  `ai_rate_limit` stay private and are never served by the public settings
  endpoint.
- **Next release:** the one-release `IP_HASH_KEY` fallback is dropped. Rename the
  secret to `SERVER_HMAC_KEY` on every deployment
  (`npx wrangler secret put SERVER_HMAC_KEY --env production`) and in each
  developer's local `.dev.vars` before upgrading. After the fallback is removed, a
  deployment that still sets only `IP_HASH_KEY` has no usable key, and voting and
  account creation return `503` (`GET /api/health` then reports
  `"serverKey": false`).