// Frontend comment-menu tests.
//
// Each comment row carries its own three-dot menu with the report action. The
// builders are pure markup, so they are checked directly.

import { describe, expect, it } from 'vitest';
import { commentMenuEntriesMarkup, commentMenuMarkup, renderCommentsContent } from '../src/ui';
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

describe('commentMenuEntriesMarkup', () => {
  it('offers the report entry', () => {
    const markup = commentMenuEntriesMarkup('0123456789abcdef');

    expect(markup).toContain('data-comment-report-open="0123456789abcdef"');
    expect(markup).toContain('reportLink');
    expect(markup).not.toContain('data-comment-report-already');
  });
});

describe('commentMenuMarkup', () => {
  it('builds one menu per comment, targeting that comment only', () => {
    const markup = commentMenuMarkup('0123456789abcdef');

    expect(markup).toContain('data-comment-menu-root');
    expect(markup).toContain('data-comment-menu-toggle');
    expect(markup).toContain('aria-controls="comment-menu-0123456789abcdef"');
    expect(markup).toContain('id="comment-menu-0123456789abcdef"');
    expect(markup).toContain('data-comment-report-open="0123456789abcdef"');
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
      const markup = commentMenuMarkup('0123456789abcdef');

      expect(markup).toContain('data-comment-report-already');
      expect(markup).toContain('reportCommentAlreadySent');
      expect(markup).not.toContain('data-comment-report-open');
    } finally {
      delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('renderCommentsContent', () => {
  it('gives every comment its own menu', () => {
    const markup = renderCommentsContent(7, RESPONSE, true);

    expect(markup).toContain('data-comment-report-open="0123456789abcdef"');
    expect(markup).toContain('data-comment-report-open="fedcba9876543210"');
  });

  it('keeps the empty message and the pagination behaviour', () => {
    const empty = renderCommentsContent(
      7,
      { ...RESPONSE, total: 0, comments: [] } as unknown as CommentsResponse,
      false
    );

    expect(empty).toContain('noComments');
    expect(empty).not.toContain('data-comment-menu-toggle');
  });

  // The date sits at the right of the row, immediately left of the three-dot menu,
  // and shows a friendly local format instead of the raw stored value.
  it('shows a friendly date left of each comment menu', () => {
    const markup = renderCommentsContent(7, RESPONSE, true);

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
