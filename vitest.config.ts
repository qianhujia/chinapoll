import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The Workers-runtime integration tests run under their own project
    // (vitest.workers.config.ts); keep them out of the Node unit-test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
    environment: 'node'
  }
});