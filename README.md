# ChinaPoll

A local-first privacy-focused polling app designed around the Cloudflare + D1 architecture described in the product spec.

## Local startup

```bash
npm install
cp .env.example .env
npm run dev
```

This starts:

- Built front-end preview at http://127.0.0.1:5173
- Local Worker at http://127.0.0.1:8787
- Local D1 database persisted under .wrangler

The local start command builds the frontend and Worker before starting them without hot reload. To apply code or style changes, stop the running processes and start `npm run dev` again.

Configuration is organized by runtime: `.env` contains front-end build settings, `wrangler.toml` contains Worker variables and bindings, and `.dev.vars` contains local Worker secrets. Turnstile is bypassed locally by default with `TURNSTILE_SKIP=true`.

Front-end settings use the `VITE_` prefix and are compiled into the browser bundle. The locale is fixed by `VITE_DEFAULT_LOCALE` (supported values: `en` and `zh-CN`; defaults to `en`); there is no language switch in the UI. Translations are loaded at runtime from `public/i18n/en.json` and `public/i18n/zh.json`. `VITE_SITENAME` and `VITE_SLOGON` configure the displayed site name and slogan, and `VITE_DATA_GITHUB_URL` configures the data link shown in the footer. `VITE_POLLS_PER_PAGE` and `VITE_COMMENTS_PER_PAGE` configure the homepage and comment page sizes (defaults: 15 and 30; maximum 100). `VITE_PAGE_WIDTH` sets the shared page maximum width in pixels (default: `960px`).

Keep secrets out of `.env` and `wrangler.toml`: use the ignored `.dev.vars` file for local Worker secrets and `wrangler secret put <NAME>` for production secrets. In particular, email-linked proposal identities require `SERVER_SECRET` as a 64-character random hexadecimal secret, and production Turnstile verification requires `TURNSTILE_SECRET_KEY`. Worker variables such as `READ_ONLY_MODE`, `TURNSTILE_SKIP`, and `VOTE_RATE_LIMIT_PER_IP_BUCKET_PER_HOUR` are configured in `wrangler.toml`; use production-safe values when deploying.

The homepage lists open polls stored in the local D1 `issues` table. An empty database shows no polls; the repository does not bundle poll seed or demo records.

## Local D1 + migrations

The local database is managed with versioned SQL migrations in the `migrations/` folder.

```bash
npm run db:migrate
```

This keeps schema changes reproducible across local development. Future schema updates should be added as new migration files in the same folder.

## Local proposal approval

Approve a pending proposal and create an open issue with its title, description, mode, and schedule copied from the proposal:

```bash
npm run admin -- approve-proposal <proposal-id>
```

This command operates on the local D1 database under `.wrangler`.

## Build check

The Vite production build compiles Tailwind utilities and Lucide icons into the deployed CSS and JavaScript bundles; neither library is needed at runtime.

```bash
npm run build
```
