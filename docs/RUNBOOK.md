# ChinaPoll runbook

Operational procedures for the two Workers that make up ChinaPoll. All commands
are run from the repository root.

## Deployments

1. Apply D1 migrations: `npx wrangler d1 migrations apply chinapoll --env production --remote`.
   `migrations/0001_initial.sql` holds the entire schema in a single file, frozen
   on **2026-10-11** when the earlier incremental migrations were folded together
   (nothing had been deployed yet). From then on migrations are immutable: never
   edit one that has already been applied, and add every schema change as a new
   numbered file. Only a **fresh** database is supported; create the production
   database empty and apply `0001_initial.sql` (plus any later files) in order.
2. Set the required secret before the first deploy:
   `npx wrangler secret put SERVER_HMAC_KEY --env production` (a fresh 64-character hex value).
3. Build the SPA: `npm run build` (outputs to `dist/web`).
4. Deploy the public Worker: `npx wrangler deploy --env production`.
5. Deploy the admin Worker: `npx wrangler deploy --config admin/wrangler.toml --env production`.
6. Optionally set `TURNSTILE_SITE_KEY` for the admin Worker:
   `npx wrangler secret put TURNSTILE_SITE_KEY --config admin/wrangler.toml --env production`.

## Uptime monitoring

Point an external monitor at `GET /api/health`. A healthy response is
`{ "ok": true, "db": "ok" }`; `db` becomes `"error"` when D1 is unreachable and
the monitor should alert. The endpoint also returns the deployment `build` hash
and the timestamp of the most recent statistics snapshot.

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