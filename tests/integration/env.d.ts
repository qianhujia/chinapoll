// Provides the Workers test runtime types and augments the bound environment with
// the public Worker's bindings so `env` is typed inside integration tests.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as WorkerEnv } from '../../worker/index';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
