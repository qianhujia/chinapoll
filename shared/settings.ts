// Settings schema: defines all settings with types, categories, validation, and UI hints.
// This is the single source of truth for settings metadata used by both the Worker
// and the admin dashboard. The actual stored values remain simple key-value strings
// in the `settings` table; this module only adds metadata for validation and UI.

export type SettingType =
  | 'string'
  // A multi-line text value, rendered as a textarea in the admin dashboard.
  | 'text'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'rate_limit'
  | 'url'
  | 'color'
  // An image is either an https URL the admin pasted or a base64 data URI
  // produced by an upload (see imageSettingError).
  | 'image';

// The model backend used by every AI feature. `off` disables the AI endpoints
// and the frontend buttons; the other values select the Workers AI binding or an
// OpenAI-compatible HTTP endpoint.
export type AiProvider = 'off' | 'cloudflare' | 'openai_compatible';

export type SettingCategory =
  | 'general'
  | 'appearance'
  | 'polls'
  | 'auth'
  | 'reports'
  | 'ai'
  | 'publishing'
  | 'advanced';

export interface SettingEnumOption {
  value: string;
  label: string;
}

export interface SettingSchema {
  key: string;
  type: SettingType;
  category: SettingCategory;
  label: string;
  description?: string;
  defaultValue: string | number | boolean;
  required?: boolean;
  min?: number;
  max?: number;
  enumOptions?: SettingEnumOption[];
  pattern?: string;
  secret?: boolean;
  public?: boolean;
}

// An image setting holds one of three things:
//
//   1. an empty string, meaning "no image configured",
//   2. an https URL the admin pasted, which the public pages use as-is, or
//   3. a base64 data URI produced by an upload, which the public Worker serves
//      from /image/<key>.<extension> so pages reference a short URL instead of
//      the payload.
//
// An uploaded payload is stored in the settings table, so its encoded length is
// capped well below the 2 MB D1 row limit. The accepted media types and the cap
// are shared by the admin validator and the public settings loader.
export const IMAGE_DATA_URI_PATTERN =
  /^data:image\/(png|jpeg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon|ico);base64,/;

export const IMAGE_DATA_URI_MAX_CHARS = 1_000_000;

// The file extension the public URL of an uploaded image uses. The extension is
// decorative: the response always carries the stored image's content type, so an
// unknown type still resolves, it just cannot name itself in the URL.
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/ico': 'ico'
};

// The extension for an uploaded image value, e.g. "png" for
// "data:image/png;base64,...". Falls back to "img" (see the note above).
export function imageDataUriExtension(value: string): string {
  const match = value.match(/^data:([\w.+-]+\/[\w.+-]+);base64,/);
  return match ? IMAGE_EXTENSIONS[match[1].toLowerCase()] ?? 'img' : 'img';
}

// Why an image setting value was rejected, or null when it is valid. The wording
// finishes the sentence "<label> <requirement>" in the admin validator and
// "setting <key> <requirement>" in the public settings loader.
export function imageSettingError(value: string): string | null {
  if (value.startsWith('data:')) {
    if (!IMAGE_DATA_URI_PATTERN.test(value)) {
      return 'must be a base64 image data URI (data:image/...;base64,...) or an https image URL';
    }
    if (value.length > IMAGE_DATA_URI_MAX_CHARS) {
      return `must not exceed ${IMAGE_DATA_URI_MAX_CHARS} characters once encoded`;
    }
    return null;
  }
  try {
    if (new URL(value).protocol === 'https:') return null;
  } catch {
    // Not a URL at all; fall through to the shared error below.
  }
  return 'must be an https image URL or an uploaded image';
}

// The unit suffixes a rate-limit value accepts. Shown in the admin dashboard next
// to every rate-limit field so an operator does not have to guess or consult the
// docs. The same set is enforced by RATE_LIMIT_PATTERN in worker/api/settings.ts.
export const RATE_LIMIT_UNITS_HELP =
  'Units: /s = per second, /m = per minute, /h = per hour, /d = per day, /w = per week.';

