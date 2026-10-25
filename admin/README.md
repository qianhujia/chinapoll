# ChinaPoll Admin Worker

A standalone Cloudflare Worker that serves the admin dashboard and a JSON API and
shares the public application's D1 database. It reviews submissions, adjusts
polls, resolves reports, moderates comments, manages admins and public users,
reads the audit log, and edits settings. For local startup and deployment, see
[../README.md](../README.md); feature behavior is described in
[../docs/REFERENCE.md](../docs/REFERENCE.md).

## Layout

| Path | Purpose |
| --- | --- |
| `index.ts` | Worker entry point, routing, and security headers |
| `auth.ts` | Session cookies, session lookup, and CSRF origin checks |
| `api/session.ts` | Login, logout, session status, and first-run setup |
| `api/admins.ts` | Admin user CRUD, password reset, lock reset, status, and role |
| `api/comments.ts` | List and delete comments |
| `api/audit.ts` | Read-only audit log |
| `api/overview.ts` | Aggregate counts for the dashboard |
| `api/polls.ts` | List polls, review pending submissions, and change poll status |
| `api/reports.ts` | List polls with reports and resolve their open reports |
| `api/users.ts` | List and manage public user accounts (disable, unlock, delete) |
| `api/settings.ts` | List, validate, and update application settings |
| `services/turnstile.ts` | Turnstile configuration and token verification |
| `lib/password.ts` | PBKDF2 password hashing and policy |
| `lib/admins.ts` | Account constants, status helpers, username validation |
| `lib/audit.ts` | Audit log writer (never records client IPs) |
| `lib/settings.ts` | Setting validation shared by the dashboard API |
| `ui.ts` | Dashboard HTML shell (embedded styles and assembled client script) |
| `dashboard/icons.ts` | Lucide SVG markup for the sidebar's root menu items |
| `dashboard/styles.ts` | Embedded dashboard CSS |
| `dashboard/script/*` | Client script fragments; `script/index.ts` assembles `core`, `auth`, `shell`, and one module per page under `script/pages/` |
| `wrangler.toml` | Worker configuration and shared D1 binding |

## Database

The admin Worker shares the root `migrations/` directory. Its immutable baseline,
`migrations/0001_initial.sql`, creates three admin tables (schema only, no
seed or demo rows): `admin_users` (username, PBKDF2 `password_hash`, `role`,
status, `failed_attempts`, `locked_until`, `last_login_at`), `admin_sessions`
(SHA-256 hashed token, owning admin, `expires_at`), and `admin_audit_log`
(actor, action, target, JSON details, timestamp; no client IP). The same file
creates the `users`, `user_sessions`, and `auth_attempts` tables for public
accounts, plus `poll_reports`, `poll_views`, and the `views` column of
`stats_snapshots`. Apply it with `npm run db:migrate`.

## Configuration

The Worker binds to the same D1 database as the public application.
`[env.production]` declares that binding by database name only
(`DB` -> `chinapoll`), so no database UUID is committed; wrangler resolves it at
deploy time.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | No | Public Turnstile site key rendered on the login form |
| `TURNSTILE_SECRET_KEY` | No | Private key that verifies login tokens; the check runs only when both keys are set |
| `ADMIN_ORIGIN` | No | Extra origin allowed for cookie-authenticated mutations |
| `PUBLIC_SITE_ORIGIN` | No | Origin of the public site, used to link a report row to its poll and to show branding image URLs in full |

## Authentication

- A fresh install with no admins shows a setup form; `POST /api/admin/setup`
  creates the first account as the **super admin** and is disabled once any admin
  exists.
- Accounts created from the panel are regular admins unless a super admin grants
  the super admin role. Only super admins can read the audit log and create,
  modify, or delete other super admins.
- Passwords are PBKDF2-HMAC-SHA256 (100,000 iterations), stored as
  `pbkdf2$iterations$salt$hash`.
- Five consecutive failed sign-ins lock an account for fifteen minutes; an admin
  can clear the lock from the Admins tab.
- Sessions live in `admin_sessions` with a thirty-minute sliding expiry, and an
  admin holds a single active session: signing in elsewhere ends the previous
  one. A password reset, role change, disable, or delete ends every session of
  that admin.
- Cookie-authenticated mutations must include an `Origin` matching the Worker
  origin (or `ADMIN_ORIGIN`); other requests receive `403`. An admin cannot
  disable or delete their own account, and the last active admin cannot be
  removed.
- Every response carries the same baseline as the public Worker, applied by one
  wrapper in `index.ts`: `cache-control: no-store`, `referrer-policy: no-referrer`,
  `x-content-type-options: nosniff`, `x-frame-options: DENY`, and
  `strict-transport-security: max-age=31536000; includeSubDomains`. The dashboard
  document adds its own CSP; the JSON API and the error responses carry the
  baseline too.

## Endpoints

