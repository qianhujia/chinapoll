// Turnstile verification for the public Worker.
//
// The whole configuration comes from the Worker environment and never from the
// settings table: TURNSTILE_SITE_KEY is the public key rendered by the forms and
// TURNSTILE_SECRET_KEY is the private key used for server-side verification.
// Turnstile is enabled exactly when both are configured, so removing either one
// turns the feature off and local development stays usable with neither set.
//
// The public Worker owns server-side verification; the admin Worker imports this
// module and does not send the client address, so no origin data leaves the
// platform.

export interface TurnstileEnv {
  /** Public site key. Rendered by the vote, report, login, and sign-up forms. */
  TURNSTILE_SITE_KEY?: string;
  /** Private key used for server-side verification. Never sent to the browser. */
  TURNSTILE_SECRET_KEY?: string;
}

export interface TurnstileConfig {
  enabled: boolean;
  siteKey: string;
}

export function turnstileSiteKey(env: TurnstileEnv): string {
  return (env.TURNSTILE_SITE_KEY ?? '').trim();
}

export function turnstileSecretKey(env: TurnstileEnv): string {
  return (env.TURNSTILE_SECRET_KEY ?? '').trim();
}

// Both keys are required: a site key alone cannot verify a token, and a secret
// alone has no widget to solve.
export function isTurnstileEnabled(env: TurnstileEnv): boolean {
  return turnstileSiteKey(env) !== '' && turnstileSecretKey(env) !== '';
}

export function getTurnstileConfig(env: TurnstileEnv): TurnstileConfig {
  return { enabled: isTurnstileEnabled(env), siteKey: turnstileSiteKey(env) };
}

// Verifies a token against the given secret. The secret is passed in so every
// caller reads it from its own Worker environment.
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