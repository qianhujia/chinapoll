export type Locale = 'en' | 'zh-CN';

export function resolveLocale(value?: string | null): Locale {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh_cn' || normalized === 'cn') {
    return 'zh-CN';
  }
  return 'en';
}

export const DEFAULT_LOCALE = resolveLocale(
  (import.meta.env.VITE_DEFAULT_LOCALE as string | undefined) ?? 'en'
);

const translations: Partial<Record<Locale, Record<string, string>>> = {};

export async function loadTranslations(locale: Locale): Promise<void> {
  const path = locale === 'zh-CN' ? '/i18n/zh.json' : '/i18n/en.json';
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
