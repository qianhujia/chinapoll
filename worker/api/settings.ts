interface SettingsEnv {
  DB: D1Database;
}

interface SettingRow {
  key: string;
  value: string | null;
}

// Rate limits use the "<count>/<unit>" format where unit is one of w, d, h, m, s.
export const RATE_LIMIT_PATTERN = /^\d+\/[wdhms]$/;

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
  hero_title: 'Continuous polls · Fully anonymous · Openly auditable',
  hero_subtitle: 'No login required to vote yes/no/neutral on open polls.',
  hero_background_color: '',
  read_only_mode: false,
  turnstile_secret_key: '',
  turnstile_enable: false
};

const publicSettingKeys = Object.keys(DEFAULT_PUBLIC_SETTINGS);

export async function handlePublicSettingsRequest(request: Request, env: SettingsEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  const placeholders = publicSettingKeys.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`
  ).bind(...publicSettingKeys).all<SettingRow>();

  const settings = { ...DEFAULT_PUBLIC_SETTINGS };
  for (const row of result.results ?? []) {
    if (row.value === null) {
      return Response.json({ message: `setting "${row.key}" must have a value` }, { status: 500 });
    }

    switch (row.key) {
      case 'default_locale':
        if (row.value !== 'en' && row.value !== 'zh-CN') {
          return Response.json({ message: 'setting "default_locale" must be "en" or "zh-CN"' }, { status: 500 });
        }
        settings.default_locale = row.value;
        break;
      case 'site_name':
        if (!row.value.trim() || row.value.length > 100) {
          return Response.json({ message: 'setting "site_name" must contain 1 to 100 characters' }, { status: 500 });
        }
        settings.site_name = row.value;
        break;
      case 'site_slogan':
        if (row.value.length > 300) {
          return Response.json({ message: 'setting "site_slogan" must not exceed 300 characters' }, { status: 500 });
        }
        settings.site_slogan = row.value;
        break;
      case 'data_repository_url':
        if (row.value && !isHttpsUrl(row.value)) {
          return Response.json({ message: 'setting "data_repository_url" must be an HTTPS URL or empty' }, { status: 500 });
        }
        settings.data_repository_url = row.value;
        break;
      case 'polls_per_page':
      case 'comments_per_page':
        if (!/^\d+$/.test(row.value) || Number(row.value) < 1 || Number(row.value) > 100) {
          return Response.json({ message: `setting "${row.key}" must be an integer from 1 to 100` }, { status: 500 });
        }
        settings[row.key] = Number(row.value);
        break;
      case 'page_max_width_px':
        if (!/^\d+$/.test(row.value) || Number(row.value) < 100 || Number(row.value) > 9999) {
          return Response.json({ message: 'setting "page_max_width_px" must be an integer from 100 to 9999' }, { status: 500 });
        }
        settings.page_max_width_px = Number(row.value);
        break;
      case 'vote_rate_limit':
      case 'comment_rate_limit':
      case 'proposal_rate_limit': {
        const normalized = row.value.trim().toLowerCase();
        // An invalid value falls back to the default so one bad setting cannot break the public endpoint.
        if (RATE_LIMIT_PATTERN.test(normalized)) {
          settings[row.key] = normalized;
        }
        break;
      }
      case 'hero_title':
        if (!row.value.trim() || row.value.length > 200) {
          return Response.json({ message: 'setting "hero_title" must contain 1 to 200 characters' }, { status: 500 });
        }
        settings.hero_title = row.value;
        break;
      case 'hero_subtitle':
        if (row.value.length > 500) {
          return Response.json({ message: 'setting "hero_subtitle" must not exceed 500 characters' }, { status: 500 });
        }
        settings.hero_subtitle = row.value;
        break;
      case 'hero_background_color':
        if (row.value && !HERO_BACKGROUND_COLOR_PATTERN.test(row.value)) {
          return Response.json({ message: 'setting "hero_background_color" must be a CSS color (hex, rgb/a, hsl/a, or named) or a CSS gradient' }, { status: 500 });
        }
        settings.hero_background_color = row.value;
        break;
      case 'read_only_mode':
        if (row.value !== 'true' && row.value !== 'false') {
          return Response.json({ message: 'setting "read_only_mode" must be "true" or "false"' }, { status: 500 });
        }
        settings.read_only_mode = row.value === 'true';
        break;
      case 'turnstile_secret_key':
        if (row.value && !/^[0-9a-f]{64}$/i.test(row.value)) {
          return Response.json({ message: 'setting "turnstile_secret_key" must be a 64-character hex string' }, { status: 500 });
        }
        settings.turnstile_secret_key = row.value;
        break;
      case 'turnstile_enable':
        if (row.value !== 'true' && row.value !== 'false') {
          return Response.json({ message: 'setting "turnstile_enable" must be "true" or "false"' }, { status: 500 });
        }
        settings.turnstile_enable = row.value === 'true';
        break;
    }
  }

  return Response.json(stripPrivateSettings(settings), {
    headers: { 'cache-control': 'no-store' }
  });
}

// Secrets such as the Turnstile key stay in the database for the Worker only; they are never served publicly.
function stripPrivateSettings(settings: typeof DEFAULT_PUBLIC_SETTINGS): Record<string, unknown> {
  const { turnstile_secret_key: _secretKey, ...publicSettings } = settings;
  return publicSettings;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
