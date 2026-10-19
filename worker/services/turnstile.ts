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

// Reads the private secret once per request so verification does not re-query D1.
export function getTurnstileSecret(env: TurnstileEnv): Promise<string> {
  return getSettingValue(env, 'turnstile_secret_key');
}

export async function getTurnstileConfig(env: TurnstileEnv, siteKey = ''): Promise<TurnstileConfig> {
  const [enableValue, secret] = await Promise.all([
    getSettingValue(env, 'turnstile_enable'),
    getSettingValue(env, 'turnstile_secret_key')
  ]);
  const enabled = enableValue === 'true' && Boolean(secret) && Boolean(siteKey);
  return { enabled, siteKey };
}

// Verifies a token against the given secret. The secret is passed in so callers
// that already hold it (the public Worker keeps it in `env`) do not re-read D1.
//
// When `expectedHostname` is given, the hostname Turnstile reports for the solved
// widget must match it. This stops a token solved on one host from being replayed
// against another host that shares the same site key.
export async function verifyTurnstile(
  secret: string,
  token: string,
  expectedHostname = ''
): Promise<boolean> {
  if (!secret || !token) return false;

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    if (!response.ok) return false;
    const data = await response.json() as { success?: boolean; hostname?: string };
    if (data.success !== true) return false;
    if (expectedHostname && data.hostname !== expectedHostname) return false;
    return true;
  } catch {
    return false;
  }
}