# Copilot instructions

- Write all README content in English.
- Write all comments and developer-facing notes in English.
- Write all commit messages in English.
- Use English for PR titles and descriptions.
- Never add non-English documentation, comments, or commit text.
- Keep the local project runnable with local D1 and Turnstile off by default; Turnstile is enabled only when both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set.
- Use migration-based schema updates for any D1 change.
- Never include sample, demo, or seed data in migration files; migrations must contain schema changes only.