Authentication accepts either the `chinapoll_admin_session` cookie (set by the
login endpoint) or an `Authorization: Bearer <session-token>` header.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/`, `/overview` | Overview dashboard HTML |
| `GET` | `/polls`, `/comments`, `/users`, `/admins`, `/audit` | Dashboard HTML |
| `GET` | `/settings`, `/settings/<category>` | Settings dashboard HTML (`general`, `appearance`, `polls`, `auth`, `reports`, `ai`, `publishing`, `advanced`) |
| `GET` | `/reports`, `/reports/<queue>` | Reports dashboard HTML (`polls`, `comments`) |
| `GET` | `/api/health` | Heartbeat |
| `GET` | `/api/admin/session` | Session state, setup flag, Turnstile config |
| `POST` | `/api/admin/session` | Login with `{ username, password, turnstileToken? }` |
| `DELETE` | `/api/admin/session` | Logout |
| `POST` | `/api/admin/setup` | Create the first admin user when none exist |
| `GET` | `/api/admin/overview` | Dashboard counts and recent submissions |
| `GET` | `/api/admin/polls` | List polls including pending (`status`, `page`, `pageSize`, `q`); each row carries `pollType`, `durationSeconds`, `ballots`, and the options with a count each |
| `POST` | `/api/admin/polls/:id/status` | Set poll status (`{ "status": "open" }`); opening a deadline poll stamps `end_at` from `duration_seconds` |
| `PUT` | `/api/admin/polls/:id/options` | Replace the option set of a **pending** poll; `409` when it is not pending or already has ballots; writes a `poll.options` audit entry |
| `GET` | `/api/admin/reports` | List poll reports and comment reports, priority first (`status=open\|resolved\|all`, `page`, `pageSize`, `commentsPage`) |
| `POST` | `/api/admin/reports/:pollId/resolve` | Resolve every open report for a poll (`{ "resolution": "dismissed"\|"action_taken" }`) |
| `GET` | `/api/admin/comments` | List comments (`pollId`, `page`, `pageSize`, `q`) |
| `DELETE` | `/api/admin/comments/:id` | Delete a comment |
| `GET` | `/api/admin/users` | List public users (`status`, `page`, `pageSize`, `q`) |
| `POST` | `/api/admin/users/:id/status` | Enable or disable a user (`{ "status": "disabled" }`) |
| `POST` | `/api/admin/users/:id/unlock` | Reset failed attempts and lock expiry |
| `DELETE` | `/api/admin/users/:id` | Delete a user (keeps and detaches their content) |
| `GET` | `/api/admin/admins` | List admin users |
| `POST` | `/api/admin/admins` | Create an admin user (`{ username, password, role? }`) |
| `POST` | `/api/admin/admins/:id/password` | Reset a password (`{ password }`) |
| `POST` | `/api/admin/admins/:id/status` | Enable or disable (`{ "status": "active" }`) |
| `POST` | `/api/admin/admins/:id/role` | Change a role (`{ "role": "super_admin" }`), super admins only; revokes that admin's sessions |
| `POST` | `/api/admin/admins/:id/unlock` | Reset failed attempts and lock expiry |
| `DELETE` | `/api/admin/admins/:id` | Delete an admin user |
| `GET` | `/api/admin/audit` | Audit log, super admins only (`action`, `page`, `pageSize`, `q`) |
| `GET` | `/api/admin/settings` | List settings with masked secret values |
| `PUT` | `/api/admin/settings/:key` | Validate and update one setting |
| `POST` | `/api/admin/settings/initialize` | Insert missing default settings |
| `POST` | `/api/admin/settings/publish/test` | Read the configured repository through the GitHub API and report write permission |
| `POST` | `/api/admin/settings/publish/run` | Run one publisher pass on demand |

## Dashboard

Every view has its own URL: `/overview` (also `/`), `/polls`, `/reports`,
`/comments`, `/users`, `/admins`, `/audit`, and `/settings`. Sidebar links are
real anchors, so views can be bookmarked, shared, refreshed, and reached with the
browser back and forward buttons. Any view the visitor may not open (for example
`/audit` for a regular admin) or is not signed in for falls back to the overview
or the login screen; paths outside the set return `404`. Icons are Lucide SVG
markup rendered Worker-side (`dashboard/icons.ts`), so the dashboard stays one
self-contained document with no build step and no runtime dependency. Settings is
split into one page per category and Reports into one page per queue
(`/reports/polls` and `/reports/comments`), each with its own URL.

## Audit log

Visible to super admins only. Every state change is recorded with the acting
username, action, target, and JSON details: login success/failure/lock, logout,
poll status changes, comment deletion, setting updates (including publish
connection tests and on-demand runs), public user and admin management, and
report resolution (`report.resolved`). The public Worker also writes
`poll.auto_hidden` with no actor. Secret values and client IP addresses are never
written.

## Settings cache

The public Worker caches its merged settings in memory for 30 seconds, so a change
made here can take up to half a minute to reach the public site. Restarting or
redeploying the Worker applies changes immediately.

## Deployment

```bash
npm run admin:worker:dry-run
npm run deploy:admin
```

`deploy:admin` deploys `[env.production]`, which declares the D1 binding by
database name only, so no database UUID is committed; apply the shared schema
with `npx wrangler d1 migrations apply chinapoll --env production --remote`.
Because this Worker can publish polls, delete comments, and manage other admins,
put it behind Cloudflare Access or another access-control layer in production.
