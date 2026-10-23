// API error handling: the same backend code must render in the visitor's
// language, legacy response shapes must keep working, and nothing that cannot be
// identified may leak raw exception text.

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCALE, loadTranslations, setDefaultLocale, type Locale } from '../src/i18n';
import {
  ApiError,
  apiErrorCode,
  apiErrorMessage,
  parseApiErrorPayload,
  translateApiErrorCode
} from '../src/lib/apiError';
import { ERROR_MESSAGES } from '../shared/errors';

// The real dictionaries, so a missing or drifted key fails the test.
const dictionaries: Record<Locale, Record<string, string>> = {
  en: JSON.parse(readFileSync('public/i18n/en.json', 'utf8')),
  'zh-CN': JSON.parse(readFileSync('public/i18n/zh.json', 'utf8')),
  'zh-TW': JSON.parse(readFileSync('public/i18n/zh-TW.json', 'utf8'))
};

beforeAll(async () => {
  // Stands in for `/i18n/<locale>.json`, which the app fetches before rendering.
  vi.stubGlobal('fetch', async (input: string) => {
    const locale: Locale = input.includes('zh-TW') ? 'zh-TW' : input.includes('zh') ? 'zh-CN' : 'en';
    return { ok: true, json: async () => dictionaries[locale] };
  });
  await loadTranslations('en');
  await loadTranslations('zh-CN');
  await loadTranslations('zh-TW');
});

afterEach(() => {
  setDefaultLocale('en');
});

describe('parseApiErrorPayload', () => {
  it('reads the structured error object', () => {
    expect(parseApiErrorPayload({ error: { code: 'USERNAME_TAKEN', params: {} } }))
      .toMatchObject({ code: 'USERNAME_TAKEN', params: {} });
    expect(parseApiErrorPayload({ error: { code: 'OPTION_LABEL_LENGTH', params: { position: 2, max: 80 } } }))
      .toMatchObject({ code: 'OPTION_LABEL_LENGTH', params: { position: 2, max: 80 } });
  });

  it('reads the legacy shapes', () => {
    expect(parseApiErrorPayload({ detail: { code: 'USERNAME_TAKEN' } })).toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(parseApiErrorPayload({ code: 'USERNAME_TAKEN' })).toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(parseApiErrorPayload({ detail: 'Email already exists' })).toMatchObject({ message: 'Email already exists' });
    expect(parseApiErrorPayload({ message: 'Email already exists' })).toMatchObject({ message: 'Email already exists' });
    expect(parseApiErrorPayload('plain text')).toMatchObject({ message: 'plain text' });
  });

  it('yields nothing for a malformed body', () => {
    for (const payload of [null, undefined, 42, ['validation', 'array'], { detail: ['a', 'b'] }]) {
      expect(parseApiErrorPayload(payload)).toEqual({ code: null, params: {}, message: '', status: null });
    }
  });
});

