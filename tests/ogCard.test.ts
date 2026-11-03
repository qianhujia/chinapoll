// Card markup tests.
//
// The card is built as an SVG and rasterized by the Worker (see worker/services/ogImage.ts).
// What the builder decides on its own is what this file checks: where a long title breaks,
// that a withheld tally prints no number, that the footer names the poll, and that a hostile
// title cannot leave the text element it belongs in.

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

const STRINGS = { votes: '{n} votes', resultsPending: 'Results not shown yet' };
const SITE = { siteName: 'ChinaPoll', siteUrl: 'chinapoll.org/poll/1' };

function poll(overrides: Partial<OgCardPoll> = {}): OgCardPoll {
  return {
    number: 1,
    title: 'Should the city build more bike lanes?',
    hidden: false,
    ballots: 14,
    answers: [
      { label: 'Yes', count: 12 },
      { label: 'No', count: 2 }
    ],
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
  it('draws the site, the title, the tallies, and the footer at card size', () => {
    const svg = buildOgCardSvg(poll({ title: 'Bike lanes?' }), SITE, STRINGS);

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}"`);
    expect(svg).toContain('ChinaPoll');
    expect(svg).toContain('Bike lanes?');
    // One line of tallies, in the order the options are published.
    expect(svg).toContain('Yes 12 · No 2');
    // The footer shows how many ballots are in and the address the poll lives at.
    expect(svg).toContain('14 votes · chinapoll.org/poll/1');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('wraps a long title into its own text lines', () => {
    const title = 'Should the city build more bike lanes on the main road this year?';
    const svg = buildOgCardSvg(poll({ title }), SITE, STRINGS);

    // Every line the wrapper produced is drawn, and the whole title is on the card.
    const lines = wrapText(title, 54, OG_CARD_WIDTH - 2 * 96, 3);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(svg).toContain(line);
    expect(lines.join('').replace(/…$/, '')).toContain('Should the city build');
  });

  it('prints no tally while the results are withheld', () => {
    const svg = buildOgCardSvg(
      poll({ hidden: true, ballots: null, answers: [{ label: 'Yes', count: null }, { label: 'No', count: null }] }),
      SITE,
      STRINGS
    );

    expect(svg).toContain('Results not shown yet');
    // Neither the option counts nor the ballot total reach the card.
    expect(svg).not.toContain('Yes 12');
    expect(svg).not.toContain('14 votes');
    expect(svg).toContain('chinapoll.org');
  });

  it('numbers the tallies when the counts are published', () => {
    const svg = buildOgCardSvg(
      poll({ answers: [{ label: '赞同', count: 12 }, { label: '中立', count: 1 }, { label: '反对', count: 1 }] }),
      SITE,
      { votes: '已有 {n} 人投票', resultsPending: '结果暂不显示' }
    );

    expect(svg).toContain('赞同 12 · 中立 1 · 反对 1');
    expect(svg).toContain('已有 14 人投票 · chinapoll.org/poll/1');
  });

  it('escapes a hostile title instead of letting it close the text element', () => {
    const svg = buildOgCardSvg(poll({ title: '</text><script>alert(1)</script>' }), SITE, STRINGS);

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;');
    // The card's own elements: the site name, the title, the tallies, and the footer.
    expect(svg.match(/<text /g)).toHaveLength(4);
  });
});
