# Repository rules for AI contributors

This repository follows strict English-only rules for all contributor-facing text.

## Required rules

1. All README files must be written in English.
2. All code comments, inline notes, and developer-facing documentation must be written in English.
3. All commit messages must be written in English.
4. All PR titles and descriptions must be written in English.
5. Do not add non-English comments, README text, or commit messages.
6. When updating documentation, use clear, concise English that is professional and neutral.
7. If a migration, schema, or deployment note is added, write it in English.
8. Never include sample, demo, or seed data in migration files; migrations must contain schema changes only.

## Local workflow

- Keep the project runnable locally.
- Use local D1 migrations for schema updates.
- Treat `migrations/0001_initial.sql` as the immutable baseline. Add each later schema change as a new numbered migration file (e.g. `0002_<summary>.sql`) applied in filename order; never edit the baseline once it has been applied.
- Keep Turnstile disabled locally unless explicitly requested for production verification. Turnstile is configured only through the `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` environment variables and is enabled exactly when both are set.
- Treat English-only documentation as a required repository standard, not as optional wording.

## Testing workflow

Full-suite runs are expensive to read: `npm test` prints roughly 90k characters
(about 22k tokens), most of it per-test Worker debug logging. Do not run the
full suite after every change.

- After a code change, run the sanity check only: `npm run test:sanity` (a type
  check plus the fast Node unit tests). It is quiet and small.
- When a change touches one area, run just the matching test file, for example
  `npx vitest run tests/unit.test.ts` or
  `npx vitest run --config vitest.workers.config.ts tests/integration/votes.test.ts`.
- Run the Workers-runtime integration suite (`npm run test:workers`) only when
  the change touches Worker, API, D1, or Durable Object code, and prefer a
  single file while iterating.
- The full `npm test` runs in CI (`.github/workflows/ci.yml`) on every push and
  pull request. Reserve a local full run for a pre-merge check or when the
  change touches shared infrastructure.
- Both Vitest projects set `silent: 'passed-only'`, so passing tests stay quiet
  and only failures print their logs. Keep that behavior when editing the
  Vitest configs.

## AI context hygiene

Generated and local files are kept out of AI tool context so a search or a read
cannot pull in large, useless content.

- `package-lock.json` is auto-generated and about 200 KB (roughly 51k tokens). It
  is tracked in git, so `.gitignore` cannot exclude it and each AI tool needs its
  own rule:
  - `.clineignore`, `.cursorignore`, and `.kilocodeignore` are identical files
    that use `.gitignore` syntax.
  - Claude Code has no ignore file; `.claude/settings.json` lists
    `permissions.deny` `Read(...)` rules instead.
- Those rules also exclude `node_modules/`, `dist/`, `.wrangler/`,
  `tsconfig.tsbuildinfo`, `logs/`, `*.log`, and `.dev.vars`. Keep every list in
  sync and add any new generated artifact to all of them.
- Runtime logs from `wrangler dev`, `vite preview`, and similar commands belong
  in `logs/`, which is ignored; do not write them to the repository root.
