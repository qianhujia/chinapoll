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
import { renderPollRow, renderTopicChips, TOPIC_CHIP_LIMIT } from '../src/pages/home';
import { renderFooter } from '../src/ui';
import type { PollWithStats } from '../src/lib/poll';

// The shared row layout: identity and badges on the left, the ballot total, the
// view count, and the vote link on the right.
const ROW_LAYOUT = 'grid grid-cols-[minmax(0,1fr)_minmax(190px,240px)] items-center gap-x-8';

// One list entry, shaped like the `/api/polls` page response. Translations are
// not loaded in this environment, so `t()` falls back to the i18n key and the
// assertions below read those keys.
function makeEntry(overrides: {
  pollType?: PollWithStats['poll']['pollType'];
  hidden?: boolean;
  ballots?: number;
  options?: PollWithStats['poll']['options'];
  views?: PollWithStats['views'];
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
      options: hidden ? null : [],
      voted: false
    },
    views: overrides.views ?? null
  };
}

describe('renderPollRow', () => {
  it('lists a poll with a vote link and no vote controls', () => {
    const markup = renderPollRow(makeEntry({ pollType: 'single_choice', ballots: 12 }));

    expect(markup).toContain('data-poll-row="7"');
    // Voting happens on the poll page: the row offers links only.
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('data-vote-group');
    expect(markup).not.toContain('data-option');
    expect(markup).not.toContain('data-home-vote');
    // The title and the vote link both point at the poll's public number, not at
    // its primary key.
    expect(markup.match(/href="\/poll\/42"/g)).toHaveLength(2);
    expect(markup).not.toContain('/poll/7');
    expect(markup).toContain('>vote</a>');
    // Every poll counts ballots now, so the unit is always "ballots".
    expect(markup).toContain('12 ballots');
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
      expect(markup.match(/href="\/poll\/42"/g)).toHaveLength(2);
      expect(markup).toContain('>vote</a>');
    }
    expect(multi).toContain('12 ballots');
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
    expect(markup).toContain('12 ballots');
    // The row still offers a link rather than voting in place.
    expect(markup).not.toContain('<button');
    expect(markup.match(/href="\/poll\/42"/g)).toHaveLength(2);
  });

  it('shows the threshold notice instead of the total and keeps the vote link', () => {
    const markup = renderPollRow(makeEntry({ hidden: true, ballots: 3 }));

    expect(markup).toContain('resultsHidden');
    expect(markup).not.toContain('3 ballots');
    // The notice replaces the total only, never the link to the poll.
    expect(markup).toContain('>vote</a>');
  });

  it('shows the view count only when the server publishes it', () => {
    const published = renderPollRow(makeEntry({ views: { total: 42, last7Days: 5 } }));
    const withheld = renderPollRow(makeEntry({ views: null }));

    expect(published).toContain('title="views"');
    expect(published).toContain('42');
    expect(withheld).not.toContain('title="views"');
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
