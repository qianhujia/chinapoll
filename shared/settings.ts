// Settings schema: defines all settings with types, categories, validation, and UI hints.
// This is the single source of truth for settings metadata used by both the Worker
// and the admin dashboard. The actual stored values remain simple key-value strings
// in the `settings` table; this module only adds metadata for validation and UI.

import {
  DEFAULT_HOME_DESCRIPTION_TEMPLATE,
  DEFAULT_TOPIC_DESCRIPTION_TEMPLATE,
} from './seo';

export type SettingType =
  | 'string'
  // A multi-line text value, rendered as a textarea in the admin dashboard.
  | 'text'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'rate_limit'
  | 'url'
  // A single email address, published as a `mailto:` link. It is validated by
  // emailSettingError and rendered as an email input in the admin dashboard.
  | 'email'
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
  /** For an image setting: the smallest side an uploaded image may have. */
  minImagePx?: number;
  /**
   * Template variables the value may use, named without braces (e.g. "site_name").
   * The admin dashboard lists them next to the field as a hint; a variable that is
   * not in the list is left as it is when the value is resolved (see
   * `resolveSeoDescription` in shared/seo.ts).
   */
  variables?: string[];
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

// The longest address a setting may hold. The value is a single address rather than
// a text field, and the cap keeps a stored row small.
export const EMAIL_MAX_LENGTH = 200;

// One plain address: a local part, an "@", and a domain that carries at least one
// dot, with no whitespace anywhere. Nothing more elaborate is enforced here, because
// a stricter pattern would reject addresses that are in fact deliverable.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Why an email setting value was rejected, or null when it is valid. The wording
// finishes the sentence "<label> <requirement>" in the admin validator and
// "setting <key> <requirement>" in the public settings loader, exactly like
// imageSettingError above.
export function emailSettingError(value: string): string | null {
  if (value.length > EMAIL_MAX_LENGTH) return `must not exceed ${EMAIL_MAX_LENGTH} characters`;
  if (!EMAIL_PATTERN.test(value)) return 'must be an email address';
  return null;
}

