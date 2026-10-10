import {
  DEFAULT_PUBLIC_SETTINGS,
  HERO_BACKGROUND_COLOR_PATTERN,
  RATE_LIMIT_PATTERN
} from '../../worker/api/settings.js';

export type SettingKey = keyof typeof DEFAULT_PUBLIC_SETTINGS;

export const SETTING_KEYS = Object.keys(DEFAULT_PUBLIC_SETTINGS) as SettingKey[];

// Settings that must never be returned in full through the admin API.
export const SECRET_SETTING_KEYS: ReadonlyArray<SettingKey> = ['turnstile_secret_key'];

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
      if (value !== 'en' && value !== 'zh-CN') return { ok: false, error: 'default_locale must be "en" or "zh-CN".' };
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
    case 'proposal_rate_limit': {
      const normalized = value.trim().toLowerCase();
      if (!RATE_LIMIT_PATTERN.test(normalized)) {
        return { ok: false, error: `${key} must be in format "N/w|d|h|m|s" (e.g., "5/h", "3/h", "1/d").` };
      }
      return { ok: true, value: normalized };
    }
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
    case 'turnstile_enable':
      if (value !== 'true' && value !== 'false') return { ok: false, error: `${key} must be "true" or "false".` };
      break;
    case 'turnstile_secret_key':
      if (value && !/^[0-9a-f]{64}$/i.test(value)) {
        return { ok: false, error: 'turnstile_secret_key must be a 64-character hex string.' };
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