export const SETTING_SCHEMAS: SettingSchema[] = [
  // General
  {
    key: 'site_name',
    type: 'string',
    category: 'general',
    label: 'Site name',
    description: 'The name displayed in the header and page titles.',
    defaultValue: 'ChinaPoll',
    required: true,
    min: 1,
    max: 100,
    public: true,
  },
  {
    key: 'site_slogan',
    type: 'string',
    category: 'general',
    label: 'Site slogan',
    description: 'Short tagline shown on the home page and in meta tags.',
    defaultValue: 'Public opinion made visible',
    required: false,
    max: 300,
    public: true,
  },
  {
    key: 'default_locale',
    type: 'enum',
    category: 'general',
    label: 'Default language',
    description: 'The default language for the public site. Users can still switch languages.',
    defaultValue: 'en',
    required: true,
    enumOptions: [
      { value: 'en', label: 'English' },
      { value: 'zh-CN', label: '简体中文' },
      { value: 'zh-TW', label: '繁體中文' },
    ],
    public: true,
  },
  {
    key: 'data_repository_url',
    type: 'url',
    category: 'general',
    label: 'Data repository URL',
    description: 'Public link to the data repository (e.g., GitHub). Shown in the footer.',
    defaultValue: 'https://github.com/qianhujia/chinapoll-data',
    required: false,
    public: true,
  },

  // Appearance
  {
    key: 'logo',
    type: 'image',
    category: 'appearance',
    label: 'Logo',
    description: 'Logo shown in the header on every public page. Upload an image file (PNG, SVG, WebP) or paste an https image URL. An upload is stored in the database and served from /image/logo.<extension>.',
    defaultValue: '',
    required: false,
    public: true,
  },
  {
    key: 'favicon',
    type: 'image',
    category: 'appearance',
    label: 'Favicon',
    description: 'Favicon shown in browser tabs. Upload an image file (ICO, PNG, SVG) or paste an https image URL. An upload is stored in the database and served from /image/favicon.<extension>.',
    defaultValue: '',
    required: false,
    public: true,
  },
  {
    key: 'hero_title',
    type: 'string',
    category: 'appearance',
    label: 'Hero title',
    description: 'Main headline on the home page hero section.',
    defaultValue: 'Continuous polls · Anonymously cast · Openly auditable',
    required: true,
    min: 1,
    max: 200,
    public: true,
  },
  {
    key: 'hero_subtitle',
    type: 'string',
    category: 'appearance',
    label: 'Hero subtitle',
    description: 'Supporting text below the hero title.',
    defaultValue: 'Sign in to submit a poll or comment; votes stay anonymous.',
    required: false,
    max: 500,
    public: true,
  },
  {
    key: 'hero_background_color',
    type: 'color',
    category: 'appearance',
    label: 'Hero background color',
    description: 'CSS color or gradient for the hero section background. Leave empty for default.',
    defaultValue: '',
    required: false,
    public: true,
  },
  {
    key: 'page_max_width_px',
    type: 'integer',
    category: 'appearance',
    label: 'Page max width',
    description: 'Maximum content width in pixels.',
    defaultValue: 960,
    required: true,
    min: 100,
    max: 9999,
    public: true,
  },

  // Polls
  {
    key: 'polls_per_page',
    type: 'integer',
    category: 'polls',
    label: 'Polls per page',
    description: 'Number of polls shown per page on the home page and polls list.',
    defaultValue: 15,
    required: true,
    min: 1,
    max: 100,
    public: true,
  },
  {
    key: 'comments_per_page',
    type: 'integer',
    category: 'polls',
    label: 'Comments per page',
    description: 'Number of comments shown per page on poll pages.',
    defaultValue: 30,
    required: true,
    min: 1,
    max: 100,
    public: true,
  },
  {
    key: 'auto_approve_polls',
    type: 'boolean',
    category: 'polls',
    label: 'Auto-approve polls',
    description: 'When enabled, submitted polls are published immediately. When disabled, they stay pending until an admin approves them.',
    defaultValue: false,
    required: true,
    public: true,
  },
  {
    key: 'user_poll_delay_minutes',
    type: 'integer',
    category: 'polls',
    label: 'User poll delay (minutes)',
    description: 'Minutes a user must wait before submitting another poll.',
    defaultValue: 10,
    required: true,
    min: 0,
    // One year, in minutes.
    max: 525600,
    public: true,
  },
  {
    key: 'user_comment_delay_minutes',
    type: 'integer',
    category: 'polls',
    label: 'User comment delay (minutes)',
    description: 'Minutes a user must wait before posting another comment.',
    defaultValue: 10,
    required: true,
    min: 0,
    // One year, in minutes.
    max: 525600,
    public: true,
  },
  {
    key: 'min_votes_to_display',
    type: 'integer',
    category: 'polls',
    label: 'Min votes to display',
    description: 'Vote totals below this number are hidden until the poll gathers more votes.',
    defaultValue: 10,
    required: true,
    min: 0,
    max: 1000,
    public: true,
  },
  {
    key: 'min_views_to_display',
    type: 'integer',
    category: 'polls',
    label: 'Min views to display',
    description: 'View totals below this number are hidden in the poll lists until a poll gathers more views.',
    defaultValue: 20,
    required: true,
    min: 0,
    max: 1000,
    public: true,
  },

  // Auth
  {
    key: 'max_accounts_per_ip',
    type: 'integer',
    category: 'auth',
    label: 'Max accounts per IP',
    description: 'Maximum number of accounts that can be created from the same IP.',
    defaultValue: 4,
    required: true,
    min: 1,
    max: 1000,
    public: true,
  },
  {
    key: 'login_badge_enable',
    type: 'boolean',
    category: 'auth',
    label: 'Show login badge',
    description: 'Show an "optional" badge next to the login link in the navigation.',
    defaultValue: false,
    required: true,
    public: true,
  },
  {
    key: 'login_max_failed_attempts',
    type: 'integer',
    category: 'auth',
    label: 'Max failed login attempts',
    description: 'Number of failed login attempts before the account is locked.',
    defaultValue: 5,
    required: true,
    min: 1,
    max: 100,
    public: true,
  },
  {
    key: 'login_lock_minutes',
    type: 'integer',
    category: 'auth',
    label: 'Account lock duration (minutes)',
    description: 'How long an account stays locked after too many failed attempts.',
    defaultValue: 15,
    required: true,
    min: 1,
    max: 1440,
    public: true,
  },

  // Reports
  {
    key: 'report_auto_hide_threshold',
    type: 'integer',
    category: 'reports',
    label: 'Auto-hide threshold (reports)',
    description: 'A poll is hidden for review once it collects this many open reports in total. Set to 0 to disable.',
    defaultValue: 5,
    required: true,
    min: 0,
    max: 1000,
    public: true,
  },
  {
    key: 'report_auto_hide_priority_threshold',
    type: 'integer',
    category: 'reports',
    label: 'Auto-hide priority threshold',
    description: 'A poll is hidden once it collects this many open reports with a high-priority reason. Set to 0 to disable.',
    defaultValue: 2,
    required: true,
    min: 0,
    max: 1000,
    public: true,
  },

  // Rate limits (shared format: "N/w|d|h|m|s")
  {
    key: 'vote_rate_limit',
    type: 'rate_limit',
    category: 'polls',
    label: 'Vote rate limit',
    description: 'Rate limit for voting (e.g., "5/h" = 5 votes per hour). ' + RATE_LIMIT_UNITS_HELP,
    defaultValue: '5/h',
    required: true,
    public: true,
  },
  {
    key: 'comment_rate_limit',
    type: 'rate_limit',
    category: 'polls',
    label: 'Comment rate limit',
    description: 'Rate limit for posting comments (e.g., "3/h"). ' + RATE_LIMIT_UNITS_HELP,
    defaultValue: '3/h',
    required: true,
    public: true,
  },
  {
    key: 'proposal_rate_limit',
    type: 'rate_limit',
    category: 'polls',
    label: 'Proposal rate limit',
    description: 'Rate limit for submitting polls (e.g., "1/d"). ' + RATE_LIMIT_UNITS_HELP,
    defaultValue: '1/d',
    required: true,
    public: true,
  },
  {
    key: 'report_rate_limit',
    type: 'rate_limit',
    category: 'reports',
    label: 'Report rate limit',
    description: 'Rate limit for reporting polls (e.g., "3/d"). ' + RATE_LIMIT_UNITS_HELP,
    defaultValue: '3/d',
    required: true,
    public: true,
  },
  {
    key: 'login_rate_limit',
    type: 'rate_limit',
    category: 'auth',
    label: 'Login rate limit',
    description: 'Rate limit for login attempts (e.g., "10/h"). ' + RATE_LIMIT_UNITS_HELP,
    defaultValue: '10/h',
    required: true,
    public: true,
  },
  {
    key: 'register_rate_limit',
    type: 'rate_limit',
    category: 'auth',
    label: 'Register rate limit',
    description: 'Rate limit for account registration (e.g., "5/d"). ' + RATE_LIMIT_UNITS_HELP,
    defaultValue: '5/d',
    required: true,
    public: true,
  },
  {
    key: 'ai_rate_limit',
    type: 'rate_limit',
    category: 'ai',
    label: 'AI rate limit',
    description: 'Rate limit for AI assistance endpoints (e.g., "10/h"). ' + RATE_LIMIT_UNITS_HELP,
    defaultValue: '10/h',
    required: true,
    public: true,
  },

  // AI
  {
    key: 'ai_provider',
    type: 'enum',
    category: 'ai',
    label: 'AI provider',
    description: 'Choose Off to disable AI features, Cloudflare Workers AI to use the Workers AI binding, or OpenAI-compatible API to call your own compatible endpoint.',
    defaultValue: 'off',
    required: true,
    enumOptions: [
      { value: 'off', label: 'Off - disable all AI features' },
      { value: 'cloudflare', label: 'Cloudflare Workers AI - use the Workers AI binding' },
      { value: 'openai_compatible', label: 'OpenAI-compatible API - use a custom endpoint' },
    ],
    public: false,
  },
  {
    key: 'ai_api_url',
    type: 'url',
    category: 'ai',
    label: 'OpenAI-compatible API URL',
    description: 'Base URL of the OpenAI-compatible API, for example https://api.openai.com/v1. The Worker calls <url>/chat/completions. Used only when the provider is OpenAI-compatible API.',
    defaultValue: '',
    required: false,
    public: false,
  },
  {
    key: 'ai_api_key',
    type: 'string',
    category: 'ai',
    label: 'OpenAI-compatible API key',
    description: 'Optional bearer token sent to the OpenAI-compatible API. Leave empty when the endpoint does not require authentication.',
    defaultValue: '',
    required: false,
    max: 500,
    secret: true,
    public: false,
  },
  {
    key: 'ai_model',
    type: 'string',
    category: 'ai',
    label: 'AI model',
    description: 'Model name used for every AI feature. Use a Workers AI model name for Cloudflare Workers AI, or a model name supported by your OpenAI-compatible endpoint.',
    defaultValue: '@cf/qwen/qwen3-30b-a3b-fp8',
    required: true,
    public: false,
  },
  {
    key: 'ai_auto_topic',
    type: 'boolean',
    category: 'ai',
    label: 'Auto-topic polls',
    description: 'When enabled, submitted polls without a topic are assigned a topic by the AI model. Admin only.',
    defaultValue: false,
    required: true,
    public: false,
  },
  {
    key: 'ai_review_prompt',
    type: 'text',
    category: 'ai',
    label: 'AI review prompt',
    description: 'Instructions the AI follows when auto-approval is on. When AI is enabled and this prompt is not empty, a submission is published only if the AI review passes. Leave empty to publish every submission immediately. Admin only.',
    defaultValue: '',
    required: false,
    max: 4000,
    public: false,
  },

  // Publishing
  {
    key: 'publish_enable',
    type: 'boolean',
    category: 'publishing',
    label: 'Enable audit publishing',
    description: 'When enabled, the hourly maintenance run copies the signed snapshot chain to a GitHub repository.',
    defaultValue: false,
    required: true,
    public: false,
  },
  {
    key: 'publish_repository',
    type: 'string',
    category: 'publishing',
    label: 'Publish repository',
    description: 'GitHub repository in "owner/name" format for audit publishing.',
    defaultValue: '',
    required: false,
    public: false,
  },
  {
    key: 'publish_branch',
    type: 'string',
    category: 'publishing',
    label: 'Publish branch',
    description: 'Git branch to publish snapshots to.',
    defaultValue: 'main',
    required: true,
    public: false,
  },
  {
    key: 'publish_path',
    type: 'string',
    category: 'publishing',
    label: 'Publish path',
    description: 'Repository path where snapshots are stored.',
    defaultValue: 'snapshots',
    required: true,
    public: false,
  },
  {
    key: 'github_token',
    type: 'string',
    category: 'publishing',
    label: 'GitHub token',
    description: 'Personal access token with repo write access. Stored as a secret.',
    defaultValue: '',
    required: false,
    secret: true,
    public: false,
  },

  // Advanced
  {
    key: 'read_only_mode',
    type: 'boolean',
    category: 'advanced',
    label: 'Read-only mode',
    description: 'When enabled, the site is read-only: no new polls, votes, or comments.',
    defaultValue: false,
    required: true,
    public: true,
  },
];

