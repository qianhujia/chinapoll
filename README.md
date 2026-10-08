# ChinaPoll

A local-first privacy-focused polling app designed around the Cloudflare + D1 architecture described in the product spec.

## Local startup

```bash
npm install
npm run db:migrate
npm run dev
```

This starts:

- Vite front-end at http://127.0.0.1:5173
- Local Worker at http://127.0.0.1:8787
- Local D1 database persisted under .wrangler

Turnstile is bypassed in local development via `TURNSTILE_SKIP=true` in the local Worker config.

The front-end locale is fixed by the `VITE_DEFAULT_LOCALE` environment variable (supported values: `en` and `zh-CN`; defaults to `en`). There is no language switch in the UI. `VITE_SITENAME` and `VITE_SLOGON` configure the displayed site name and slogan, and `VITE_DATA_GITHUB_URL` configures the data link shown in the footer. `VITE_POLLS_PER_PAGE` and `VITE_COMMENTS_PER_PAGE` configure the homepage and comment page sizes (defaults: 15 and 30; maximum 100). `VITE_PAGE_WIDTH` sets the shared page maximum width in pixels (default: `960px`).

Email-linked proposal identities require `SERVER_SECRET` as a 64-character random hexadecimal secret. Configure it with `wrangler secret put SERVER_SECRET` in Cloudflare, or store it in the ignored local `.dev.vars` file for local development. Never put this secret in frontend `.env` files or commit it.

```bash
cp .env.example .env
```

To seed local demo data, run the local worker database initialization script and then verify the app in the browser.

## Local D1 + migrations

The local database is managed with versioned SQL migrations in the `migrations/` folder.

```bash
npm run db:migrate
```

This keeps schema changes reproducible across local development. Future schema updates should be added as new migration files in the same folder.

## Build check

```bash
npm run build
```
