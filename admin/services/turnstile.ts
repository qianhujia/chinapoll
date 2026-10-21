// Turnstile verification for the admin Worker.
//
// Server-side verification lives in the public Worker (worker/services/turnstile.ts)
// and is imported here; the admin Worker never sends the client address.
// Both keys come from the Worker environment: TURNSTILE_SITE_KEY (public) and
// TURNSTILE_SECRET_KEY (private). Turnstile is enabled only when both are set.

import type { AdminEnv } from '../auth';
import { getTurnstileConfig as loadConfig, turnstileSecretKey, verifyTurnstile } from '../../worker/services/turnstile';

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
}

export function getTurnstileConfig(env: AdminEnv): TurnstileConfig {
  return loadConfig(env);
}

// Verifies the token against the configured secret, requiring the hostname
// Turnstile reports to match the admin host the request was served on.
export async function verifyAdminTurnstile(
  env: AdminEnv,
  token: string,
  hostname = ''
): Promise<boolean> {
  // The secret is read from the Worker environment, never from the database.
  return verifyTurnstile(turnstileSecretKey(env), token, hostname);
}
