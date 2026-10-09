interface SettingsEnv {
  DB: D1Database;
}

interface SettingRow {
  key: string;
  value: string | null;
}

export const DEFAULT_PUBLIC_SETTINGS = {
  default_locale: 'en',
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  data_repository_url: 'https://github.com/qianhujia/chinapoll-data',
  polls_per_page: 15,
  comments_per_page: 30,
  page_max_width_px: 960
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
    }
  }

  return Response.json(settings, {
    headers: { 'cache-control': 'no-store' }
  });
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
