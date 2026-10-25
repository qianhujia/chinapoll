// Public application settings: defaults, validation, and the single loader used
// by both the request router and the public settings endpoint.

import { isTurnstileEnabled, turnstileSiteKey, type TurnstileEnv } from '../services/turnstile';
import { apiError } from '../../shared/http';
import { imageDataUriExtension, imageSettingError, type AiProvider } from '../../shared/settings';

interface SettingRow {
  key: string;
  value: string | null;
  updated_at: number | null;
}

// Rate limits use the "<count>/<unit>" format where unit is one of w, d, h, m, s.
// The capture groups are required by parseRateLimit.
export const RATE_LIMIT_PATTERN = /^(\d+)\/([wdhms])$/;

// Hero background accepts a CSS color (hex, rgb/a, hsl/a, named) or a CSS gradient.
export const HERO_BACKGROUND_COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\)|[a-z]+|(?:linear|radial)-gradient\(.+\))$/i;

// A GitHub repository selector in `owner/name` form.
export const PUBLISH_REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export const DEFAULT_PUBLIC_SETTINGS = {
  default_locale: 'en',
  site_name: 'ChinaPoll',
  site_slogan: 'Public opinion made visible',
  data_repository_url: 'https://github.com/qianhujia/chinapoll-data',
  // Branding images, stored as base64 data URIs so the public site renders them
  // without a separate asset pipeline. Empty falls back to the site wordmark and
  // the default browser favicon request.
  logo: '',
  favicon: '',
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
  // Shows an "optional" badge next to the login link in the site navigation when
  // true, making clear that signing in is not required.
  login_badge_enable: false,
  // When true, submitted polls are published immediately; when false they stay
  // pending until an admin approves them.
  auto_approve_polls: false,
  // Account gating and authentication limits. Delay values are whole minutes;
  // "N/w|d|h|m|s" values use the shared rate-limit format.
  user_poll_delay_minutes: 10,
  user_comment_delay_minutes: 10,
  max_accounts_per_ip: 4,
  login_max_failed_attempts: 5,
  login_lock_minutes: 15,
  login_rate_limit: '10/h',
  register_rate_limit: '5/d',
  // Vote totals below this number are hidden until the poll gathers more votes.
  min_votes_to_display: 10,
  // View totals below this number are hidden until the poll gathers more views,
  // so a poll with a couple of views and one vote cannot be used to guess a voter.
  min_views_to_display: 20,
  // Automatic protection: a poll is hidden for review once it collects this many
  // open reports in total, or this many open reports with a high-priority reason.
  // Setting a threshold to 0 disables that rule.
  report_auto_hide_threshold: 5,
  report_auto_hide_priority_threshold: 2,
  // Optional AI assistance. The provider is off by default, so the /api/ai
  // endpoints answer 404 and the frontend hides the buttons. `ai_enable` is a
  // derived compatibility flag for the public payload (see loadPublicSettings);
  // a legacy stored `ai_enable` row only selects Workers AI when no provider row
  // exists yet. The endpoint URL, key, model, and rate limit stay private.
  ai_enable: false,
  ai_provider: 'off' as AiProvider,
  ai_api_url: '',
  ai_api_key: '',
  ai_model: '@cf/qwen/qwen3-30b-a3b-fp8',
  ai_rate_limit: '10/h',
  // When true (and AI is on), a submitted poll that did not choose a topic is
  // assigned a topic by the model. Admin only; never served publicly.
  ai_auto_topic: false,
  // Admin-defined instructions for reviewing a submission when auto-approval is
  // on. An empty prompt means every submission is approved immediately. Admin
  // only; never served publicly.
  ai_review_prompt: '',
  // Public audit publishing. When enabled, the hourly maintenance run copies the
  // signed snapshot chain to a data repository through the GitHub API. These
  // settings are private: none of them is served by the public settings
  // endpoint, and `github_token` is a secret read by the Worker only.
  publish_enable: false,
  publish_repository: '',
  publish_branch: 'main',
  publish_path: 'snapshots',
  github_token: ''
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
// A branding value as the public pages use it. An uploaded image is served by the
// image endpoint as /image/<key>.<extension>, versioned with the row's update time
// so a replaced image is a new URL; a pasted https URL is used as-is.
function resolveBrandingValue(key: string, value: string, updatedAt: number | null): string {
  if (!value) return '';
  if (!value.startsWith('data:')) return value;
  const version = updatedAt ? `?v=${updatedAt}` : '';
  return `/image/${key}.${imageDataUriExtension(value)}${version}`;
}

// Loads and validates every public setting in one pass. Missing rows keep their
// default; a malformed stored value raises SettingsValidationError.
export async function loadPublicSettings(db: D1Database): Promise<PublicSettings> {
  const placeholders = publicSettingKeys.map(() => '?').join(', ');
  const result = await db.prepare(
    `SELECT key, value, updated_at FROM settings WHERE key IN (${placeholders})`
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
      case 'logo':
      case 'favicon': {
        if (value) {
          const error = imageSettingError(value);
          if (error) invalid(row.key, error);
        }
        (settings as Record<string, unknown>)[row.key] = resolveBrandingValue(row.key, value, row.updated_at);
        break;
      }
      case 'polls_per_page':
      case 'comments_per_page':
        if (!isInteger(value, 1, 100)) invalid(row.key, 'must be an integer from 1 to 100');
        (settings as Record<string, unknown>)[row.key] = Number(value);
        break;
      case 'page_max_width_px':
        if (!isInteger(value, 100, 9999)) invalid(row.key, 'must be an integer from 100 to 9999');
        settings.page_max_width_px = Number(value);
        break;
      case 'user_poll_delay_minutes':
      case 'user_comment_delay_minutes':
        if (!isInteger(value, 0, 525600)) invalid(row.key, 'must be an integer from 0 to 525600');
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
      case 'min_views_to_display':
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
      case 'register_rate_limit':
      case 'ai_rate_limit': {
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
      case 'ai_enable':
      case 'ai_auto_topic':
      case 'publish_enable':
      case 'read_only_mode':
        if (value !== 'true' && value !== 'false') invalid(row.key, 'must be "true" or "false"');
        (settings as Record<string, unknown>)[row.key] = value === 'true';
        break;
      case 'publish_repository':
        if (value && !PUBLISH_REPOSITORY_PATTERN.test(value)) {
          invalid(row.key, 'must be "owner/name" or empty');
        }
        settings.publish_repository = value;
        break;
      case 'publish_branch':
        if (!value.trim() || value.length > 100 || /\s/.test(value)) {
          invalid(row.key, 'must be a branch name of 1 to 100 characters without whitespace');
        }
        settings.publish_branch = value;
        break;
      case 'publish_path':
        if (value.length > 200 || /\s/.test(value)) {
          invalid(row.key, 'must be a repository path of at most 200 characters without whitespace');
        }
        settings.publish_path = value;
        break;
      case 'github_token':
        if (value && (value.length < 64 || /\s/.test(value))) {
          invalid(row.key, 'must be a token of at least 64 characters');
        }
        settings.github_token = value;
        break;
      case 'ai_provider':
        if (value !== 'off' && value !== 'cloudflare' && value !== 'openai_compatible') {
          invalid(row.key, 'must be "off", "cloudflare", or "openai_compatible"');
        }
        settings.ai_provider = value;
        break;
      case 'ai_api_url': {
        const url = value.trim();
        if (url && !isHttpsUrl(url)) invalid(row.key, 'must be an HTTPS URL or empty');
        settings.ai_api_url = url;
        break;
      }
      case 'ai_api_key':
        if (value.length > 500) invalid(row.key, 'must not exceed 500 characters');
        settings.ai_api_key = value;
        break;
      case 'ai_model':
        if (!value.trim() || value.length > 100) invalid(row.key, 'must contain 1 to 100 characters');
        settings.ai_model = value;
        break;
      case 'ai_review_prompt':
        if (value.length > 4000) invalid(row.key, 'must not exceed 4000 characters');
        settings.ai_review_prompt = value;
        break;
    }
  }

  // Compatibility with an existing installation: before the provider dropdown
  // existed, `ai_enable = true` meant Workers AI. If no provider row has been
  // written yet, that legacy flag selects Workers AI. The public flag is always
  // derived from the provider, so the frontend keeps its single boolean check.
  const hasProviderRow = (result.results ?? []).some((row) => row.key === 'ai_provider');
  if (!hasProviderRow && settings.ai_enable === true) settings.ai_provider = 'cloudflare';
  settings.ai_enable = settings.ai_provider !== 'off';

  return settings;
}

// Secrets stay in the database for the Worker only; they are never served
// publicly. The derived `ai_enable` flag is public because the frontend needs it
// to show or hide the AI buttons; the provider, endpoint URL, API key, model,
// rate limit, publish settings, and GitHub token stay private. Turnstile is not
// a setting at all: the site key and the enabled flag are derived from the
// Worker environment and merged in by the handler below.
function stripPrivateSettings(settings: PublicSettings): Record<string, unknown> {
  const {
    ai_provider: _aiProvider,
    ai_api_url: _aiApiUrl,
    ai_api_key: _aiApiKey,
    ai_model: _aiModel,
    ai_rate_limit: _aiRateLimit,
    ai_auto_topic: _aiAutoTopic,
    ai_review_prompt: _aiReviewPrompt,
    publish_enable: _publishEnable,
    publish_repository: _publishRepository,
    publish_branch: _publishBranch,
    publish_path: _publishPath,
    github_token: _githubToken,
    ...publicSettings
  } = settings;
  return publicSettings;
}

// The JSON payload `GET /api/settings/public` answers with, and the settings the
// bootstrap island embeds. Building it in one place keeps the server-rendered
// document and the API from drifting apart.
export function publicSettingsPayload(
  settings: PublicSettings,
  env: TurnstileEnv
): Record<string, unknown> {
  // Turnstile is configured through environment variables instead of the
  // settings table, so the two fields the frontend needs are derived here and
  // are read-only: they change only when the Worker is redeployed.
  return {
    ...stripPrivateSettings(settings),
    turnstile_enable: isTurnstileEnabled(env),
    turnstile_site_key: turnstileSiteKey(env)
  };
}

export async function handlePublicSettingsRequest(
  request: Request,
  env: { DB: D1Database } & TurnstileEnv
): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 405);
  }

  try {
    const settings = await loadPublicSettings(env.DB);
    return Response.json(publicSettingsPayload(settings, env), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      // The stored value is logged, never returned: a settings error must not
      // leak the raw row or any other internal detail to the caller.
      console.error('public settings invalid', error.key, error.message);
      return apiError('INTERNAL_ERROR', 500);
    }
    throw error;
  }
}