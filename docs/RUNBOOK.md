# ChinaPoll runbook

Operational procedures for the two Workers that make up ChinaPoll. All commands
are run from the repository root.

## Deployments

1. Apply D1 migrations: `npx wrangler d1 migrations apply chinapoll --env production --remote`.
   `migrations/0001_initial.sql` holds the entire schema in a single consolidated
   file, most recently consolidated on **2026-10-18** (an earlier consolidation was
   done on 2026-10-11) because nothing had been deployed yet. From then on
   migrations are immutable: never edit one that has already been applied, and add
   every schema change as a new numbered file. Only a **fresh** database is
   supported; create the production database empty and apply `0001_initial.sql`
   (plus any later files) in order. The file creates the final shape of every
   table, index, and constraint - the poll types and per-poll options,
   `vote_selections` with `votes` reduced to a ballot row, the report and view
   tables, the ballot/view/option-count columns of the snapshot chain, and the
   nullable `comments.owner_hash` - so no intermediate rebuild runs on a fresh
   database.
2. Set the required secret before the first deploy:
   `npx wrangler secret put SERVER_HMAC_KEY --env production` (a fresh 64-character hex value).
3. Build the SPA: `npm run build` (outputs to `dist/web`).
4. Deploy the public Worker: `npx wrangler deploy --env production`.
5. Deploy the admin Worker: `npx wrangler deploy --config admin/wrangler.toml --env production`.
6. Optionally set `TURNSTILE_SITE_KEY` for the admin Worker:
   `npx wrangler secret put TURNSTILE_SITE_KEY --config admin/wrangler.toml --env production`.

## Uptime monitoring

Point an external monitor at `GET /api/health`. A healthy response is
`{ "ok": true, "db": "ok", "serverKey": true }`; `db` becomes `"error"` when D1 is
unreachable, `serverKey` is `false` when `SERVER_HMAC_KEY` is missing or malformed
(every vote then returns `503`), and `ok` is `false` in either case, so the
monitor should alert. The endpoint also returns the deployment `build` hash and
the timestamp of the most recent statistics snapshot.

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
Turnstile secret from the dashboard and the admin Settings tab. The legacy
`IP_HASH_KEY` name is still read as a fallback, so a deployment can move to
`SERVER_HMAC_KEY` without downtime.

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