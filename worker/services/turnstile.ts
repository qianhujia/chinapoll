// Turnstile verification for the public Worker.
//
// The public Worker owns server-side verification; the admin Worker imports this
// module and does not send the client address, so no origin data leaves the
// platform. Verification runs only when the feature is enabled and a secret key
// is configured, which keeps local development usable when keys are absent.

export interface TurnstileEnv {
  DB: D1Database;
}

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
}

async function getSettingValue(env: TurnstileEnv, key: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).bind(key).first<{ value: string | null }>();
  return row?.value ?? '';
}

export async function getTurnstileConfig(env: TurnstileEnv, siteKey = ''): Promise<TurnstileConfig> {
  const [enableValue, secret] = await Promise.all([
    getSettingValue(env, 'turnstile_enable'),
    getSettingValue(env, 'turnstile_secret_key')
  ]);
  const enabled = enableValue === 'true' && Boolean(secret) && Boolean(siteKey);
  return { enabled, siteKey };
}

export async function verifyTurnstile(env: TurnstileEnv, token: string): Promise<boolean> {
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