import { fetchJson } from './lib/poll';

export interface PublicSettings {
  default_locale: 'en' | 'zh-CN';
  site_name: string;
  site_slogan: string;
  data_repository_url: string;
  polls_per_page: number;
  comments_per_page: number;
  page_max_width_px: number;
}

const defaultSettings: PublicSettings = {
  default_locale: 'en',
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  data_repository_url: 'https://github.com/qianhujia/chinapoll-data',
  polls_per_page: 15,
  comments_per_page: 30,
  page_max_width_px: 960
};

let publicSettings = defaultSettings;

export async function loadPublicSettings(): Promise<PublicSettings> {
  const result = await fetchJson<PublicSettings>('/api/settings/public');
  if (result.default_locale !== 'en' && result.default_locale !== 'zh-CN'
    || typeof result.site_name !== 'string'
    || typeof result.site_slogan !== 'string'
    || typeof result.data_repository_url !== 'string'
    || !Number.isSafeInteger(result.polls_per_page) || result.polls_per_page < 1 || result.polls_per_page > 100
    || !Number.isSafeInteger(result.comments_per_page) || result.comments_per_page < 1 || result.comments_per_page > 100
    || !Number.isSafeInteger(result.page_max_width_px) || result.page_max_width_px < 100 || result.page_max_width_px > 9999) {
    throw new Error('Invalid public settings response.');
  }
  publicSettings = result;
  return publicSettings;
}

export function getPublicSettings(): PublicSettings {
  return publicSettings;
}
