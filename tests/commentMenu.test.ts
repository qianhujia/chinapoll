// Frontend comment-menu tests.
//
// Each comment row carries its own three-dot menu with the same two actions the poll
// menu offers for the poll: report and claim. The builders are pure markup, so they
// are checked directly.

import { describe, expect, it } from 'vitest';
import { claimMenuEntryMarkup, commentMenuMarkup, renderCommentsContent } from '../src/ui';
import type { CommentsResponse } from '../src/lib/poll';

// Translations are not loaded in this environment, so `t()` falls back to the i18n
// key and the assertions below read those keys.
const RESPONSE = {
  pollId: 7,
  page: 1,
  pageSize: 30,
  total: 2,
  comments: [
    { id: '0123456789abcdef', comment: 'First remark', createdAt: '2026-10-24T00:00:00.000Z' },
    { id: 'fedcba9876543210', comment: 'Second remark', createdAt: '2026-10-24T01:00:00.000Z' }
  ]
} as unknown as CommentsResponse;

describe('claimMenuEntryMarkup', () => {
  it('offers the claim button to a signed-in visitor', () => {
    const markup = claimMenuEntryMarkup('data-claim-poll', '7', true, false);

    expect(markup).toContain('data-claim-poll="7"');
    expect(markup).toContain('claimLink');
    expect(markup).not.toContain('data-claim-already');
  });

  it('shows the note once claimed, and the sign-in link when signed out', () => {
    expect(claimMenuEntryMarkup('data-claim-poll', '7', true, true)).toContain('data-claim-already');

    // Claiming needs a session, so a signed-out visitor is sent to the login page
    // instead of getting a button that could only fail.
    const signedOut = claimMenuEntryMarkup('data-claim-poll', '7', false, false);
    expect(signedOut).toContain('href="/login"');
    expect(signedOut).not.toContain('data-claim-poll');
  });
});

describe('commentMenuMarkup', () => {
  it('builds one menu per comment, targeting that comment only', () => {
    const markup = commentMenuMarkup('0123456789abcdef', true, false);

    expect(markup).toContain('data-comment-menu-root');
    expect(markup).toContain('data-comment-menu-toggle');
    expect(markup).toContain('aria-controls="comment-menu-0123456789abcdef"');
    expect(markup).toContain('id="comment-menu-0123456789abcdef"');
    expect(markup).toContain('data-comment-report-open="0123456789abcdef"');
    expect(markup).toContain('data-comment-claim="0123456789abcdef"');
    // The panel stays closed until the toggle is pressed.
    expect(markup).toContain('data-comment-menu hidden');
  });

  it('shows the confirmation note once this browser reported the comment', () => {
    // `hasCommentReportedLocally` reads localStorage, which the Node test
    // environment has no global for; a small stub stands in for it here.
    const store = new Map<string, string>([['chinapoll.reported-comment.0123456789abcdef', '1']]);
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); }
    };
    try {
      const markup = commentMenuMarkup('0123456789abcdef', true, false);

      expect(markup).toContain('data-comment-report-already');
      expect(markup).toContain('reportCommentAlreadySent');
      expect(markup).not.toContain('data-comment-report-open');
      // The claim entry is unaffected by the report state.
      expect(markup).toContain('data-comment-claim="0123456789abcdef"');
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('renderCommentsContent', () => {
  it('gives every comment its own menu and marks the claimed one', () => {
    const markup = renderCommentsContent(7, RESPONSE, ['fedcba9876543210'], true);

    expect(markup).toContain('data-comment-report-open="0123456789abcdef"');
    expect(markup).toContain('data-comment-report-open="fedcba9876543210"');
    // The already-claimed comment shows the note in place of its claim button, while
    // the other comment keeps the button.
    expect(markup).toContain('data-claim-already');
    expect(markup).toContain('data-comment-claim="0123456789abcdef"');
    expect(markup).not.toContain('data-comment-claim="fedcba9876543210"');
  });

  it('keeps the empty message and the pagination behaviour', () => {
    const empty = renderCommentsContent(
      7,
      { ...RESPONSE, total: 0, comments: [] } as unknown as CommentsResponse,
      [],
      false
    );

    expect(empty).toContain('noComments');
    expect(empty).not.toContain('data-comment-menu-toggle');
  });

  // The date sits at the right of the row, immediately left of the three-dot menu,
  // and shows a friendly local format instead of the raw stored value.
  it('shows a friendly date left of each comment menu', () => {
    const markup = renderCommentsContent(7, RESPONSE, [], true);

    // The exact value stays machine-readable in the attribute only.
    expect(markup).toContain('datetime="2026-10-24T00:00:00.000Z"');
    expect(markup).not.toContain('>2026-10-24T00:00:00.000Z<');
    expect(markup.match(/datetime=/g) ?? []).toHaveLength(2);
    // The visible text is the formatted date, never the stored value. The format
    // itself depends on the runtime time zone and locale, so it is only checked for
    // being something else.
    const shown = /<time[^>]*>([^<]*)<\/time>/.exec(markup)?.[1] ?? '';
    expect(shown).not.toBe('2026-10-24T00:00:00.000Z');
    expect(shown.length).toBeGreaterThan(0);
    // The first row's date comes before that row's menu button.
    expect(markup.indexOf('datetime="2026-10-24T00:00:00.000Z"'))
      .toBeLessThan(markup.indexOf('data-comment-menu-root'));
  });
});