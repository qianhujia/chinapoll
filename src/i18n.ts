export type Locale = 'en' | 'zh-CN' | 'zh-TW';

export function resolveLocale(value?: string | null): Locale {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'zh-tw' || normalized === 'zh_tw' || normalized === 'zh-hant') {
    return 'zh-TW';
  }
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh_cn' || normalized === 'cn') {
    return 'zh-CN';
  }
  return 'en';
}

export let DEFAULT_LOCALE: Locale = 'en';

export function setDefaultLocale(value: Locale): void {
  DEFAULT_LOCALE = value;
}

const translations: Partial<Record<Locale, Record<string, string>>> = {};

const LOCALE_FILES: Record<Locale, string> = {
  en: '/i18n/en.json',
  'zh-CN': '/i18n/zh.json',
  'zh-TW': '/i18n/zh-TW.json'
};

export async function loadTranslations(locale: Locale): Promise<void> {
  const path = LOCALE_FILES[locale];
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Could not load translations (${response.status})`);
  }

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || Array.isArray(data)
    || !Object.values(data).every((value) => typeof value === 'string')) {
    throw new Error(`Invalid translations in ${path}`);
  }

  const dictionary: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid translation value for "${key}" in ${path}`);
    }
    dictionary[key] = value;
  }
  translations[locale] = dictionary;
}

export function getLocaleText(locale: Locale, key: string): string {
  return translations[locale]?.[key] ?? key;
}