// The submit page's address travels to the browser encoded rather than as it is
// written: base64 of its UTF-8 bytes, which holds no "@" and no dot, so the email
// pattern a link harvester runs over a document matches nothing and the page never
// ships a plain `mailto:` target. This is obfuscation, not secrecy: the browser has
// to read the address to build its link, so a crawler that runs scripts can still
// find it on the rendered page.
export function encodeContactEmail(value: string): string {
  if (!value) return '';
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// The address a payload carries, or an empty string when it is not one this build
// wrote. An unreadable value hides the notice instead of breaking the page, and the
// decoded text has to be an address for the same reason it has to be one when it is
// stored.
export function decodeContactEmail(value: string): string {
  if (!value) return '';
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return EMAIL_PATTERN.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

// The unit suffixes a rate-limit value accepts. Shown in the admin dashboard next
// to every rate-limit field so an operator does not have to guess or consult the
// docs. The same set is enforced by RATE_LIMIT_PATTERN in worker/api/settings.ts.
// The smallest side an image a card builder shows may have. A card picture is the one
// exception to "any usable image": a smaller upload is dropped by the card builder and
// leaves the placeholder icon the setting exists to replace.
export const CARD_IMAGE_MIN_PX = 144;

export interface ImageSize {
  width: number;
  height: number;
}

// The pixel size an uploaded image states in its own header, or null when the payload
// is not one of the raster formats a card builder renders. Only PNG, JPEG, and WebP
// are read: an SVG states no pixel size, and an icon is not a card picture.
export function imagePixelSize(dataUri: string): ImageSize | null {
  const bytes = decodeBase64Image(dataUri);
  if (!bytes) return null;
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}

// Why an image setting value was rejected, or null when it is valid. A setting that
// declares minImagePx has to carry an upload at least that size on each side, in a
// format a card builder renders; a pasted https URL passes either way, because its
// size is not knowable here without fetching it.
export function imageSettingValueError(schema: SettingSchema, value: string): string | null {
  const error = imageSettingError(value);
  if (error || !schema.minImagePx || !value.startsWith('data:')) return error;
  const size = imagePixelSize(value);
  if (!size) return 'must be a PNG, JPEG, or WebP image, which is what a card builder renders';
  if (size.width < schema.minImagePx || size.height < schema.minImagePx) {
    return `must be at least ${schema.minImagePx}x${schema.minImagePx} pixels`;
  }
  return null;
}

// The bytes of a base64 image data URI, or null when the value is not one.
function decodeBase64Image(dataUri: string): Uint8Array | null {
  const payload = dataUri.match(/^data:image\/[\w.+-]+;base64,(.*)$/s)?.[1];
  if (payload === undefined) return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function uint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (littleEndian) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A PNG states its size in the IHDR chunk that follows the 8-byte signature: a 4-byte
// chunk length, the 4-byte chunk type, then width and height as 32-bit big-endian.
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  return { width: uint32(bytes, 16, false), height: uint32(bytes, 20, false) };
}

// A JPEG states its size in a frame header (SOF0-SOF15, minus the Huffman, JPG, and
// arithmetic-table markers that share the range): the marker, its 2-byte big-endian
// length, the sample precision, then height and width as 16-bit big-endian values.
function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // A repeated 0xFF is a fill byte, not a marker of its own.
    if (marker === 0xff) { offset += 1; continue; }
    const length = uint16(bytes, offset + 2, false);
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader && length >= 7) {
      return { width: uint16(bytes, offset + 7, false), height: uint16(bytes, offset + 5, false) };
    }
    // The entropy-coded scan follows the start-of-scan marker, and no size can appear
    // after it, so the walk stops there.
    if (marker === 0xda || length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

// A WebP container names its variant right after the RIFF header, and every variant
// stores both sides one pixel smaller than they are.
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (!asciiAt(bytes, 0, 'RIFF') || !asciiAt(bytes, 8, 'WEBP')) return null;
  if (bytes.length >= 30 && asciiAt(bytes, 12, 'VP8X')) {
    return { width: uint24(bytes, 24) + 1, height: uint24(bytes, 27) + 1 };
  }
  if (bytes.length >= 25 && asciiAt(bytes, 12, 'VP8L')) {
    // 14 bits of width, then 14 bits of height, packed after the 0x2F signature.
    const bits = uint32(bytes, 21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (bytes.length >= 30 && asciiAt(bytes, 12, 'VP8 ')) {
    // The lossy variant stores both sides as 14-bit values after its 3-byte start code.
    return { width: uint16(bytes, 26, true) & 0x3fff, height: uint16(bytes, 28, true) & 0x3fff };
  }
  return null;
}

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
    key: 'home_description',
    type: 'string',
    category: 'general',
    label: 'Home page description',
    description: 'Meta description of the home page, shown in search results and link cards.',
    defaultValue: DEFAULT_HOME_DESCRIPTION_TEMPLATE,
    required: false,
    max: 300,
    public: true,
    variables: ['site_name', 'slogan'],
  },
  {
    key: 'topic_description',
    type: 'string',
    category: 'general',
    label: 'Topic page description',
    description: 'Meta description of a topic page, shown in search results and link cards.',
    defaultValue: DEFAULT_TOPIC_DESCRIPTION_TEMPLATE,
    required: false,
    max: 300,
    public: true,
    variables: ['site_name', 'slogan', 'topic'],
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
    description: 'Logo shown in the header on every public page, and used as the card image when no social image is set. Upload an image file (PNG, SVG, WebP) or paste an https image URL. An upload is stored in the database and served from /image/logo.<extension>.',
    defaultValue: '',
    required: false,
    public: true,
  },
  {
    key: 'favicon',
    type: 'image',
    category: 'appearance',
    label: 'Favicon',
    description: 'Favicon shown in browser tabs, and used as the card image when neither a social image nor a logo is configured. Upload an image file (ICO, PNG, SVG) or paste an https image URL. An upload is stored in the database and served from /image/favicon.<extension>.',
    defaultValue: '',
    required: false,
    public: true,
  },
  {
    key: 'social_image',
    type: 'image',
    category: 'appearance',
    label: 'Social image',
    description: `Image a shared link shows on social platforms: the Open Graph and X card picture. Upload a PNG, JPEG, or WebP at least ${CARD_IMAGE_MIN_PX}x${CARD_IMAGE_MIN_PX} pixels, or paste an https image URL. An upload is stored in the database and served from /image/social_image.<extension>.`,
    minImagePx: CARD_IMAGE_MIN_PX,
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
    key: 'submit_contact_email',
    type: 'email',
    category: 'polls',
    label: 'Submit page contact email',
    description: 'Address the submit page offers to a visitor who would rather not register: the notice above the poll type field and in the sign-in prompt link to it. Leave empty to hide the notice.',
    defaultValue: '',
    required: false,
    max: EMAIL_MAX_LENGTH,
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