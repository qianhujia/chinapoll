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

Application settings are stored in the local D1 `settings` table and served to the front end by `/api/settings/public`. `wrangler.toml` contains Worker variables and bindings, and `.dev.vars` contains local Worker secrets. Turnstile is bypassed locally by default with `TURNSTILE_SKIP=true`.

Public application settings use these self-explanatory keys: `default_locale` (`en` or `zh-CN`), `site_name`, `site_slogan`, `data_repository_url`, `polls_per_page`, `comments_per_page`, and `page_max_width_px`. Page sizes are limited to 1–100; the page width is in pixels. Missing settings use built-in defaults. To update a setting in local D1, run `npx wrangler d1 execute chinapoll-local --local --persist-to .wrangler --command "UPDATE settings SET value = 'New name', updated_at = unixepoch() WHERE key = 'site_name';"`. Use the matching key and desired value for other settings. The locale supports `en` and `zh-CN`; translations are loaded from `public/i18n/en.json` and `public/i18n/zh.json`.

Keep secrets out of `.env` and `wrangler.toml`: use the ignored `.dev.vars` file for local Worker secrets and `wrangler secret put <NAME>` for production secrets. In particular, email-linked proposal identities require `SERVER_SECRET` as a 64-character random hexadecimal secret, and production Turnstile verification requires `TURNSTILE_SECRET_KEY`. Worker variables such as `READ_ONLY_MODE`, `TURNSTILE_SKIP`, and `VOTE_RATE_LIMIT_PER_IP_BUCKET_PER_HOUR` are configured in `wrangler.toml`; use production-safe values when deploying.

The homepage lists open polls stored in the local D1 `issues` table. An empty database shows no polls; the repository does not bundle poll seed or demo records.

## Local D1 + migrations

The local database schema is managed with versioned SQL migrations in the `migrations/` folder. After applying migrations, `npm run db:migrate` initializes any missing public settings from the backend defaults without overwriting existing values.

```bash
npm run db:migrate
```

This keeps schema changes reproducible across local development. Future schema updates should be added as new migration files in the same folder.

## Local proposal approval

Approve a pending submission and publish its issue. The issue keeps the same ID from submission through approval:

```bash
npm run admin -- approve-proposal <issue-id>
```

This command operates on the local D1 database under `.wrangler`.

## Build check

The Vite production build compiles Tailwind utilities and Lucide icons into the deployed CSS and JavaScript bundles; neither library is needed at runtime.

```bash
npm run build
```
