import { handleProposalRequest } from './api/proposal';
import { handleStatsRequest } from './api/stats';
import { handleVoteRequest, handleVoteStatusRequest } from './api/vote';
import { handleCommentsRequest } from './api/comments';
import { handlePollsRequest } from './api/polls';
import { handlePublicSettingsRequest } from './api/settings';
import { handleAuthRequest } from './api/auth';
import { handleUserRequest } from './api/user';

export interface Env {
  DB: D1Database;
}

interface PublicSettings {
  default_locale: string;
  site_name: string;
  site_slogan: string;
  data_repository_url: string;
  polls_per_page: number;
  comments_per_page: number;
  page_max_width_px: number;
  vote_rate_limit: string;
  comment_rate_limit: string;
  proposal_rate_limit: string;
  hero_title: string;
  hero_subtitle: string;
  hero_background_color: string;
  read_only_mode: boolean;
  turnstile_secret_key: string;
  turnstile_enable: boolean;
  login_badge_enable: boolean;
  auto_approve_polls: boolean;
  user_poll_delay_hours: number;
  user_comment_delay_hours: number;
  max_accounts_per_ip: number;
  login_max_failed_attempts: number;
  login_lock_minutes: number;
  login_rate_limit: string;
  register_rate_limit: string;
}

async function getPublicSettings(db: D1Database): Promise<PublicSettings> {
  const keys = [
    'default_locale', 'site_name', 'site_slogan', 'data_repository_url',
    'polls_per_page', 'comments_per_page', 'page_max_width_px',
    'vote_rate_limit', 'comment_rate_limit', 'proposal_rate_limit',
    'hero_title', 'hero_subtitle', 'hero_background_color',
    'read_only_mode', 'turnstile_secret_key', 'turnstile_enable', 'login_badge_enable', 'auto_approve_polls',
    'user_poll_delay_hours', 'user_comment_delay_hours', 'max_accounts_per_ip',
    'login_max_failed_attempts', 'login_lock_minutes', 'login_rate_limit', 'register_rate_limit'
  ];
  const placeholders = keys.map(() => '?').join(', ');
  const result = await db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`
  ).bind(...keys).all<{ key: string; value: string | null }>();

  const settings = { ...DEFAULT_PUBLIC_SETTINGS };
  for (const row of result.results ?? []) {
    if (row.value === null) continue;
    switch (row.key) {
      case 'default_locale':
        settings.default_locale = row.value;
        break;
      case 'site_name':
        settings.site_name = row.value;
        break;
      case 'site_slogan':
        settings.site_slogan = row.value;
        break;
      case 'data_repository_url':
        settings.data_repository_url = row.value;
        break;
      case 'polls_per_page':
      case 'comments_per_page':
      case 'page_max_width_px':
      case 'user_poll_delay_hours':
      case 'user_comment_delay_hours':
      case 'max_accounts_per_ip':
      case 'login_max_failed_attempts':
      case 'login_lock_minutes':
        settings[row.key] = Number(row.value);
        break;
      case 'vote_rate_limit':
      case 'comment_rate_limit':
      case 'proposal_rate_limit':
      case 'login_rate_limit':
      case 'register_rate_limit':
        settings[row.key] = row.value.trim().toLowerCase();
        break;
      case 'hero_title':
        settings.hero_title = row.value;
        break;
      case 'hero_subtitle':
        settings.hero_subtitle = row.value;
        break;
      case 'hero_background_color':
        settings.hero_background_color = row.value;
        break;
      case 'read_only_mode':
        settings.read_only_mode = row.value === 'true';
        break;
      case 'login_badge_enable':
        settings.login_badge_enable = row.value === 'true';
        break;
      case 'auto_approve_polls':
        settings.auto_approve_polls = row.value === 'true';
        break;
      case 'turnstile_secret_key':
        settings.turnstile_secret_key = row.value;
        break;
      case 'turnstile_enable':
        settings.turnstile_enable = row.value === 'true';
        break;
    }
  }
  return settings;
}

// Default settings (matching DEFAULT_PUBLIC_SETTINGS from settings.ts)
const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
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
  turnstile_enable: false,
  login_badge_enable: false,
  auto_approve_polls: false,
  user_poll_delay_hours: 48,
  user_comment_delay_hours: 24,
  max_accounts_per_ip: 4,
  login_max_failed_attempts: 5,
  login_lock_minutes: 15,
  login_rate_limit: '10/h',
  register_rate_limit: '5/d'
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Fetch public settings from database
    const settings = await getPublicSettings(env.DB);

    // Merge settings into env for handlers
    const envWithSettings = {
      ...env,
      ...settings
    };

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true, status: 'healthy' }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    if (url.pathname === '/api/settings/public') {
      return handlePublicSettingsRequest(request, envWithSettings);
    }

    if (url.pathname.startsWith('/api/stats/')) {
      return handleStatsRequest(request, url, envWithSettings);
    }

    if (url.pathname === '/api/polls' || url.pathname.startsWith('/api/polls/')) {
      return handlePollsRequest(request, url, envWithSettings);
    }

    if (url.pathname === '/api/comments' || url.pathname.startsWith('/api/comments/')) {
      return handleCommentsRequest(request, url, envWithSettings);
    }

    if (url.pathname === '/api/vote') {
      return handleVoteRequest(request, envWithSettings);
    }

    if (url.pathname === '/api/vote/status') {
      return handleVoteStatusRequest(request, envWithSettings);
    }

    if (url.pathname === '/api/proposal') {
      return handleProposalRequest(request, envWithSettings);
    }

    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return handleAuthRequest(request, url, envWithSettings);
    }

    if (url.pathname.startsWith('/api/user/')) {
      return handleUserRequest(request, url, envWithSettings);
    }

    return new Response('Not found', { status: 404 });
  }
} satisfies ExportedHandler<Env>;