// Category metadata for UI
export const SETTING_CATEGORIES: Record<SettingCategory, { label: string; description: string }> = {
  general: {
    label: 'General',
    description: 'Basic site identity and defaults.',
  },
  appearance: {
    label: 'Appearance',
    description: 'Logo, colors, hero section, and layout.',
  },
  polls: {
    label: 'Polls & Voting',
    description: 'Poll display, voting limits, and submission rules.',
  },
  auth: {
    label: 'Authentication',
    description: 'Account creation, login security, and rate limits.',
  },
  reports: {
    label: 'Reports & Moderation',
    description: 'Auto-hide thresholds and report rate limits.',
  },
  ai: {
    label: 'AI Features',
    description: 'AI-powered assistance, categorization, and review through Workers AI or an OpenAI-compatible endpoint.',
  },
  publishing: {
    label: 'Audit Publishing',
    description: 'GitHub-based audit log publishing configuration.',
  },
  advanced: {
    label: 'Advanced',
    description: 'Site-wide switches and advanced options.',
  },
};

// Helper functions
export function getSettingSchema(key: string): SettingSchema | undefined {
  return SETTING_SCHEMAS.find((s) => s.key === key);
}

export function getSettingsByCategory(category: SettingCategory): SettingSchema[] {
  return SETTING_SCHEMAS.filter((s) => s.category === category);
}

export function getAllSettingKeys(): string[] {
  return SETTING_SCHEMAS.map((s) => s.key);
}

export function getSettingDefault(key: string): string | number | boolean | undefined {
  return getSettingSchema(key)?.defaultValue;
}

export function isSettingPublic(key: string): boolean {
  return getSettingSchema(key)?.public ?? false;
}

export function isSettingSecret(key: string): boolean {
  return getSettingSchema(key)?.secret ?? false;
}