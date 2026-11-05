// Frontend poll-list and topic-chip tests.
//
// `renderPollRow` and `renderTopicChips` are pure markup, so they are checked
// directly: the home page lists every poll the same way and never builds vote
// controls, which is what keeps a poll in the list indistinguishable from any
// other. The topic chip row shows a few topics at a time and reveals the rest
// behind a toggle.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BAR_CHART_HEIGHT, renderPollRow, renderTopicChips, TOPIC_CHIP_LIMIT } from '../src/pages/home';
import { renderFooter } from '../src/ui';
import type { PollWithStats } from '../src/lib/poll';

// The shared row layout: identity and badges on the left, the vote count on the
// right.
const ROW_LAYOUT = 'grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8';

// One list entry, shaped like the `/api/polls` page response. Translations are
// not loaded in this environment, so `t()` falls back to the i18n key and the
// assertions below read those keys.
function makeEntry(overrides: {
  pollType?: PollWithStats['poll']['pollType'];
  hidden?: boolean;
  ballots?: number;
  options?: PollWithStats['poll']['options'];
  /** The counted options the stats payload carries; absent while they are withheld. */
  counts?: PollWithStats['stats']['options'];
} = {}): PollWithStats {
  const pollType = overrides.pollType ?? 'single_choice';
  const hidden = overrides.hidden ?? false;
  return {
    poll: {
      // The primary key and the public number differ on purpose: every link the
      // row renders has to follow the number.
      id: 7,
      number: 42,
      title: 'Sample poll',
      description: null,
      mode: 'evergreen',
      pollType,
      options: overrides.options ?? [],
      start_at: null,
      status: 'open'
    },
    stats: {
      pollId: 7,
      pollType,
      ballots: overrides.ballots ?? 12,
      hidden,
      threshold: hidden ? 20 : 0,
      options: overrides.counts ?? (hidden ? null : []),
      voted: false
    },
    views: null
  };
}

