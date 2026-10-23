import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The Workers-runtime integration tests run under their own project
    // (vitest.workers.config.ts); keep them out of the Node unit-test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
    environment: 'node',
    // Keep a green run quiet: passing tests print nothing, and a failing test
    // still prints its logs. This keeps captured output small for humans and
    // AI tools that read it.
    silent: 'passed-only'
  }
});