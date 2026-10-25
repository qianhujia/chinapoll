// Account dashboard tests.
//
// The dashboard is a two-column layout: a left menu with the three account
// sections and the panel of the selected one. The builders are pure strings, so the
// menu, the active mark, and the panels are checked directly.

import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_SECTIONS,
  accountCommentsPanelMarkup,
  accountDashboardMarkup,
  accountMenuMarkup,
  accountPanelMarkup,
  accountPollsPanelMarkup,
  accountSectionFromRoute
} from '../src/pages/account';
import type { UserComment, UserPoll } from '../src/lib/session';

// Translations are not loaded in this environment, so `t()` falls back to the i18n
// key and the assertions below read those keys.

const POLL: UserPoll = {
  id: 7,
  number: 7,
  title: 'Transit funding',
  description: null,
  mode: 'evergreen',
  status: 'open',
  startAt: null,
  endAt: null,
  createdAt: '2026-10-17T00:00:00.000Z'
};

const COMMENT: UserComment = {
  id: '0123456789abcdef',
  pollId: 7,
  pollNumber: 7,
  pollTitle: 'Transit funding',
  comment: 'A short remark',
  createdAt: '2026-10-17T00:00:00.000Z'
};

describe('accountSectionFromRoute', () => {
  it('maps the three dashboard routes and falls back to the account section', () => {
    expect(accountSectionFromRoute('/account')).toBe('account');
    expect(accountSectionFromRoute('/account/polls')).toBe('polls');
    expect(accountSectionFromRoute('/account/comments')).toBe('comments');
    // Anything else shows the account panel rather than an empty dashboard.
    expect(accountSectionFromRoute('/account/unknown')).toBe('account');
    expect(accountSectionFromRoute('/')).toBe('account');
  });
});

describe('accountMenuMarkup', () => {
  it('lists the three sections in order with the active one marked', () => {
    const markup = accountMenuMarkup('polls');

    expect(ACCOUNT_SECTIONS.map((entry) => entry.route)).toEqual(['/account', '/account/polls', '/account/comments']);
    // One link per section, in menu order, each with its own route.
    const order = ['/account', '/account/polls', '/account/comments'].map((route) => markup.indexOf(`href="${route}"`));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    // The three labels come from the shared account keys.
    expect(markup).toContain('accountPollsTitle');
    expect(markup).toContain('accountCommentsTitle');
    // The active item is announced and styled as the current page.
    expect(markup).toContain('data-account-nav="polls"');
    expect(markup).toContain('aria-current="page"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup.match(/font-bold text-primary/g)).toHaveLength(1);
  });
});

describe('accountDashboardMarkup', () => {
  it('orders the menu before the panel in a two-column shell', () => {
    // The header reads the search box state from `window.location`, which the Node
    // test environment does not provide.
    vi.stubGlobal('window', { location: { search: '' } });
    const markup = accountDashboardMarkup('comments', 'PANEL');
    const menu = markup.indexOf('data-account-nav="account"');
    const panel = markup.indexOf('PANEL');

    expect(markup).toContain('md:grid-cols-[220px_minmax(0,1fr)]');
    expect(menu).toBeGreaterThan(-1);
    expect(menu).toBeLessThan(panel);
    vi.unstubAllGlobals();
  });
});

describe('account panels', () => {
  it('renders the account panel with the recovery, logout and delete actions', () => {
    const markup = accountPanelMarkup({ username: 'alice', createdAt: '2026-10-17T00:00:00.000Z' }, true);

    expect(markup).toContain('alice');
    expect(markup).toContain('data-logout');
    expect(markup).toContain('data-logout-all');
    expect(markup).toContain('data-regenerate-recovery');
    expect(markup).toContain('data-delete-account');
  });

  it('renders the polls panel with the poll actions', () => {
    const markup = accountPollsPanelMarkup([POLL], false, '');

    expect(markup).toContain('Transit funding');
    expect(markup).toContain('data-close-poll="7"');
    // An empty list explains itself instead of failing.
    expect(accountPollsPanelMarkup([], false, '')).toContain('accountNoPolls');
    expect(accountPollsPanelMarkup([], false, 'boom')).toContain('boom');
  });

  it('renders the comments panel with the poll each comment belongs to', () => {
    const markup = accountCommentsPanelMarkup([COMMENT], false, '');

    expect(markup).toContain('A short remark');
    expect(markup).toContain('data-delete-comment="0123456789abcdef"');
    // The comment links back to the poll it was posted on.
    expect(markup).toContain('href="/poll/7"');
    expect(markup).toContain('Transit funding');
    expect(accountCommentsPanelMarkup([], false, '')).toContain('accountNoComments');
  });

  it('shows a load-more button only while a further page exists', () => {
    expect(accountPollsPanelMarkup([POLL], true, '')).toContain('data-load-more-polls');
    expect(accountPollsPanelMarkup([POLL], false, '')).not.toContain('data-load-more-polls');
    expect(accountCommentsPanelMarkup([COMMENT], true, '')).toContain('data-load-more-comments');
    expect(accountCommentsPanelMarkup([COMMENT], false, '')).not.toContain('data-load-more-comments');
  });

  it('escapes a comment body and title', () => {
    const markup = accountCommentsPanelMarkup([{
      ...COMMENT,
      comment: '<script>alert(1)</script>',
      pollTitle: '<b>t</b>'
    }], false, '');

    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;b&gt;t&lt;/b&gt;');
  });
});
