import { fetchJson } from './lib/poll';

export interface PublicSettings {
  default_locale: 'en' | 'zh-CN';
  site_name: string;
  site_slogan: string;
  data_repository_url: string;
  polls_per_page: number;
  comments_per_page: number;
  page_max_width_px: number;
  hero_title: string;
  hero_subtitle: string;
  hero_background_color: string;
  read_only_mode: boolean;
  turnstile_enable: boolean;
}

const defaultSettings: PublicSettings = {
  default_locale: 'en',
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  data_repository_url: 'https://github.com/qianhujia/chinapoll-data',
  polls_per_page: 15,
  comments_per_page: 30,
  page_max_width_px: 960,
  hero_title: '',
  hero_subtitle: '',
  hero_background_color: '',
  read_only_mode: false,
  turnstile_enable: false
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
    || !Number.isSafeInteger(result.page_max_width_px) || result.page_max_width_px < 100 || result.page_max_width_px > 9999
    || typeof result.hero_title !== 'string'
    || typeof result.hero_subtitle !== 'string'
    || typeof result.hero_background_color !== 'string'
    || typeof result.read_only_mode !== 'boolean'
    || typeof result.turnstile_enable !== 'boolean') {
    throw new Error('Invalid public settings response.');
  }
  publicSettings = result;
  return publicSettings;
}

export function getPublicSettings(): PublicSettings {
  return publicSettings;
}
