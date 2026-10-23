# Copilot instructions

- Write all README content in English.
- Write all comments and developer-facing notes in English.
- Write all commit messages in English.
- Use English for PR titles and descriptions.
- Never add non-English documentation, comments, or commit text.
- Keep the local project runnable with local D1 and Turnstile off by default; Turnstile is enabled only when both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set.
- Use migration-based schema updates for any D1 change.
- Treat `migrations/0001_initial.sql` as an immutable baseline. Add each later schema change as a new numbered migration file (e.g. `0002_<summary>.sql`) applied in filename order; never edit the baseline once it has been applied.
- Never include sample, demo, or seed data in migration files; migrations must contain schema changes only.
- Do not run the full `npm test` after every code change: it prints about 90k characters (roughly 22k tokens). Run `npm run test:sanity` (a type check plus the fast Node unit tests) for code changes, and scope a run to the affected test file when possible. The full suite runs in CI.
