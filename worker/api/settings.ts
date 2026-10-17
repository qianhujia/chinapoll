// Public application settings: defaults, validation, and the single loader used
// by both the request router and the public settings endpoint.

interface SettingRow {
  key: string;
  value: string | null;
}

// Rate limits use the "<count>/<unit>" format where unit is one of w, d, h, m, s.
// The capture groups are required by parseRateLimit.
export const RATE_LIMIT_PATTERN = /^(\d+)\/([wdhms])$/;

// Hero background accepts a CSS color (hex, rgb/a, hsl/a, named) or a CSS gradient.
export const HERO_BACKGROUND_COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\)|[a-z]+|(?:linear|radial)-gradient\(.+\))$/i;

export const DEFAULT_PUBLIC_SETTINGS = {
  default_locale: 'en',
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  data_repository_url: 'https://github.com/qianhujia/chinapoll-data',
  polls_per_page: 15,
  comments_per_page: 30,
  page_max_width_px: 960,
  vote_rate_limit: '5/h',
  comment_rate_limit: '3/h',
  proposal_rate_limit: '1/d',
  report_rate_limit: '3/d',
  hero_title: 'Continuous polls · Anonymously cast · Openly auditable',
  hero_subtitle: 'Sign in to submit a poll or comment; votes stay anonymous.',
  hero_background_color: '',
  read_only_mode: false,
  turnstile_secret_key: '',
  turnstile_site_key: '',
  turnstile_enable: false,
  // Shows an "optional" badge next to the login link in the site navigation when
  // true, making clear that signing in is not required.
  login_badge_enable: false,
  // When true, submitted polls are published immediately; when false they stay
  // pending until an admin approves them.
  auto_approve_polls: false,
  // Account gating and authentication limits. Delay values are whole hours;
  // "N/w|d|h|m|s" values use the shared rate-limit format.
  user_poll_delay_hours: 48,
  user_comment_delay_hours: 24,
  max_accounts_per_ip: 4,
  login_max_failed_attempts: 5,
  login_lock_minutes: 15,
  login_rate_limit: '10/h',
  register_rate_limit: '5/d',
  // Vote totals below this number are hidden until the poll gathers more votes.
  min_votes_to_display: 10,
  // Automatic protection: a poll is hidden for review once it collects this many
  // open reports in total, or this many open reports with a high-priority reason.
  // Setting a threshold to 0 disables that rule.
  report_auto_hide_threshold: 5,
  report_auto_hide_priority_threshold: 2
};

export type PublicSettings = typeof DEFAULT_PUBLIC_SETTINGS;

const publicSettingKeys = Object.keys(DEFAULT_PUBLIC_SETTINGS) as Array<keyof PublicSettings>;

