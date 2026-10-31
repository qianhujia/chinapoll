// SEO text shared by the public Worker and the SPA.
//
// A meta description is plain, single-line text: a search engine or a card builder
// prints it as one sentence, so markup in it leaks tags into the snippet and a line
// break runs two sentences together. Both sides pass every description through
// `seoDescription` before writing the tag, whatever the text they started from - a poll
// description, a site slogan, or a dictionary string.

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

// The image a link card shows for the site: the configured logo, or the favicon while
// no logo is set. A card builder fetches the URL itself and cannot read a path, so a
// branding route the site serves (/image/logo.png) is resolved against the origin the
// page is published on, while an https URL the operator pasted is already absolute and
// is used as it is. Empty when neither is configured, which leaves the card without an
// image.
export function shareImageUrl(
  branding: { logo?: string; favicon?: string },
  origin: string
): string {
  for (const value of [branding.logo, branding.favicon]) {
    const image = (value ?? '').trim();
    if (!image) continue;
    if (/^https:\/\//i.test(image)) return image;
    if (image.startsWith('/')) return origin + image;
  }
  return '';
}
