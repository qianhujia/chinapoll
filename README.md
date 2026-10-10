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

Application settings are stored in the local D1 `settings` table and served to the front end by `/api/settings/public`. The `settings` table is the single source of truth for feature flags: read-only mode (`read_only_mode`), Turnstile (`turnstile_enable` plus the private `turnstile_secret_key`, which is never exposed by the public endpoint), rate limits (`vote_rate_limit`, `comment_rate_limit`, `proposal_rate_limit` in `"<count>/<unit>"` format with unit `w|d|h|m|s`), and the homepage hero (`hero_title`, `hero_subtitle`, `hero_background_color` — a CSS color (hex, rgb/a, hsl/a, or named) or CSS gradient; empty means no background). `.dev.vars` still holds local Worker secrets such as `SERVER_SECRET`. Turnstile is disabled locally by default (`turnstile_enable=false`).

Public application settings use these self-explanatory keys: `default_locale` (`en` or `zh-CN`), `site_name`, `site_slogan`, `data_repository_url`, `polls_per_page`, `comments_per_page`, `page_max_width_px`, `hero_title`, `hero_subtitle`, `hero_background_color`, `read_only_mode`, `turnstile_enable`, `vote_rate_limit`, `comment_rate_limit`, and `proposal_rate_limit`. Page sizes are limited to 1–100; the page width is in pixels. Missing or invalid settings fall back to built-in defaults. The locale supports `en` and `zh-CN`; translations are loaded from `public/i18n/en.json` and `public/i18n/zh.json`.

Manage settings with the admin CLI (values are validated before they are written):

```bash
npm run admin -- set-setting hero_title "Continuous polls · Fully anonymous · Openly auditable"
npm run admin -- set-setting hero_background_color "#1d4ed8"
npm run admin -- readonly on|off
```

Keep secrets out of `.env` and `wrangler.toml`: use the ignored `.dev.vars` file for local Worker secrets and `wrangler secret put <NAME>` for production secrets. In particular, email-linked proposal identities require `SERVER_SECRET` as a 64-character random hexadecimal secret. The Turnstile secret key lives in the `settings` table (64-character hex when set); the Worker only verifies tokens when `turnstile_enable` is `true` and a secret key is present.

The homepage lists open polls stored in the local D1 `polls` table. An empty database shows no polls; the repository does not bundle poll seed or demo records.

## Local D1 + migrations

The local database schema is managed with versioned SQL migrations in the `migrations/` folder. After applying migrations, `npm run db:migrate` initializes any missing public settings from the backend defaults without overwriting existing values.

```bash
npm run db:migrate
```

This keeps schema changes reproducible across local development. Future schema updates should be added as new migration files in the same folder.

## Local proposal approval

Approve a pending submission and publish its poll. The poll keeps the same ID from submission through approval:

```bash
npm run admin -- approve-proposal <poll-id>
```

This command operates on the local D1 database under `.wrangler`.

## Build check

The Vite production build compiles Tailwind utilities and Lucide icons into the deployed CSS and JavaScript bundles; neither library is needed at runtime.

```bash
npm run build
```
