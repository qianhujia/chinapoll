# ChinaPoll

A local-first, privacy-focused polling app built on Cloudflare Workers and D1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/qianhujia/chinapoll)

The button clones this repository and deploys the public Worker, which serves the
SPA and `/api/*` from one hostname, together with a provisioned D1 database. On
the setup page choose the build command `npm run build` and the deploy command
`npm run deploy`, and set `SERVER_HMAC_KEY` to 64 random hex characters
(`openssl rand -hex 32`). No database UUID is committed: `[env.production]`
binds the database by name and wrangler resolves it at deploy time, so the deploy
command must name the environment. A bare `npx wrangler deploy` runs against the
local placeholder and fails with
`binding DB of type d1 must have a valid database_id specified [code: 10021]`.
Deploy the admin dashboard as a second Worker that shares the database, with the
deploy command `npm run deploy:admin:remote` (see [Admin Worker](#admin-worker)).
Full steps: [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Local startup

```bash
npm install
npm run dev
```

- Front end: http://127.0.0.1:5173 (built preview)
- Public Worker: http://127.0.0.1:8787
- Admin Worker: http://127.0.0.1:8788 (`npm run admin:worker:dev`)
- Local D1: the `settings` table under `.wrangler`

`npm run dev` builds once and serves without hot reload, so restart it after code
or style changes. The homepage lists open polls from D1; an empty database shows
no polls because the repository ships no seed or demo data.

## Configuration

- **Secrets** live in the ignored `.dev.vars` locally and in
  `wrangler secret put <NAME>` in production. Never commit them to `.env` or
  `wrangler.toml`.
- `SERVER_HMAC_KEY` (64 hex characters) is required by the public Worker for
  keyed, daily-rotated network hashing and for poll and comment ownership; without
  it voting, registration, sign-in, poll submission, and comments return `503`.
  The earlier `IP_HASH_KEY` name is no longer read, so the secret must be stored as
  `SERVER_HMAC_KEY`.
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` enable Turnstile when both are
  set; otherwise it stays off, which is the local default.
- **Application settings** are rows in the D1 `settings` table, served publicly
  by `/api/settings/public`, and edited from the admin dashboard. Missing or
  invalid values fall back to built-in defaults.
- The admin Worker has its own optional `ADMIN_ORIGIN` and `PUBLIC_SITE_ORIGIN`.

Every setting key and value is listed in [docs/REFERENCE.md](docs/REFERENCE.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build and serve the front end and public Worker |
| `npm run dev:worker` | Public Worker only (applies migrations first) |
| `npm run admin:worker:dev` | Admin Worker at http://127.0.0.1:8788 |
| `npm run db:migrate` / `npm run db:reset` | Apply migrations / wipe and reapply |
| `npm run build` | Type-check and build the SPA to `dist/web` |
| `npm run build:worker` | Dry-run build of the public Worker |
| `npm run admin:worker:dry-run` | Dry-run build of the admin Worker |
| `npm run deploy` / `npm run deploy:admin` | Deploy the public / admin Worker |
| `npm run deploy:admin:remote` | Apply migrations, then deploy the admin Worker |
| `npm run lint` | Type check (`tsc --noEmit`) |
| `npm run test:sanity` | Type check plus fast unit tests |
| `npm test` | Full unit and integration suite (CI) |

## Layout

| Path | Contents |
| --- | --- |
| `src/` | SPA: pages, UI, i18n client, and pure helpers |
| `worker/` | Public Worker: routing, API, and services |
| `admin/` | Admin Worker: dashboard, JSON API, and its `wrangler.toml` |
| `shared/` | Code imported by both Workers and the front end |
| `public/` | Static assets and the `i18n/*.json` dictionaries |
| `migrations/` | `0001_initial.sql` baseline plus numbered incremental migrations |
| `tests/` | Node unit tests and Workers-runtime integration tests |
| `docs/` | Reference, threat model, data map, and runbook |

## Architecture

- One public Worker serves the SPA from `dist/web` and `/api/*` from a single
  hostname. The admin Worker runs on a separate hostname with its own dashboard
  and shares the same D1 database.
- All schema changes use D1 migrations. `migrations/0001_initial.sql` is the immutable
  baseline; each later change is a new numbered file applied in filename order. A fresh
  database is built by applying every migration in order (`npm run db:reset` locally).
  No seed data ships.
- Three SQLite-backed Durable Objects: `RateLimiter` (rate limits),
  `PasswordHasher` (PBKDF2-HMAC-SHA256 at `PBKDF2_ITERATIONS`, 100,000, sharded
  16 ways),
  and `ViewCounter` (buffers poll views, flushing on a five-minute alarm). The
  admin Worker declares the first two.
- An hourly maintenance run writes a tamper-evident snapshot chain and can copy
  it to a public GitHub data repository.
- Privacy by design: timestamps are coarsened to the hour, network buckets are
  keyed daily-rotated hashes, votes are anonymous, and account deletion keeps
  content without an account link. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)
  and [docs/DATA_MAP.md](docs/DATA_MAP.md).

## Admin Worker

[![Deploy the admin dashboard to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/qianhujia/chinapoll)

The admin Worker shares the public D1 database and serves a dashboard plus a JSON
API to review submissions, adjust polls, resolve reports, moderate comments,
manage admins and users, read the audit log, and edit settings. Each view has its
own URL. A fresh install shows a one-time setup form; the first account is the
super admin, and accounts added later are regular admins. It imports `shared/*`
and points its `migrations_dir` at `../migrations`, so the Deploy button points
at the repository root. See [admin/README.md](admin/README.md) for the endpoint
reference.

## Testing

```bash
npm run test:sanity   # type check + fast unit tests: default after a code change
npm run test:unit     # Node unit tests
npm run test:workers  # Workers-runtime integration tests
npm test              # full suite (CI runs this on every push and PR)
```

Node unit tests cover pure functions; integration tests run inside a real workerd
instance with D1 and the Durable Objects. Both projects use
`silent: 'passed-only'`, so a green run is quiet and only failures print their
logs; run a single file while iterating. See [AGENTS.md](AGENTS.md) for the full
workflow.

CI (`.github/workflows/ci.yml`) runs lint, build, `npm test`, both Worker dry-run
builds, and a check that the built SPA loads no third-party origin other than
`challenges.cloudflare.com`. There is deliberately no deploy job.

## Documentation

- [docs/REFERENCE.md](docs/REFERENCE.md) - settings, poll types, snapshots, publishing, AI, errors
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) - what the system protects and Cloudflare settings that must stay disabled
- [docs/DATA_MAP.md](docs/DATA_MAP.md) - every table and column, its readers, and retention
- [docs/RUNBOOK.md](docs/RUNBOOK.md) - deployment, monitoring, backups, restore, failover
- [admin/README.md](admin/README.md) - admin Worker endpoints and dashboard

## Build check

The Vite production build compiles Tailwind utilities and Lucide icons into the
deployed bundles; neither library is needed at runtime.

```bash
npm run build
```