describe('renderPollRow', () => {
  it('lists a poll with the vote count and no vote button', () => {
    const markup = renderPollRow(makeEntry({ pollType: 'single_choice', ballots: 12 }));

    expect(markup).toContain('data-poll-row="7"');
    // Voting happens on the poll page: the row offers no controls and no vote
    // button, so the title is the only way in.
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('data-vote-group');
    expect(markup).not.toContain('data-option');
    expect(markup).not.toContain('data-home-vote');
    expect(markup).not.toContain('>vote</a>');
    // The title is the only link, and it points at the public number.
    expect(markup.match(/href="\/poll\/42"/g)).toHaveLength(1);
    expect(markup).not.toContain('/poll/7');
    // The count sits against the right edge of the row, and stays on the right when
    // the row stacks on a narrow screen, so the numbers of every poll line up. The
    // column is a stack: the bar diagram above, the ballot total under it.
    expect(markup).toContain('flex flex-col items-end gap-1.5 max-[700px]:col-start-1 max-[700px]:row-auto');
    expect(markup).not.toContain('justify-center');
    expect(markup).not.toContain('max-[700px]:justify-start');
    // The count is the ballot icon and the number, not "12 ballots".
    expect(markup).toContain('data-vote-count');
    expect(markup).toContain('m9 12 2 2 4-4');
    expect(markup).not.toContain('12 ballots');
    // The list shows no view count.
    expect(markup).not.toContain('title="views"');
  });

  it('keeps the number and the title on one line on a narrow screen', () => {
    const markup = renderPollRow(makeEntry());

    // The title shrinks and wraps inside its line rather than being pushed below the
    // number, and the badges break to a line of their own instead of squeezing it.
    expect(markup).toContain('flex min-w-0 flex-wrap items-center gap-2 max-[700px]:items-start');
    expect(markup).toContain('max-[700px]:flex-[1_1_0%]');
    expect(markup).toContain('flex min-w-0 flex-wrap items-center gap-2 max-[700px]:basis-full');
    // The number and the title still sit in one container, number first.
    expect(markup.indexOf('>#42</span>')).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf('>#42</span>')).toBeLessThan(markup.indexOf('Sample poll'));
  });

  it('lists a multiple choice poll exactly like a single choice poll', () => {
    const single = renderPollRow(makeEntry({ pollType: 'single_choice', ballots: 12 }));
    const multi = renderPollRow(makeEntry({
      pollType: 'multi_choice',
      ballots: 12,
      options: [
        { id: 11, label: 'Alpha', position: 1 },
        { id: 12, label: 'Beta', position: 2 }
      ]
    }));

    // Same row, same actions; only the type badge differs.
    for (const markup of [single, multi]) {
      expect(markup).toContain(ROW_LAYOUT);
      expect(markup).not.toContain('<button');
      expect(markup.match(/href="\/poll\/42"/g)).toHaveLength(1);
      expect(markup).toContain('data-vote-count');
    }
    expect(multi).toContain('pollTypeMultiChoice');
  });

  it('names the verdict type without an option count', () => {
    const markup = renderPollRow(makeEntry({
      pollType: 'verdict',
      ballots: 12,
      options: [
        { id: 21, label: 'Approve', position: 1 },
        { id: 22, label: 'Neutral', position: 2 },
        { id: 23, label: 'Oppose', position: 3 }
      ]
    }));

    // The badge names the verdict type and stops there: a list row never repeats
    // how many options the poll carries, even though this entry has three.
    expect(markup).toContain('pollTypeVerdict');
    expect(markup).not.toContain('pollTypeSingleChoice');
    expect(markup).not.toContain('options');
    expect(markup).toContain('data-vote-count');
    // The row still offers the title link rather than voting in place.
    expect(markup).not.toContain('<button');
    expect(markup.match(/href="\/poll\/42"/g)).toHaveLength(1);
  });

  // The standing of every option is drawn as one thin vertical bar with no text on it, and
  // the ballot total follows the group as the number alone. The colours come from the shared
  // palette (see `optionColor`), so an option reads the same way here and on its page.
  it('draws a vertical bar per option with the vote number after the chart', () => {
    const markup = renderPollRow(makeEntry({
      ballots: 10,
      counts: [
        { id: 11, label: 'Yes', position: 1, count: 6 },
        { id: 12, label: 'No', position: 2, count: 4 }
      ]
    }));

    expect(markup).toContain('data-poll-bars');
    expect(markup.match(/data-bar-option=/g)).toHaveLength(2);
    // The bars are thin, clearly separated, and the tallest option fills the chart. Each one
    // carries its option's colour from the shared palette (see `optionColor`), the same colour
    // the poll page's bars and dots use, and the palette opens warm rather than blue.
    expect(markup).toContain('class="flex items-end gap-1"');
    expect(markup).toContain('class="w-1 rounded-t-[2px]"');
    expect(markup).toContain(`style="height:${BAR_CHART_HEIGHT}px;background:#0f766e"`);
    expect(markup).toContain('style="height:10px;background:#c2410c"');
    // Nothing is printed on the bars, neither the option's name nor its share: the option,
    // the count, and the percent travel in the tooltip, and the distribution is repeated for
    // assistive technology.
    expect(markup).toContain('title="Yes: 6 (60%)"');
    expect(markup).toContain('title="No: 4 (40%)"');
    expect(markup).not.toContain('>Yes<');
    expect(markup).not.toContain('>60%<');
    expect(markup).not.toContain('>40%<');
    expect(markup).toContain('<span class="sr-only">Yes 6, No 4</span>');
    // The vote number closes the chart, after every bar, and carries no ballot icon.
    expect(markup).toContain('data-vote-count>10</span>');
    expect(markup.indexOf('data-vote-count')).toBeGreaterThan(markup.indexOf('data-bar-option="12"'));
    expect(markup).not.toContain('<svg');
    // The chart and its number are a second way into the poll, beside the title: the whole
    // group is one link to the poll's own page.
    expect(markup).toContain('href="/poll/42" data-route="/poll/42" data-poll-bars>');
    expect(markup.match(/href="\/poll\/42"/g)).toHaveLength(2);
    // The row still offers no controls.
    expect(markup).not.toContain('<button');
  });

  // A bar is never drawn shorter than a couple of pixels while it holds a vote, so a
  // single ballot stays visible; an option nobody picked gets no bar at all.
  it('keeps a single vote visible and gives an empty option no bar', () => {
    const markup = renderPollRow(makeEntry({
      ballots: 100,
      counts: [
        { id: 11, label: 'Yes', position: 1, count: 99 },
        { id: 12, label: 'No', position: 2, count: 1 },
        { id: 13, label: 'Unsure', position: 3, count: 0 }
      ]
    }));

    expect(markup).toContain(`style="height:${BAR_CHART_HEIGHT}px;background:#0f766e"`);
    expect(markup).toContain('style="height:3px;background:#c2410c"');
    expect(markup).toContain('style="height:0px;background:#7c3aed"');
    // The shares are still reported, in the tooltips.
    expect(markup).toContain('title="Yes: 99 (99%)"');
    expect(markup).toContain('title="No: 1 (1%)"');
    expect(markup).toContain('title="Unsure: 0 (0%)"');
    expect(markup).toContain('data-vote-count>100</span>');
  });

  it('shows the threshold notice instead of the vote count', () => {
    const markup = renderPollRow(makeEntry({ hidden: true, ballots: 3 }));

    expect(markup).toContain('resultsHidden');
    // The notice replaces the count, so no ballot icon and number are shown.
    expect(markup).not.toContain('data-vote-count');
    expect(markup).not.toContain('3 ballots');
    // No bar diagram either: the server withholds every option count below the
    // threshold, so a small sample cannot reveal how an individual voted.
    expect(markup).not.toContain('data-poll-bars');
    expect(markup).not.toContain('data-bar-option');
  });

  it('escapes the poll title', () => {
    const entry = makeEntry();
    entry.poll.title = '<script>alert(1)</script>';

    const markup = renderPollRow(entry);

    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

const CHIP_LABELS = { all: 'All', expand: 'Show more', collapse: 'Collapse' };

function makeTopics(count: number): { slug: string; label: string; count: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `topic-${index + 1}`,
    label: `Topic ${index + 1}`,
    count: index + 1
  }));
}

