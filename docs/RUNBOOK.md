# ChinaPoll runbook

Operational procedures for the two Workers that make up ChinaPoll. All commands
are run from the repository root.

## Deployments

1. Apply D1 migrations: `npx wrangler d1 migrations apply chinapoll --remote`.
2. Build the SPA: `npm run build` (outputs to `dist/web`).
3. Deploy the public Worker: `npx wrangler deploy`.
4. Deploy the admin Worker: `npm run admin:worker:deploy`.
5. Set production secrets once: `npx wrangler secret put IP_HASH_KEY` (a fresh
   64-character hex value) for the public Worker, and `npx wrangler secret put
   TURNSTILE_SITE_KEY` (or a `[vars]` entry) for the admin Worker.

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
5. Set the `IP_HASH_KEY` secret in the standby account so keyed hashing keeps
   working.

## Key rotation

`IP_HASH_KEY` may be rotated at any time: values already in `auth_attempts` stop
matching, which only relaxes the rolling account cap for one day. Rotate the
Turnstile secret from the dashboard and the admin Settings tab.