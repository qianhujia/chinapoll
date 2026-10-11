# ChinaPoll Admin Worker

The admin Worker is a standalone Cloudflare Worker that shares the main
application's D1 database. It serves a browser dashboard and a JSON API used to
review submissions, adjust polls, moderate comments, manage admin users, review
an audit log, and update application settings.

## Layout

| Path | Purpose |
| --- | --- |
| `index.ts` | Worker entry point, routing, and security headers |
| `auth.ts` | Session cookies, session lookup, and CSRF origin checks |
| `api/session.ts` | Login, logout, session status, and first-run setup |
| `api/admins.ts` | Admin user CRUD, password reset, lock reset, status |
| `api/comments.ts` | List and delete comments |
| `api/audit.ts` | Read-only audit log |
| `api/overview.ts` | Aggregate counts for the dashboard |
| `api/polls.ts` | List polls, review pending submissions, and change poll status |
| `api/users.ts` | List and manage public user accounts (disable, unlock, delete) |
| `api/settings.ts` | List, validate, and update application settings |
| `services/turnstile.ts` | Turnstile configuration and token verification |
| `lib/password.ts` | PBKDF2 password hashing and policy |
| `lib/admins.ts` | Account constants, status helpers, username validation |
| `lib/audit.ts` | Audit log writer (never records client IPs) |
| `lib/settings.ts` | Setting validation shared by the dashboard API |
| `ui.ts` | Dashboard HTML shell (embedded styles and assembled client script) |
| `dashboard/styles.ts` | Embedded dashboard CSS |
| `dashboard/script/*` | Client script fragments: `script/index.ts` assembles `core`, `auth`, `shell`, and one module per page under `script/pages/` |
| `wrangler.toml` | Worker configuration and shared D1 binding |

## Database

The `0002_admin_auth.sql` and `0003_admin_roles.sql` migrations add three tables.
Migrations contain schema changes only; no seed or demo rows are inserted.

| Table | Purpose |
| --- | --- |
| `admin_users` | Username, PBKDF2 `password_hash`, `role` (admin or super admin), status, `failed_attempts`, `locked_until`, `last_login_at` |
| `admin_sessions` | SHA-256 hashed session token, owning admin, `expires_at` (30-minute sliding window) |
| `admin_audit_log` | Actor, action, target, JSON details, timestamp (no client IP) |

The public application's `0004_user_auth.sql` migration adds the `users`,
`user_sessions`, and `auth_attempts` tables that back public accounts; the Users
tab in the dashboard manages rows in `users`.

Apply it with the project migration command:

```bash
npm run db:migrate
```

## Configuration

The Worker binds to the same D1 database as the public application. Update
`database_id` in `wrangler.toml` with the production database UUID when
deploying.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | No | Public Turnstile site key rendered on the login form |
| `ADMIN_ORIGIN` | No | Extra origin allowed for cookie-authenticated mutations |

Turnstile verification runs only when the `turnstile_enable` setting is `true`
and both the `turnstile_secret_key` setting and `TURNSTILE_SITE_KEY` are present,
so local development stays usable without keys.

## Authentication

- New installs with no admin users show a setup form. `POST /api/admin/setup`
  creates the first account as a **super admin** and is disabled once any admin
  exists.
- **Roles**: the first account is a super admin; accounts created from the panel
  are regular admins unless a super admin grants the super admin role. Only super
  admins can read the audit log, and only super admins can create, modify, or
  delete other super admins.
- Passwords are hashed with PBKDF2-HMAC-SHA256 (100,000 iterations) and stored as
  `pbkdf2$iterations$salt$hash`.
- Five consecutive failed sign-ins lock an account for fifteen minutes. An admin
  can clear the lock from the Admins tab.
- Sessions live in `admin_sessions` with a thirty-minute sliding expiry and are
  revoked on password reset, disable, and delete.

## Local development

```bash
npm run db:migrate
npm run admin:worker:dev
```

This starts the admin Worker on http://127.0.0.1:8788 using the same local D1
database under `.wrangler` as the public Worker. Wrangler reads `.dev.vars` from
the directory that contains the Worker configuration file.

## Endpoints

Authentication accepts either the `chinapoll_admin_session` cookie (set by the
login endpoint) or an `Authorization: Bearer <session-token>` header.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/`, `/overview` | Overview dashboard HTML |
| `GET` | `/polls` | Polls dashboard HTML |
| `GET` | `/comments` | Comments dashboard HTML |
| `GET` | `/users` | Users dashboard HTML |
| `GET` | `/admins` | Admins dashboard HTML |
| `GET` | `/audit` | Audit log dashboard HTML (super admins only) |
| `GET` | `/settings` | Settings dashboard HTML |
| `GET` | `/api/health` | Heartbeat |
| `GET` | `/api/admin/session` | Session state, setup flag, Turnstile config |
| `POST` | `/api/admin/session` | Login with `{ username, password, turnstileToken? }` |
| `DELETE` | `/api/admin/session` | Logout |
| `POST` | `/api/admin/setup` | Create the first admin user when none exist |
| `GET` | `/api/admin/overview` | Dashboard counts and recent submissions |
| `GET` | `/api/admin/polls` | List polls including pending submissions (`status`, `page`, `pageSize`, `q`) |
| `POST` | `/api/admin/polls/:id/status` | Set poll status (`{ "status": "open" }`) |
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
| `POST` | `/api/admin/admins/:id/unlock` | Reset failed attempts and lock expiry |
| `DELETE` | `/api/admin/admins/:id` | Delete an admin user |
| `GET` | `/api/admin/audit` | Audit log, super admins only (`action`, `page`, `pageSize`, `q`) |
| `GET` | `/api/admin/settings` | List settings with masked secret values |
| `PUT` | `/api/admin/settings/:key` | Validate and update one setting |
| `POST` | `/api/admin/settings/initialize` | Insert missing default settings |

Cookie-authenticated mutations must include an `Origin` header that matches the
Worker origin (or `ADMIN_ORIGIN`); other requests receive `403`. Self-lockout is
prevented: an admin cannot disable or delete their own account, and the last
active admin cannot be removed.

### Dashboard URLs

The dashboard is a single page that gives every view its own URL: `/overview`
(also `/`), `/polls`, `/comments`, `/users`, `/admins`, `/audit`, and
`/settings`. The sidebar links are real anchors, and switching views updates the address bar, so
views can be bookmarked, shared, refreshed, and reached with the browser back and
forward buttons. The Worker serves the same dashboard HTML for each of these
paths; any view that a visitor is not allowed to open (for example `/audit` for a
regular admin) or is not signed in for falls back to the overview or the login
screen. Paths outside this set return `404`.

## Audit log

The audit log is visible to super admins only. Every state change is recorded
with the acting username, action, target, and JSON details: login
success/failure/lock, logout, poll status changes (including approving or
rejecting submissions), comment deletion, setting updates, public user status
changes, unlocks and deletions, and admin user management. Secret setting values
are never written. Client IP addresses are never stored.

## Deployment

```bash
npm run admin:worker:dry-run
npm run admin:worker:deploy
```

Because this Worker can publish polls, delete comments, and manage other admins,
put it behind Cloudflare Access or another access control layer in production.

