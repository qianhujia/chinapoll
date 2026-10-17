// Frontend poll-list tests.
//
// `renderPollRow` is pure markup, so it is checked directly: the home page lists
// every poll type the same way and never builds vote controls, which is what
// keeps a verdict poll in the list indistinguishable from a choice poll.

import { describe, expect, it } from 'vitest';
import { renderPollRow } from '../src/pages/home';
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
  const pollType = overrides.pollType ?? 'verdict';
  const hidden = overrides.hidden ?? false;
  return {
    poll: {
      id: 7,
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
      counts: null,
      voted: false
    },
    views: overrides.views ?? null
  };
}

describe('renderPollRow', () => {
  it('lists a verdict poll with a vote link and no vote controls', () => {
    const markup = renderPollRow(makeEntry({ pollType: 'verdict', ballots: 12 }));

    expect(markup).toContain('data-poll-row="7"');
    // Voting happens on the poll page: the row offers links only.
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('data-vote-group');
    expect(markup).not.toContain('data-option');
    expect(markup).not.toContain('data-home-vote');
    // The title and the vote link both point at the poll page.
    expect(markup.match(/href="\/poll\/7"/g)).toHaveLength(2);
    expect(markup).toContain('>vote</a>');
    expect(markup).toContain('12 votes');
  });

  it('lists a choice poll exactly like a verdict poll', () => {
    const verdict = renderPollRow(makeEntry({ pollType: 'verdict', ballots: 12 }));
    const choice = renderPollRow(makeEntry({
      pollType: 'multi_choice',
      ballots: 12,
      options: [
        { id: 11, label: 'Alpha', position: 1, virtual: false },
        { id: 12, label: 'Beta', position: 2, virtual: false }
      ]
    }));

    // Same row, same actions; only the type badge and the ballot unit differ.
    for (const markup of [verdict, choice]) {
      expect(markup).toContain(ROW_LAYOUT);
      expect(markup).not.toContain('<button');
      expect(markup.match(/href="\/poll\/7"/g)).toHaveLength(2);
      expect(markup).toContain('>vote</a>');
    }
    expect(choice).toContain('12 ballots');
    expect(choice).toContain('pollTypeMultiChoice');
  });

  it('shows the threshold notice instead of the total and keeps the vote link', () => {
    const markup = renderPollRow(makeEntry({ hidden: true, ballots: 3 }));

    expect(markup).toContain('resultsHidden');
    expect(markup).not.toContain('3 votes');
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
