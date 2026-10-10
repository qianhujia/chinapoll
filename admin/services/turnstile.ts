// Turnstile verification for the admin login form.
//
// The admin Worker reuses the public application's `turnstile_enable` and
// `turnstile_secret_key` settings for server-side verification and reads the
// public site key from the TURNSTILE_SITE_KEY variable. Verification is enforced
// only when the feature is enabled and fully configured, which keeps local
// development usable when the keys are absent.

import type { AdminEnv } from '../auth';

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
}

async function getSettingValue(env: AdminEnv, key: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).bind(key).first<{ value: string | null }>();
  return row?.value ?? '';
}

export async function getTurnstileConfig(env: AdminEnv): Promise<TurnstileConfig> {
  const [enableValue, secret, siteKey] = await Promise.all([
    getSettingValue(env, 'turnstile_enable'),
    getSettingValue(env, 'turnstile_secret_key'),
    Promise.resolve(env.TURNSTILE_SITE_KEY ?? '')
  ]);
  const enabled = enableValue === 'true' && Boolean(secret) && Boolean(siteKey);
  return { enabled, siteKey };
}

export async function verifyTurnstile(env: AdminEnv, token: string): Promise<boolean> {
  if (!token) return false;
  const secret = await getSettingValue(env, 'turnstile_secret_key');
  if (!secret) return false;

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    if (!response.ok) return false;
    const data = await response.json() as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
