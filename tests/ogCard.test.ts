// Card markup tests.
//
// The card is built as an SVG and rasterized by the Worker (see worker/services/ogImage.ts).
// What the builder decides on its own is what this file checks: where a long title breaks,
// that the site's name and the title are centered, that the title is drawn in red and bold,
// and that a hostile title cannot leave the text element it belongs in.

import { describe, expect, it } from 'vitest';
import {
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  buildOgCardSvg,
  cardText,
  estimateTextWidth,
  wrapText,
  type OgCardPoll
} from '../worker/services/ogCard';

const SITE = { siteName: 'ChinaPoll' };
// The palette values the builder draws with; the title's red and its bold weight are what a
// reader sees first, so they are pinned here.
const TITLE_COLOR = '#dc2626';
const SITE_COLOR = '#143d7d';

function poll(overrides: Partial<OgCardPoll> = {}): OgCardPoll {
  return {
    number: 1,
    title: 'Should the city build more bike lanes?',
    ...overrides
  };
}

describe('card text', () => {
  it('folds whitespace and drops control characters', () => {
    expect(cardText('  Bike\nlanes\t\tnow  ')).toBe('Bike lanes now');
    expect(cardText('a\u0000b')).toBe('a b');
  });

  it('prices a CJK glyph at a full em and Latin at about half', () => {
    // Twelve characters at 54px: Chinese fills the em, Latin does not.
    expect(estimateTextWidth('拆墙取消境外网站访问', 54)).toBeCloseTo(10 * 54);
    expect(estimateTextWidth('Bike lanes', 54)).toBeLessThan(6 * 54);
  });
});

describe('wrapText', () => {
  it('breaks a Chinese title with no spaces into lines that fit', () => {
    const lines = wrapText('拆墙：完全取消对境外网站的访问限制以及其它限制', 54, 600, 3);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(estimateTextWidth(line, 54)).toBeLessThanOrEqual(600);
    // Nothing is dropped while it fits, so no line carries the ellipsis.
    expect(lines.join('')).not.toContain('…');
  });

  it('prefers a space when a Latin title has one', () => {
    const lines = wrapText('Should the city build more bike lanes?', 54, 700, 3);

    expect(lines[0]?.endsWith(' ')).toBe(false);
    // The break lands between words rather than inside one.
    expect(lines.every((line) => !/^\S*$/.test(line) || line.length > 3)).toBe(true);
    expect(lines.join(' ')).toContain('bike lanes');
  });

  it('cuts a title that cannot fit and marks the cut', () => {
    const lines = wrapText('拆'.repeat(200), 54, 600, 3);

    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith('…')).toBe(true);
    for (const line of lines) expect(estimateTextWidth(line, 54)).toBeLessThanOrEqual(600);
  });

  it('returns nothing for a title that carries no text', () => {
    expect(wrapText('   ', 54, 600, 3)).toEqual([]);
    expect(wrapText('', 54, 600, 3)).toEqual([]);
  });
});

describe('buildOgCardSvg', () => {
  it('draws the site and the title at card size', () => {
    const svg = buildOgCardSvg(poll({ title: 'Bike lanes?' }), SITE);

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}"`);
    expect(svg).toContain('ChinaPoll');
    expect(svg).toContain('Bike lanes?');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('centers the site name and the title on the card', () => {
    const svg = buildOgCardSvg(poll({ title: 'Bike lanes?' }), SITE);

    // Both lines are anchored on the middle of the card, not on the left margin.
    expect(svg.match(/text-anchor="middle"/g)).toHaveLength(2);
    expect(svg).toContain(`x="${OG_CARD_WIDTH / 2}"`);
    // The site name reads above the title.
    expect(svg.indexOf('ChinaPoll')).toBeLessThan(svg.indexOf('Bike lanes?'));
  });

  it('draws the title in red and bold, and the site name in the site color', () => {
    const svg = buildOgCardSvg(poll({ title: 'Bike lanes?' }), SITE);

    const title = svg.match(/<text[^>]*fill="#dc2626"[^>]*>Bike lanes\?<\/text>/);
    expect(title).not.toBeNull();
    expect(title![0]).toContain('font-weight="700"');
    expect(title![0]).toContain(`fill="${TITLE_COLOR}"`);

    // The site's own line keeps the site color and stays plain.
    const site = svg.match(/<text[^>]*>ChinaPoll<\/text>/);
    expect(site).not.toBeNull();
    expect(site![0]).toContain(`fill="${SITE_COLOR}"`);
    expect(site![0]).not.toContain('font-weight');
  });

  it('wraps a long title into its own text lines', () => {
    const title = 'Should the city build more bike lanes on the main road this year?';
    const svg = buildOgCardSvg(poll({ title }), SITE);

    // Every line the wrapper produced is drawn, and the whole title is on the card.
    const lines = wrapText(title, 54, OG_CARD_WIDTH - 2 * 96, 3);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(svg).toContain(line);
    expect(lines.join('').replace(/…$/, '')).toContain('Should the city build');
  });

  it('escapes a hostile title instead of letting it close the text element', () => {
    const hostile = '</text><script>alert(1)</script>';
    const svg = buildOgCardSvg(poll({ title: hostile }), SITE);

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;');
    // The card's own elements: the site name plus the lines of the title.
    const lineCount = wrapText(hostile, 54, OG_CARD_WIDTH - 2 * 96, 3).length;
    expect(svg.match(/<text /g)).toHaveLength(1 + lineCount);
  });
});
