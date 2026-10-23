// Settings schema: defines all settings with types, categories, validation, and UI hints.
// This is the single source of truth for settings metadata used by both the Worker
// and the admin dashboard. The actual stored values remain simple key-value strings
// in the `settings` table; this module only adds metadata for validation and UI.

export type SettingType =
  | 'string'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'rate_limit'
  | 'url'
  | 'color'
  | 'image_base64';

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

// Image settings are stored in the settings table as base64 data URIs. Two rules
// are shared by the admin validator and the public settings loader: which image
// media types are accepted, and how long the encoded string may be. A D1 row is
// capped at 2 MB, so the cap stays well below that.
export const IMAGE_DATA_URI_PATTERN =
  /^data:image\/(png|jpeg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon|ico);base64,/;

export const IMAGE_DATA_URI_MAX_CHARS = 1_000_000;

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
    type: 'image_base64',
    category: 'appearance',
    label: 'Logo',
    description: 'Logo image shown in the header. Upload an image file (PNG, SVG, WebP). Stored as base64 in database.',
    defaultValue: '',
    required: false,
    public: true,
  },
  {
    key: 'favicon',
    type: 'image_base64',
    category: 'appearance',
    label: 'Favicon',
    description: 'Favicon shown in browser tabs. Upload an image file (ICO, PNG, SVG). Stored as base64 in database.',
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
    key: 'user_poll_delay_hours',
    type: 'integer',
    category: 'polls',
    label: 'User poll delay (hours)',
    description: 'Hours a user must wait before submitting another poll.',
    defaultValue: 48,
    required: true,
    min: 0,
    max: 8760,
    public: true,
  },
  {
    key: 'user_comment_delay_hours',
    type: 'integer',
    category: 'polls',
    label: 'User comment delay (hours)',
    description: 'Hours a user must wait before posting another comment.',
    defaultValue: 24,
    required: true,
    min: 0,
    max: 8760,
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
    description: 'View totals below this number are hidden until the poll gathers more views.',
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
    description: 'Rate limit for voting (e.g., "5/h" = 5 votes per hour).',
    defaultValue: '5/h',
    required: true,
    public: true,
  },
  {
    key: 'comment_rate_limit',
    type: 'rate_limit',
    category: 'polls',
    label: 'Comment rate limit',
    description: 'Rate limit for posting comments (e.g., "3/h").',
    defaultValue: '3/h',
    required: true,
    public: true,
  },
  {
    key: 'proposal_rate_limit',
    type: 'rate_limit',
    category: 'polls',
    label: 'Proposal rate limit',
    description: 'Rate limit for submitting polls (e.g., "1/d").',
    defaultValue: '1/d',
    required: true,
    public: true,
  },
  {
    key: 'report_rate_limit',
    type: 'rate_limit',
    category: 'reports',
    label: 'Report rate limit',
    description: 'Rate limit for reporting polls (e.g., "3/d").',
    defaultValue: '3/d',
    required: true,
    public: true,
  },
  {
    key: 'login_rate_limit',
    type: 'rate_limit',
    category: 'auth',
    label: 'Login rate limit',
    description: 'Rate limit for login attempts (e.g., "10/h").',
    defaultValue: '10/h',
    required: true,
    public: true,
  },
  {
    key: 'register_rate_limit',
    type: 'rate_limit',
    category: 'auth',
    label: 'Register rate limit',
    description: 'Rate limit for account registration (e.g., "5/d").',
    defaultValue: '5/d',
    required: true,
    public: true,
  },
  {
    key: 'ai_rate_limit',
    type: 'rate_limit',
    category: 'ai',
    label: 'AI rate limit',
    description: 'Rate limit for AI assistance endpoints (e.g., "10/h").',
    defaultValue: '10/h',
    required: true,
    public: true,
  },

  // AI
  {
    key: 'ai_enable',
    type: 'boolean',
    category: 'ai',
    label: 'Enable AI assistance',
    description: 'When enabled, AI-powered features (categorization, etc.) are available. Requires Workers AI binding.',
    defaultValue: false,
    required: true,
    public: true,
  },
  {
    key: 'ai_model',
    type: 'string',
    category: 'ai',
    label: 'AI model',
    description: 'Workers AI model to use for AI features.',
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
export const SETTING_CATEGORIES: Record<SettingCategory, { label: string; description: string; icon: string }> = {
  general: {
    label: 'General',
    description: 'Basic site identity and defaults.',
    icon: '🏠',
  },
  appearance: {
    label: 'Appearance',
    description: 'Logo, colors, hero section, and layout.',
    icon: '🎨',
  },
  polls: {
    label: 'Polls & Voting',
    description: 'Poll display, voting limits, and submission rules.',
    icon: '📊',
  },
  auth: {
    label: 'Authentication',
    description: 'Account creation, login security, and rate limits.',
    icon: '🔐',
  },
  reports: {
    label: 'Reports & Moderation',
    description: 'Auto-hide thresholds and report rate limits.',
    icon: '🚩',
  },
  ai: {
    label: 'AI Features',
    description: 'AI-powered categorization and assistance (requires Workers AI).',
    icon: '🤖',
  },
  publishing: {
    label: 'Audit Publishing',
    description: 'GitHub-based audit log publishing configuration.',
    icon: '📤',
  },
  advanced: {
    label: 'Advanced',
    description: 'Site-wide switches and advanced options.',
    icon: '⚙️',
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