describe('apiErrorMessage', () => {
  const usernameTaken = () => new ApiError('username is already taken', { code: 'USERNAME_TAKEN', status: 409 });

  it('translates one code into every supported locale', () => {
    setDefaultLocale('en');
    expect(apiErrorMessage(usernameTaken())).toBe('username is already taken');
    setDefaultLocale('zh-CN');
    expect(apiErrorMessage(usernameTaken())).toBe(dictionaries['zh-CN']['errors.USERNAME_TAKEN']);
    setDefaultLocale('zh-TW');
    expect(apiErrorMessage(usernameTaken())).toBe(dictionaries['zh-TW']['errors.USERNAME_TAKEN']);
  });

  it('changes language without a new backend response', () => {
    // The very same error object renders in each language.
    const error = usernameTaken();
    setDefaultLocale('zh-CN');
    const chinese = apiErrorMessage(error);
    setDefaultLocale('en');
    const english = apiErrorMessage(error);
    expect(chinese).not.toBe(english);
    expect(chinese).toBe(dictionaries['zh-CN']['errors.USERNAME_TAKEN']);
  });

  it('interpolates the structured parameters', () => {
    const error = new ApiError('', { code: 'OPTION_LABEL_LENGTH', params: { position: 2, max: 80 } });

    setDefaultLocale('en');
    expect(apiErrorMessage(error)).toContain('2');
    expect(apiErrorMessage(error)).toContain('80');

    setDefaultLocale('zh-CN');
    const chinese = apiErrorMessage(error);
    expect(chinese).toContain('2');
    expect(chinese).toContain('80');
    expect(chinese).not.toContain('{position}');
    expect(chinese).not.toContain('{max}');
  });

  it('maps a legacy English message back to its code', () => {
    setDefaultLocale('zh-CN');
    expect(apiErrorMessage(new ApiError('poll not found', { status: 404 })))
      .toBe(dictionaries['zh-CN']['errors.POLL_NOT_FOUND']);
  });

  it('falls back to the generic message for an unknown code', () => {
    setDefaultLocale('zh-CN');
    expect(apiErrorMessage(new ApiError('', { code: 'SOMETHING_NEW', status: 500 })))
      .toBe(dictionaries['zh-CN']['errors.UNKNOWN']);
  });

  it('falls back to a status-based code when the body is unusable', () => {
    setDefaultLocale('zh-CN');
    expect(apiErrorMessage(new ApiError('', { status: 429 })))
      .toBe(dictionaries['zh-CN']['errors.RATE_LIMIT_EXCEEDED']);
    expect(apiErrorMessage(new ApiError('', { status: 403 })))
      .toBe(dictionaries['zh-CN']['errors.PERMISSION_DENIED']);
  });

  it('never shows raw exception text', () => {
    setDefaultLocale('en');
    const sqlError = new Error('D1_ERROR: no such table: users');
    expect(apiErrorMessage(sqlError)).not.toContain('D1_ERROR');
    expect(apiErrorMessage(sqlError)).not.toContain('no such table');
    expect(apiErrorMessage({ unexpected: true })).toBe(dictionaries.en['errors.UNKNOWN']);
  });

  it('identifies network failures and timeouts', () => {
    setDefaultLocale('zh-CN');
    expect(apiErrorMessage(new TypeError('Failed to fetch')))
      .toBe(dictionaries['zh-CN']['errors.NETWORK_ERROR']);

    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(apiErrorMessage(aborted)).toBe(dictionaries['zh-CN']['errors.TIMEOUT']);
  });
});

describe('apiErrorCode', () => {
  it('prefers the code, then the legacy text, then the status', () => {
    expect(apiErrorCode(new ApiError('x', { code: 'DUPLICATE_VOTE', status: 409 }))).toBe('DUPLICATE_VOTE');
    expect(apiErrorCode(new ApiError('duplicate vote', { status: 409 }))).toBe('DUPLICATE_VOTE');
    expect(apiErrorCode(new ApiError('', { status: 404 }))).toBe('RESOURCE_NOT_FOUND');
    expect(apiErrorCode(new ApiError('unmapped text', {}))).toBeNull();
  });
});

describe('translateApiErrorCode', () => {
  it('returns null for a code the dictionary does not define', () => {
    expect(translateApiErrorCode('NOT_A_REAL_CODE', {}, 'en')).toBeNull();
    expect(translateApiErrorCode(null, {}, 'en')).toBeNull();
  });
});

describe('dictionary coverage', () => {
  it('defines every registry code in every locale', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW'] as Locale[]) {
      for (const code of Object.keys(ERROR_MESSAGES)) {
        expect(dictionaries[locale][`errors.${code}`], `${locale} is missing errors.${code}`).toBeTypeOf('string');
      }
    }
  });

  it('keeps the three dictionaries in step', () => {
    const english = Object.keys(dictionaries.en).sort();
    expect(Object.keys(dictionaries['zh-CN']).sort()).toEqual(english);
    expect(Object.keys(dictionaries['zh-TW']).sort()).toEqual(english);
  });

  it('never leaves an error key as its own text', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW'] as Locale[]) {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        if (key.startsWith('errors.')) expect(value).not.toBe(key);
      }
    }
    expect(DEFAULT_LOCALE).toBe('en');
  });
});
