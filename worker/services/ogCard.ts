// The Open Graph card a poll is shared with: one flat SVG the rasterizer turns into a PNG
// (see ogImage.ts). The card is deliberately plain - the site's name above the poll's title -
// so a shared link shows what the link is about without the sharer writing a word of their
// own.
//
// Line breaking is estimated rather than measured: the rasterizer lays the text out but
// does not report the width it used, so `estimateTextWidth` prices each character from its
// script (a CJK glyph fills an em, Latin roughly half of one) and `wrapText` breaks the
// title on that budget. The estimate only decides where a title wraps, so an off-by-one
// costs a slightly early break, never a wrong number.

export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

// The palette the card is drawn in, matching the site's own tokens (src/styles.css).
const PRIMARY = '#143d7d';
const TITLE_COLOR = '#dc2626';
const PAGE = '#f4f7fb';
const PANEL = '#ffffff';
const BORDER = '#dfe5ee';

const SITE_FONT_SIZE = 42;
const SITE_NAME_Y = 180;
const TITLE_FONT_SIZE = 54;
const TITLE_LINE_HEIGHT = 72;
const TITLE_MAX_LINES = 3;
const TITLE_MAX_WIDTH = OG_CARD_WIDTH - 2 * 96;
// The title block is centered on this line, whatever number of rows it needs.
const TITLE_CENTER_Y = 390;

export interface OgCardPoll {
  /** The public number: the card is addressed by it. */
  number: number;
  title: string;
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[character] ?? character);
}

// One line of plain text: control characters dropped (they cannot be drawn), and every run
// of whitespace folded into a single space, the way a meta description is.
export function cardText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// How wide one character is expected to be, in ems. A CJK ideograph or full-width
// punctuation fills the em; Latin letters, digits, and punctuation take about half.
export function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x20) return 0.28;
  if (code === 0xb7 || code === 0x2013 || code === 0x2014) return 0.4;
  // CJK Unified Ideographs, Kana, Hangul, compatibility ideographs, full-width forms, and
  // the CJK symbols the card's own lines could carry.
  if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x3000 && code <= 0x303f)) return 1;
  return 0.55;
}

export function estimateTextWidth(text: string, fontSize: number): number {
  let ems = 0;
  for (const character of text) ems += characterWidth(character);
  return ems * fontSize;
}

// Breaks `text` into at most `maxLines` lines that fit `maxWidth`. A break is preferred at
// a space, and taken mid-word only when the run of text carries no space to break on - a
// Chinese title has none. Text that does not fit is cut and marked with an ellipsis.
export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  maxLines: number
): string[] {
  const trimmed = cardText(text);
  if (!trimmed) return [];

  const lines: string[] = [];
  let line = '';
  let lastSpace = -1;

  for (const character of trimmed) {
    const candidate = line + character;
    if (line && estimateTextWidth(candidate, fontSize) > maxWidth) {
      // A space earlier in the line is the natural break; otherwise the break is here.
      const breakAt = lastSpace > 0 ? lastSpace : line.length;
      lines.push(line.slice(0, breakAt).trimEnd());
      line = line.slice(breakAt).trimStart() + character;
      lastSpace = -1;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
    if (character === ' ') lastSpace = line.length - 1;
  }

  if (lines.length < maxLines && line.trim()) lines.push(line.trim());

  // Whatever is left over was dropped, so the last line says so.
  if (lines.length === maxLines) {
    const kept = lines.join('').replace(/ /g, '').length;
    if (kept < trimmed.replace(/ /g, '').length) {
      let last = lines[maxLines - 1];
      while (last && estimateTextWidth(`${last}…`, fontSize) > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last.trimEnd()}…`;
    }
  }

  return lines;
}

export function buildOgCardSvg(
  poll: OgCardPoll,
  options: { siteName: string }
): string {
  const centerX = OG_CARD_WIDTH / 2;
  const titleLines = wrapText(poll.title, TITLE_FONT_SIZE, TITLE_MAX_WIDTH, TITLE_MAX_LINES);
  // The title block is centered on the card: the first baseline sits half the block's height
  // above the middle, so a one-line and a three-line title share the same optical center.
  const firstBaseline = TITLE_CENTER_Y - ((titleLines.length - 1) * TITLE_LINE_HEIGHT) / 2;
  const title = titleLines.map((line, index) => (
    `<text x="${centerX}" y="${firstBaseline + index * TITLE_LINE_HEIGHT}" text-anchor="middle"`
    + ` font-family="Noto Sans SC" font-size="${TITLE_FONT_SIZE}" font-weight="700"`
    + ` fill="${TITLE_COLOR}">${escapeXml(line)}</text>`
  )).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}" viewBox="0 0 ${OG_CARD_WIDTH} ${OG_CARD_HEIGHT}">`
    + `<rect width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}" fill="${PAGE}"/>`
    + `<rect x="48" y="48" width="${OG_CARD_WIDTH - 96}" height="${OG_CARD_HEIGHT - 96}" rx="28" fill="${PANEL}" stroke="${BORDER}"/>`
    + `<text x="${centerX}" y="${SITE_NAME_Y}" text-anchor="middle" font-family="Noto Sans SC" font-size="${SITE_FONT_SIZE}" fill="${PRIMARY}">${escapeXml(cardText(options.siteName))}</text>`
    + title
    + '</svg>';
}