// Raised when a stored setting fails validation. The public endpoint reports it
// as a 500; the request router falls back to the built-in defaults.
export class SettingsValidationError extends Error {
  constructor(public readonly key: string, message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

function invalid(key: string, requirement: string): never {
  throw new SettingsValidationError(key, `setting "${key}" ${requirement}`);
}

function isLocale(value: string): value is 'en' | 'zh-CN' | 'zh-TW' {
  return value === 'en' || value === 'zh-CN' || value === 'zh-TW';
}

function isInteger(value: string, min: number, max: number): boolean {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
// Loads and validates every public setting in one pass. Missing rows keep their
// default; a malformed stored value raises SettingsValidationError.
export async function loadPublicSettings(db: D1Database): Promise<PublicSettings> {
  const placeholders = publicSettingKeys.map(() => '?').join(', ');
  const result = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`
  ).bind(...publicSettingKeys).all<SettingRow>();

  const settings: PublicSettings = { ...DEFAULT_PUBLIC_SETTINGS };

  for (const row of result.results ?? []) {
    if (!(row.key in DEFAULT_PUBLIC_SETTINGS)) continue;
    if (row.value === null) invalid(row.key, 'must have a value');
    const value = row.value;

    switch (row.key as keyof PublicSettings) {
      case 'default_locale':
        if (!isLocale(value)) invalid(row.key, 'must be "en", "zh-CN", or "zh-TW"');
        settings.default_locale = value;
        break;
      case 'site_name':
        if (!value.trim() || value.length > 100) invalid(row.key, 'must contain 1 to 100 characters');
        settings.site_name = value;
        break;
      case 'site_slogan':
        if (value.length > 300) invalid(row.key, 'must not exceed 300 characters');
        settings.site_slogan = value;
        break;
      case 'data_repository_url':
        if (value && !isHttpsUrl(value)) invalid(row.key, 'must be an HTTPS URL or empty');
        settings.data_repository_url = value;
        break;
      case 'polls_per_page':
      case 'comments_per_page':
        if (!isInteger(value, 1, 100)) invalid(row.key, 'must be an integer from 1 to 100');
        (settings as Record<string, unknown>)[row.key] = Number(value);
        break;
      case 'page_max_width_px':
        if (!isInteger(value, 100, 9999)) invalid(row.key, 'must be an integer from 100 to 9999');
        settings.page_max_width_px = Number(value);
        break;
      case 'user_poll_delay_hours':
      case 'user_comment_delay_hours':
        if (!isInteger(value, 0, 8760)) invalid(row.key, 'must be an integer from 0 to 8760');
        (settings as Record<string, unknown>)[row.key] = Number(value);
        break;
      case 'max_accounts_per_ip':
        if (!isInteger(value, 1, 1000)) invalid(row.key, 'must be an integer from 1 to 1000');
        settings.max_accounts_per_ip = Number(value);
        break;
      case 'login_max_failed_attempts':
        if (!isInteger(value, 1, 100)) invalid(row.key, 'must be an integer from 1 to 100');
        settings.login_max_failed_attempts = Number(value);
        break;
      case 'login_lock_minutes':
        if (!isInteger(value, 1, 1440)) invalid(row.key, 'must be an integer from 1 to 1440');
        settings.login_lock_minutes = Number(value);
        break;
      case 'min_votes_to_display':
      case 'report_auto_hide_threshold':
      case 'report_auto_hide_priority_threshold':
        if (!isInteger(value, 0, 1000)) invalid(row.key, 'must be an integer from 0 to 1000');
        (settings as Record<string, unknown>)[row.key] = Number(value);
        break;
      case 'vote_rate_limit':
      case 'comment_rate_limit':
      case 'proposal_rate_limit':
      case 'report_rate_limit':
      case 'login_rate_limit':
      case 'register_rate_limit': {
        const normalized = value.trim().toLowerCase();
        if (!RATE_LIMIT_PATTERN.test(normalized)) invalid(row.key, 'must be in format "N/w|d|h|m|s"');
        (settings as Record<string, unknown>)[row.key] = normalized;
        break;
      }
      case 'hero_title':
        if (!value.trim() || value.length > 200) invalid(row.key, 'must contain 1 to 200 characters');
        settings.hero_title = value;
        break;
      case 'hero_subtitle':
        if (value.length > 500) invalid(row.key, 'must not exceed 500 characters');
        settings.hero_subtitle = value;
        break;
      case 'hero_background_color':
        if (value && !HERO_BACKGROUND_COLOR_PATTERN.test(value)) {
          invalid(row.key, 'must be a CSS color (hex, rgb/a, hsl/a, or named) or a CSS gradient');
        }
        settings.hero_background_color = value;
        break;
      case 'login_badge_enable':
      case 'auto_approve_polls':
      case 'read_only_mode':
      case 'turnstile_enable':
        if (value !== 'true' && value !== 'false') invalid(row.key, 'must be "true" or "false"');
        (settings as Record<string, unknown>)[row.key] = value === 'true';
        break;
      case 'turnstile_secret_key':
        if (value && !/^[0-9a-f]{64}$/i.test(value)) invalid(row.key, 'must be a 64-character hex string');
        settings.turnstile_secret_key = value;
        break;
      case 'turnstile_site_key':
        if (value.length > 100) invalid(row.key, 'must not exceed 100 characters');
        settings.turnstile_site_key = value;
        break;
    }
  }

  return settings;
}

// Secrets such as the Turnstile secret key stay in the database for the Worker
// only; they are never served publicly. The site key is public by design.
function stripPrivateSettings(settings: PublicSettings): Record<string, unknown> {
  const { turnstile_secret_key: _secretKey, ...publicSettings } = settings;
  return publicSettings;
}

export async function handlePublicSettingsRequest(request: Request, env: { DB: D1Database }): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  try {
    const settings = await loadPublicSettings(env.DB);
    return Response.json(stripPrivateSettings(settings), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return Response.json({ message: error.message }, { status: 500 });
    }
    throw error;
  }
}