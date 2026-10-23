// Admin settings library: validation, masking, and schema access.
// Uses the shared settings schema from shared/settings.ts as the single source of truth.

import {
  SETTING_CATEGORIES,
  getSettingSchema,
  getSettingsByCategory,
  getAllSettingKeys,
  getSettingDefault as getSharedSettingDefault,
  isSettingPublic,
  isSettingSecret,
  imageSettingError,
  type SettingSchema,
  type SettingCategory,
} from '../../shared/settings';

export type SettingKey = string;

export const SETTING_KEYS = getAllSettingKeys();

export const SETTING_CATEGORIES_LIST = Object.keys(SETTING_CATEGORIES) as SettingCategory[];

export type SettingValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function isSettingKey(value: string): value is SettingKey {
  return getSettingSchema(value) !== undefined;
}

function isInteger(value: string, min: number, max: number): boolean {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
}

function isRateLimit(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^(\d+)\/([wdhms])$/.test(normalized);
}

function isUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isColor(value: string): boolean {
  if (!value) return true; // empty is allowed
  return /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\)|[a-z]+|(?:linear|radial)-gradient\(.+\))$/i.test(value);
}

export function validateSettingValue(key: string, value: string): SettingValidationResult {
  const schema = getSettingSchema(key);
  if (!schema) {
    return { ok: false, error: `Unknown setting key "${key}". Known keys: ${SETTING_KEYS.join(', ')}.` };
  }

  // Required check
  if (schema.required && (!value || value.trim() === '')) {
    return { ok: false, error: `${schema.label} is required.` };
  }

  // Empty optional value is valid
  if (!schema.required && (!value || value.trim() === '')) {
    return { ok: true, value: '' };
  }

  switch (schema.type) {
    case 'integer': {
      const num = Number(value);
      if (!isInteger(value, schema.min ?? Number.MIN_SAFE_INTEGER, schema.max ?? Number.MAX_SAFE_INTEGER)) {
        return { ok: false, error: `${schema.label} must be an integer between ${schema.min ?? 0} and ${schema.max ?? Number.MAX_SAFE_INTEGER}.` };
      }
      return { ok: true, value: String(num) };
    }
    case 'boolean': {
      if (value !== 'true' && value !== 'false') {
        return { ok: false, error: `${schema.label} must be "true" or "false".` };
      }
      return { ok: true, value };
    }
    case 'enum': {
      const allowed = schema.enumOptions?.map((o) => o.value) ?? [];
      if (!allowed.includes(value)) {
        return { ok: false, error: `${schema.label} must be one of: ${allowed.join(', ')}.` };
      }
      return { ok: true, value };
    }
    case 'rate_limit': {
      if (!isRateLimit(value)) {
        return { ok: false, error: `${schema.label} must be in format "N/w|d|h|m|s" (e.g., "5/h", "3/h", "1/d").` };
      }
      return { ok: true, value: value.trim().toLowerCase() };
    }
    case 'url': {
      if (value && !isUrl(value)) {
        return { ok: false, error: `${schema.label} must be a valid HTTPS URL.` };
      }
      return { ok: true, value };
    }
    case 'color': {
      if (value && !isColor(value)) {
        return { ok: false, error: `${schema.label} must be a valid CSS color (hex, rgb/a, hsl/a, named) or gradient.` };
      }
      return { ok: true, value };
    }
    case 'image': {
      // An image is an uploaded base64 data URI or a pasted https URL. An empty
      // value removes the image and returned earlier.
      const error = imageSettingError(value);
      if (error) return { ok: false, error: `${schema.label} ${error}.` };
      return { ok: true, value };
    }
    case 'string':
    default: {
      if (schema.max && value.length > schema.max) {
        return { ok: false, error: `${schema.label} must not exceed ${schema.max} characters.` };
      }
      if (schema.min && value.trim().length < schema.min) {
        return { ok: false, error: `${schema.label} must be at least ${schema.min} characters.` };
      }
      return { ok: true, value };
    }
  }
}

// Audit details for a settings change. The audit log must stay readable and
// small, so a secret is only flagged and an image setting is recorded as a
// summary instead of the whole base64 payload.
export function auditDetailsForSetting(key: string, value: string): Record<string, unknown> {
  if (isSettingSecret(key)) return { secret: true };
  if (getSettingSchema(key)?.type === 'image') return { image: true, bytes: value.length };
  return { value };
}

export function maskSettingValue(key: string, value: string | null): string | null {
  if (value === null) return null;
  if (isSettingSecret(key)) {
    return value ? '••••••••' : '';
  }
  return value;
}

export function getSettingCategory(key: string): SettingCategory | undefined {
  return getSettingSchema(key)?.category;
}

export function getSettingLabel(key: string): string {
  return getSettingSchema(key)?.label ?? key;
}

export function getSettingDescription(key: string): string | undefined {
  return getSettingSchema(key)?.description;
}

export function getSettingType(key: string): SettingSchema['type'] | undefined {
  return getSettingSchema(key)?.type;
}

export function getSettingEnumOptions(key: string): { value: string; label: string }[] | undefined {
  return getSettingSchema(key)?.enumOptions;
}

export function getSettingDefault(key: string): string | number | boolean | undefined {
  return getSharedSettingDefault(key);
}

export function getSettingDefaultApi(key: string): string | number | boolean | undefined {
  return getSharedSettingDefault(key);
}

export function isSettingPublicApi(key: string): boolean {
  return isSettingPublic(key);
}

export function isSettingSecretApi(key: string): boolean {
  return isSettingSecret(key);
}