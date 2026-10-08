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

The front-end locale is fixed by the `VITE_DEFAULT_LOCALE` environment variable (supported values: `en` and `zh-CN`; defaults to `en`). There is no language switch in the UI.

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
