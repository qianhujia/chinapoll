import { fetchJson } from './lib/poll';
import { readBootstrap } from './bootstrap';

export interface PublicSettings {
  default_locale: 'en' | 'zh-CN' | 'zh-TW';
  site_name: string;
  site_slogan: string;
  data_repository_url: string;
  logo: string;
  favicon: string;
  polls_per_page: number;
  comments_per_page: number;
  page_max_width_px: number;
  hero_title: string;
  hero_subtitle: string;
  hero_background_color: string;
  read_only_mode: boolean;
  turnstile_enable: boolean;
  turnstile_site_key: string;
  login_badge_enable: boolean;
  auto_approve_polls: boolean;
  user_poll_delay_minutes: number;
  user_comment_delay_minutes: number;
  max_accounts_per_ip: number;
  login_max_failed_attempts: number;
  login_lock_minutes: number;
  login_rate_limit: string;
  register_rate_limit: string;
  report_rate_limit: string;
  ai_enable: boolean;
  min_votes_to_display: number;
  min_views_to_display: number;
  report_auto_hide_threshold: number;
  report_auto_hide_priority_threshold: number;
}

const defaultSettings: PublicSettings = {
  default_locale: 'en',
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  data_repository_url: '',
  logo: '',
  favicon: '',
  polls_per_page: 15,
  comments_per_page: 30,
  page_max_width_px: 960,
  hero_title: '',
  hero_subtitle: '',
  hero_background_color: '',
  read_only_mode: false,
  turnstile_enable: false,
  turnstile_site_key: '',
  login_badge_enable: false,
  auto_approve_polls: false,
  user_poll_delay_minutes: 10,
  user_comment_delay_minutes: 10,
  max_accounts_per_ip: 4,
  login_max_failed_attempts: 5,
  login_lock_minutes: 15,
  login_rate_limit: '10/h',
  register_rate_limit: '5/d',
  report_rate_limit: '3/d',
  ai_enable: false,
  min_votes_to_display: 10,
  min_views_to_display: 20,
  report_auto_hide_threshold: 5,
  report_auto_hide_priority_threshold: 2
};

let publicSettings = defaultSettings;

// Validation shared by the bootstrap island and the API response, so a malformed
// payload from either source is rejected instead of reaching the UI.
export function isValidPublicSettings(value: unknown): value is PublicSettings {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as PublicSettings;
  return (result.default_locale === 'en' || result.default_locale === 'zh-CN' || result.default_locale === 'zh-TW')
    && typeof result.site_name === 'string'
    && typeof result.site_slogan === 'string'
    && typeof result.data_repository_url === 'string'
    && typeof result.logo === 'string'
    && typeof result.favicon === 'string'
    && Number.isSafeInteger(result.polls_per_page) && result.polls_per_page >= 1 && result.polls_per_page <= 100
    && Number.isSafeInteger(result.comments_per_page) && result.comments_per_page >= 1 && result.comments_per_page <= 100
    && Number.isSafeInteger(result.page_max_width_px) && result.page_max_width_px >= 100 && result.page_max_width_px <= 9999
    && typeof result.hero_title === 'string'
    && typeof result.hero_subtitle === 'string'
    && typeof result.hero_background_color === 'string'
    && typeof result.read_only_mode === 'boolean'
    && typeof result.turnstile_enable === 'boolean'
    && typeof result.turnstile_site_key === 'string'
    && typeof result.login_badge_enable === 'boolean'
    && typeof result.auto_approve_polls === 'boolean'
    && Number.isSafeInteger(result.user_poll_delay_minutes) && result.user_poll_delay_minutes >= 0
    && Number.isSafeInteger(result.user_comment_delay_minutes) && result.user_comment_delay_minutes >= 0
    && Number.isSafeInteger(result.max_accounts_per_ip) && result.max_accounts_per_ip >= 1
    && Number.isSafeInteger(result.login_max_failed_attempts) && result.login_max_failed_attempts >= 1
    && Number.isSafeInteger(result.login_lock_minutes) && result.login_lock_minutes >= 1
    && typeof result.login_rate_limit === 'string'
    && typeof result.register_rate_limit === 'string'
    && typeof result.report_rate_limit === 'string'
    && typeof result.ai_enable === 'boolean'
    && Number.isSafeInteger(result.min_votes_to_display) && result.min_votes_to_display >= 0
    && Number.isSafeInteger(result.min_views_to_display) && result.min_views_to_display >= 0
    && Number.isSafeInteger(result.report_auto_hide_threshold) && result.report_auto_hide_threshold >= 0
    && Number.isSafeInteger(result.report_auto_hide_priority_threshold) && result.report_auto_hide_priority_threshold >= 0;
}

export async function loadPublicSettings(): Promise<PublicSettings> {
  // The document may already carry the settings (see ./bootstrap). The Worker
  // builds them from the same stored rows and the same Turnstile environment as
  // the endpoint, and they pass the validation below, so using them removes the
  // /api/settings/public request on the first load.
  const embedded = readBootstrap()?.settings;
  if (embedded && isValidPublicSettings(embedded)) {
    publicSettings = embedded;
    return publicSettings;
  }

  const result: unknown = await fetchJson('/api/settings/public');
  if (!isValidPublicSettings(result)) {
    throw new Error('Invalid public settings response.');
  }
  publicSettings = result;
  return publicSettings;
}

export function getPublicSettings(): PublicSettings {
  return publicSettings;
}
