// Poll topics shared by both Workers and the SPA.
//
// The `topics` table stores one `name` and a stable `slug`. The nine
// suggested topics ship with a name for each of the site's three locales, so
// an admin who inserts them (or keeps their default name) gets localized labels;
// anything renamed or created by hand uses its stored name for every locale.

export type TopicLocale = 'en' | 'zh-CN' | 'zh-TW';

export type TopicNames = Record<TopicLocale, string>;

export interface SuggestedTopic {
  slug: string;
  names: TopicNames;
}

// Mirror of the `topics.slug` CHECK in the migration.
export const TOPIC_SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

export const MAX_TOPIC_NAME_LENGTH = 60;

// The set offered by the Settings tab's "Insert suggested topics" action and
// the label source for a topic that still carries its default name.
export const SUGGESTED_TOPICS: ReadonlyArray<SuggestedTopic> = [
  { slug: 'politics', names: { en: 'Politics', 'zh-CN': '政治', 'zh-TW': '政治' } },
  { slug: 'economy', names: { en: 'Economy', 'zh-CN': '经济', 'zh-TW': '經濟' } },
  { slug: 'education', names: { en: 'Education', 'zh-CN': '教育', 'zh-TW': '教育' } },
  { slug: 'environment', names: { en: 'Environment', 'zh-CN': '环境', 'zh-TW': '環境' } },
  { slug: 'health', names: { en: 'Health', 'zh-CN': '健康', 'zh-TW': '健康' } },
  { slug: 'technology', names: { en: 'Technology', 'zh-CN': '科技', 'zh-TW': '科技' } },
  { slug: 'culture', names: { en: 'Culture', 'zh-CN': '文化', 'zh-TW': '文化' } },
  { slug: 'society', names: { en: 'Society', 'zh-CN': '社会', 'zh-TW': '社會' } },
  { slug: 'other', names: { en: 'Other', 'zh-CN': '其他', 'zh-TW': '其他' } }
];

const SUGGESTED_BY_SLUG = new Map(SUGGESTED_TOPICS.map((topic) => [topic.slug, topic]));

// The name of a suggested topic, or null for a custom slug.
export function suggestedTopicNames(slug: string): TopicNames | null {
  return SUGGESTED_BY_SLUG.get(slug)?.names ?? null;
}

// The three names of a stored topic. A suggested slug that still carries its
// default English name is localized; anything else repeats its stored name so an
// admin's rename is never overridden.
export function topicNames(slug: string, name: string): TopicNames {
  const suggested = suggestedTopicNames(slug);
  if (suggested && suggested.en === name) return suggested;
  return { en: name, 'zh-CN': name, 'zh-TW': name };
}

// The name to display in one locale.
export function localizedTopicName(slug: string, name: string, locale: TopicLocale): string {
  return topicNames(slug, name)[locale];
}