describe('renderTopicChips', () => {
  it('shows only the limit and hides the rest behind a toggle', () => {
    const markup = renderTopicChips(makeTopics(8), 20, '', CHIP_LABELS);

    expect(markup).toContain('data-topic-chips');
    // "All" plus the first five topics are visible on load.
    expect(markup.match(/data-route="\/topic\/topic-[1-5]"/g)).toHaveLength(TOPIC_CHIP_LIMIT);
    // The remaining topics stay in the document but hidden.
    expect(markup.match(/data-topic-extra/g)).toHaveLength(3);
    expect(markup.match(/ hidden/g)).toHaveLength(3);
    expect(markup).toContain('data-action="toggle-topics"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('>Show more</button>');
    // The toggle reads as text, not as another pill-shaped chip.
    expect(markup).not.toMatch(/<button[^>]*rounded-full/);
    expect(markup).toMatch(/<button[^>]*text-primary[^>]*>Show more<\/button>/);
    // The label swap on expand is carried on the element itself.
    expect(markup).toContain('data-expand-label="Show more"');
    expect(markup).toContain('data-collapse-label="Collapse"');
  });

  it('omits the toggle when every topic already fits', () => {
    const markup = renderTopicChips(makeTopics(TOPIC_CHIP_LIMIT), 5, '', CHIP_LABELS);

    expect(markup).not.toContain('data-action="toggle-topics"');
    expect(markup).not.toContain('data-topic-extra');
    expect(markup.match(/data-route="\/topic\//g)).toHaveLength(TOPIC_CHIP_LIMIT);
  });

  it('keeps the filtered topic visible even when it sorts past the limit', () => {
    const markup = renderTopicChips(makeTopics(8), 20, 'topic-7', CHIP_LABELS);

    // Topics 1 to 7 are visible so the active chip is never hidden.
    expect(markup.match(/data-topic-extra/g)).toHaveLength(1);
    expect(markup).toMatch(/<a class="[^"]*border-primary bg-primary text-white[^"]*" href="\/topic\/topic-7"/);
  });

  it('marks the "All" chip active when no topic is filtered', () => {
    const markup = renderTopicChips(makeTopics(3), 7, '', CHIP_LABELS);
    expect(markup).toMatch(/<a class="[^"]*border-primary bg-primary text-white[^"]*" href="\/"/);
  });

  it('renders nothing when there are no topics', () => {
    expect(renderTopicChips([], 0, '', CHIP_LABELS)).toBe('');
  });

  // A topic the site has no poll for yet is not offered as a filter, while its page
  // stays reachable for anyone holding the link: an empty topic drops out of the row
  // and returns as soon as a poll is filed under it.
  it('leaves out a topic that has no poll yet', () => {
    const topics = [...makeTopics(2), { slug: 'empty', label: 'Empty', count: 0 }];
    const markup = renderTopicChips(topics, 3, '', CHIP_LABELS);

    expect(markup).not.toContain('/topic/empty');
    expect(markup.match(/data-route="\/topic\//g)).toHaveLength(2);
  });

  it('keeps an empty topic visible while it is the one being filtered', () => {
    const topics = [...makeTopics(2), { slug: 'empty', label: 'Empty', count: 0 }];
    const markup = renderTopicChips(topics, 3, 'empty', CHIP_LABELS);

    // Its own page still names it in the row, so the selection is never hidden.
    expect(markup).toContain('href="/topic/empty"');
    expect(markup).toMatch(/border-primary bg-primary text-white[^"]*" href="\/topic\/empty"/);
  });

  it('renders nothing when every topic is empty', () => {
    expect(renderTopicChips([{ slug: 'empty', label: 'Empty', count: 0 }], 0, '', CHIP_LABELS)).toBe('');
  });
});

describe('renderFooter', () => {
  it('builds the credit from the translation instead of hardcoded text', () => {
    const markup = renderFooter();

    // Translations are not loaded here, so `t()` falls back to the key; the
    // point is that the label comes from the dictionary, not the markup.
    expect(markup).toContain('poweredBy');
    expect(markup).not.toContain('Powered by');
    expect(markup).toContain('github.com/qianhujia/chinapoll');
  });
});

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

// Assembled from parts so the Tailwind scanner does not emit the underline
// utility merely because the forbidden class name appears in this test file.
const UNDERLINE_UTILITY = ['hover', 'underline'].join(':');

describe('link styling', () => {
  it('never underlines a link, on the client or in the server-rendered markup', () => {
    // Links are distinguished by colour only, so no underline-on-hover may come
    // back into the client markup or the server-rendered shell.
    for (const file of [...typescriptFiles('src'), join('worker', 'services', 'ssr.ts')]) {
      expect(readFileSync(file, 'utf8'), `${file} must not underline a link`).not.toContain(UNDERLINE_UTILITY);
    }
  });
});
