// Turnstile verification for the admin Worker.
//
// Server-side verification lives in the public Worker (worker/services/turnstile.ts)
// and is imported here; the admin Worker never sends the client address. The
// public site key comes from the TURNSTILE_SITE_KEY variable.

import type { AdminEnv } from '../auth';
import { getTurnstileConfig as loadConfig, verifyTurnstile } from '../../worker/services/turnstile';

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
}

export function getTurnstileConfig(env: AdminEnv): Promise<TurnstileConfig> {
  return loadConfig(env, env.TURNSTILE_SITE_KEY ?? '');
}

export { verifyTurnstile };
