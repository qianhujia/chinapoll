import {
  DEFAULT_PUBLIC_SETTINGS,
  HERO_BACKGROUND_COLOR_PATTERN,
  PUBLISH_REPOSITORY_PATTERN,
  RATE_LIMIT_PATTERN
} from '../../worker/api/settings.js';

export type SettingKey = keyof typeof DEFAULT_PUBLIC_SETTINGS;

export const SETTING_KEYS = Object.keys(DEFAULT_PUBLIC_SETTINGS) as SettingKey[];

// Settings that must never be returned in full through the admin API.
export const SECRET_SETTING_KEYS: ReadonlyArray<SettingKey> = ['github_token'];

export type SettingValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_PUBLIC_SETTINGS, value);
}

// Validates a setting value against the same rules the public endpoint enforces so the
// dashboard and the CLI cannot drift apart from the Worker contract.
export function validateSettingValue(key: string, value: string): SettingValidationResult {
  if (!isSettingKey(key)) {
    return { ok: false, error: `Unknown setting key "${key}". Known keys: ${SETTING_KEYS.join(', ')}.` };
  }

  switch (key) {
    case 'default_locale':
      if (value !== 'en' && value !== 'zh-CN' && value !== 'zh-TW') return { ok: false, error: 'default_locale must be "en", "zh-CN", or "zh-TW".' };
      break;
    case 'site_name':
      if (!value.trim() || value.length > 100) return { ok: false, error: 'site_name must contain 1 to 100 characters.' };
      break;
    case 'site_slogan':
      if (value.length > 300) return { ok: false, error: 'site_slogan must not exceed 300 characters.' };
      break;
    case 'data_repository_url':
      if (value && !value.startsWith('https://')) return { ok: false, error: 'data_repository_url must be an HTTPS URL or empty.' };
      break;
    case 'polls_per_page':
    case 'comments_per_page':
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
        return { ok: false, error: `${key} must be an integer from 1 to 100.` };
      }
      break;
    case 'page_max_width_px':
      if (!/^\d+$/.test(value) || Number(value) < 100 || Number(value) > 9999) {
        return { ok: false, error: 'page_max_width_px must be an integer from 100 to 9999.' };
      }
      break;
    case 'vote_rate_limit':
    case 'comment_rate_limit':
    case 'proposal_rate_limit':
    case 'report_rate_limit':
    case 'login_rate_limit':
    case 'register_rate_limit':
    case 'ai_rate_limit': {
      const normalized = value.trim().toLowerCase();
      if (!RATE_LIMIT_PATTERN.test(normalized)) {
        return { ok: false, error: `${key} must be in format "N/w|d|h|m|s" (e.g., "5/h", "3/h", "1/d").` };
      }
      return { ok: true, value: normalized };
    }
    case 'user_poll_delay_hours':
    case 'user_comment_delay_hours':
      if (!/^\d+$/.test(value) || Number(value) > 8760) {
        return { ok: false, error: `${key} must be an integer from 0 to 8760.` };
      }
      break;
    case 'max_accounts_per_ip':
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) {
        return { ok: false, error: 'max_accounts_per_ip must be an integer from 1 to 1000.' };
      }
      break;
    case 'login_max_failed_attempts':
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
        return { ok: false, error: 'login_max_failed_attempts must be an integer from 1 to 100.' };
      }
      break;
    case 'login_lock_minutes':
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1440) {
        return { ok: false, error: 'login_lock_minutes must be an integer from 1 to 1440.' };
      }
      break;
    case 'hero_title':
      if (!value.trim() || value.length > 200) return { ok: false, error: 'hero_title must contain 1 to 200 characters.' };
      break;
    case 'hero_subtitle':
      if (value.length > 500) return { ok: false, error: 'hero_subtitle must not exceed 500 characters.' };
      break;
    case 'hero_background_color':
      if (value && !HERO_BACKGROUND_COLOR_PATTERN.test(value)) {
        return { ok: false, error: 'hero_background_color must be a CSS color (hex, rgb/a, hsl/a, or named) or a CSS gradient.' };
      }
      break;
    case 'read_only_mode':
    case 'login_badge_enable':
    case 'auto_approve_polls':
    case 'ai_enable':
    case 'ai_auto_categorise':
    case 'publish_enable':
      if (value !== 'true' && value !== 'false') return { ok: false, error: `${key} must be "true" or "false".` };
      break;
    case 'publish_repository':
      if (value && !PUBLISH_REPOSITORY_PATTERN.test(value)) {
        return { ok: false, error: 'publish_repository must be "owner/name" or empty.' };
      }
      break;
    case 'publish_branch':
      if (!value.trim() || value.length > 100 || /\s/.test(value)) {
        return { ok: false, error: 'publish_branch must be a branch name of 1 to 100 characters without whitespace.' };
      }
      break;
    case 'publish_path':
      if (value.length > 200 || /\s/.test(value)) {
        return { ok: false, error: 'publish_path must be a repository path of at most 200 characters without whitespace.' };
      }
      break;
    case 'github_token':
      if (value && (value.length < 64 || /\s/.test(value))) {
        return { ok: false, error: 'github_token must be a token of at least 64 characters.' };
      }
      break;
    case 'ai_model':
      if (!value.trim() || value.length > 100) return { ok: false, error: 'ai_model must contain 1 to 100 characters.' };
      break;
    case 'min_votes_to_display':
      if (!/^\d+$/.test(value) || Number(value) > 1000) {
        return { ok: false, error: 'min_votes_to_display must be an integer from 0 to 1000.' };
      }
      break;
    case 'min_views_to_display':
      if (!/^\d+$/.test(value) || Number(value) > 1000) {
        return { ok: false, error: 'min_views_to_display must be an integer from 0 to 1000.' };
      }
      break;
    case 'report_auto_hide_threshold':
      if (!/^\d+$/.test(value) || Number(value) > 1000) {
        return { ok: false, error: 'report_auto_hide_threshold must be an integer from 0 to 1000.' };
      }
      break;
    case 'report_auto_hide_priority_threshold':
      if (!/^\d+$/.test(value) || Number(value) > 1000) {
        return { ok: false, error: 'report_auto_hide_priority_threshold must be an integer from 0 to 1000.' };
      }
      break;
  }

  return { ok: true, value };
}

// Returns a copy of the value safe to surface in API responses.
export function maskSettingValue(key: string, value: string | null): string | null {
  if (value === null) return null;
  if (SECRET_SETTING_KEYS.includes(key as SettingKey)) {
    return value ? '••••••••' : '';
  }
  return value;
}
