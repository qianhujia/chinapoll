import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Workers-runtime integration tests.
//
// These run inside workerd with the bindings declared in wrangler.toml, so D1,
// the RateLimiter Durable Object, and the assets binding behave the way they do
// in production. A test-only SERVER_HMAC_KEY is injected so network and owner
// hashing are enabled.
const TEST_SERVER_HMAC_KEY = '1f2e3d4c5b6a798807162534435261708f9e0d1c2b3a495867758493a2b1c0d1';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // The AI binding has no local simulator, so the pool would try to open a
      // remote session (which needs a Cloudflare API token). Remote bindings are
      // turned off here: the integration tests stub `env.AI` themselves and the
      // real binding is never called.
      remoteBindings: false,
      miniflare: {
        // The pool bundles a workerd build whose newest supported compatibility
        // date is earlier than the production one, so tests pin a date it accepts.
        compatibilityDate: '2026-08-01',
        bindings: {
          SERVER_HMAC_KEY: TEST_SERVER_HMAC_KEY,
          BUILD_SHA: 'test'
        }
      }
    })
  ],
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // The Worker console output (route and fetch debug lines, the "Using
    // secrets defined in .dev.vars" notice) is large and adds no signal once a
    // test passes. Keep it only for failing tests so the captured output stays
    // small for humans and AI tools that read it.
    silent: 'passed-only'
  }
});
