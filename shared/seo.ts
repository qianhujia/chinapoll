// SEO text shared by the public Worker and the SPA.
//
// A meta description is plain, single-line text: a search engine or a card builder
// prints it as one sentence, so markup in it leaks tags into the snippet and a line
// break runs two sentences together. Both sides pass every description through
// `seoDescription` before writing the tag, whatever the text they started from - a poll
// description, a site slogan, or a dictionary string.

import { interpolateParams } from './errors';

// The wording the home page and a topic page publish while no stored value is set.
// They are also the `defaultValue` of the matching settings (see shared/settings.ts)
// and the defaults the public loader merges in (see worker/api/settings.ts), so the
// schema, the defaults, and the rendered tag cannot drift apart.
//
// A template may use `{variable}` placeholders. The home page knows `{site_name}`
// and `{slogan}`; a topic page also knows `{topic}`.
export const DEFAULT_HOME_DESCRIPTION_TEMPLATE = '{slogan}';
export const DEFAULT_TOPIC_DESCRIPTION_TEMPLATE = 'Browse polls about {topic} on {site_name}.';

// The length a search engine shows; anything longer is cut rather than published.
export const SEO_DESCRIPTION_MAX_LENGTH = 160;

// An HTML tag, attributes and all: `<p>`, `</b>`, `<br />`, `<a href="…">`. Only a
// letter may open one, so text that merely uses angle brackets - `a < b and c > d` -
// survives untouched.
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;

// The description to publish: tags dropped, every run of whitespace (line breaks and
// tabs included) folded into a single space, and the result cut to the length a search
// engine shows. The cut happens after the folding, so a long marked-up description still
// ends in words rather than in a string of tags.
export function seoDescription(text: string | null | undefined): string {
  return (text ?? '')
    .replace(HTML_TAG_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEO_DESCRIPTION_MAX_LENGTH)
    .trim();
}

// The description a page publishes from a wording the admin edited: the template's
// `{variable}` placeholders are filled from `variables` (see the `variables` hint on
// a setting in shared/settings.ts), an unknown placeholder is left as it is rather
// than silently blanked, and the result is reduced to the one plain line a search
// engine shows. An empty result means "no wording configured", which leaves the
// built-in fallback to the caller.
export function resolveSeoDescription(
  template: string | null | undefined,
  variables: Record<string, string | number> = {}
): string {
  return seoDescription(interpolateParams(template ?? '', variables));
}

// The image a link card shows for the site: the social image, or the header logo while
// none is set, or the favicon as the last stand-in. A card builder fetches the URL
// itself and cannot read a path, so a branding route the site serves (/image/logo.png)
// is resolved against the origin the page is published on, while an https URL the
// operator pasted is already absolute and is used as it is. Empty when none is
// configured, which leaves the card without an image.
export function shareImageUrl(
  branding: { social_image?: string; logo?: string; favicon?: string },
  origin: string
): string {
  for (const value of [branding.social_image, branding.logo, branding.favicon]) {
    const image = (value ?? '').trim();
    if (!image) continue;
    if (/^https:\/\//i.test(image)) return image;
    if (image.startsWith('/')) return origin + image;
  }
  return '';
}

// One option of a poll as structured data carries it: its label, and the votes it
// collected (null while the count is withheld).
export interface PollAnswer {
  label: string;
  count: number | null;
}

// The standing a poll publishes: the options in display order with their counts, and
// the ballot total. `hidden` mirrors the page's own rule - below the display threshold
// the site withholds its counts, and markup drawn from them has to withhold them too
// (see `toPublicResults` in worker/services/options.ts).
export interface PollStandings {
  hidden: boolean;
  ballots: number | null;
  answers: ReadonlyArray<PollAnswer>;
}

// The poll as a schema.org Question: the title is the question, the options are the
// suggested answers, and each answer carries the votes it collected, so a search engine
// reading the page can see the same standing the page shows. The numbers are the public
// ones: while the poll is below the display threshold - or the standings could not be
// read, which is passed as null - no count is published here either, so the markup never
// reveals a tally the site is still withholding. Shared by the server-rendered head and
// the SPA, which refreshes the node with the counts it loaded.
export function buildPollQuestionJsonLd(
  poll: { number: number; title: string; description: string | null },
  standings: PollStandings | null,
  settings: { site_name: string },
  origin: string
): Record<string, unknown> {
  const url = `${origin}/poll/${poll.number}`;
  const answers = standings?.answers ?? [];
  // The counts are published only when the page shows them.
  const counted = standings && !standings.hidden ? standings : null;

  return {
    '@context': 'https://schema.org',
    '@type': 'Question',
    name: poll.title,
    text: seoDescription(poll.description) || poll.title,
    url,
    // The options are the answers the poll suggests, so the count of them is what the
    // question offers; the votes go on the answers themselves.
    answerCount: answers.length,
    ...(counted?.ballots != null ? { upvoteCount: counted.ballots } : {}),
    ...(answers.length > 0
      ? {
        suggestedAnswer: answers.map((answer) => ({
          '@type': 'Answer',
          text: answer.label,
          ...(counted && answer.count !== null ? { upvoteCount: answer.count } : {})
        }))
      }
      : {}),
    author: { '@type': 'Organization', name: settings.site_name, url: origin }
  };
}
