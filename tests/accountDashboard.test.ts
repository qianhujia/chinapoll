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

  it('renders the polls panel with the poll actions and the add form', () => {
    const markup = accountPollsPanelMarkup([POLL], '');

    expect(markup).toContain('Transit funding');
    expect(markup).toContain('data-close-poll="7"');
    expect(markup).toContain('data-remember-poll-form');
    // An empty list explains itself instead of failing.
    expect(accountPollsPanelMarkup([], '')).toContain('accountNoPolls');
    expect(accountPollsPanelMarkup([], 'boom')).toContain('boom');
  });

  it('renders the comments panel with the poll each comment belongs to', () => {
    const markup = accountCommentsPanelMarkup([COMMENT], '');

    expect(markup).toContain('A short remark');
    expect(markup).toContain('data-delete-comment="0123456789abcdef"');
    // The comment links back to the poll it was posted on.
    expect(markup).toContain('href="/poll/7"');
    expect(markup).toContain('Transit funding');
    // The storage note only appears when there is something to explain.
    expect(markup).toContain('accountCommentsBrowserNote');
    expect(accountCommentsPanelMarkup([], '')).toContain('accountNoComments');
    expect(accountCommentsPanelMarkup([], '')).not.toContain('accountCommentsBrowserNote');
  });

  it('shows the comment id with a copy action and offers the claim form', () => {
    const markup = accountCommentsPanelMarkup([COMMENT], '');

    // The author sees the id so it can be carried to another device...
    expect(markup).toContain('accountCommentIdLabel');
    expect(markup).toContain('data-copy-comment-id="0123456789abcdef"');
    // ... and the claim form is present even with an empty list, so a comment whose
    // id was forgotten can be added back.
    expect(markup).toContain('data-remember-comment-form');
    const empty = accountCommentsPanelMarkup([], '');
    expect(empty).toContain('data-remember-comment-form');
    expect(empty).toContain('accountAddCommentLabel');
  });

  it('escapes a comment body and title', () => {
    const markup = accountCommentsPanelMarkup([{
      ...COMMENT,
      comment: '<script>alert(1)</script>',
      pollTitle: '<b>t</b>'
    }], '');

    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;b&gt;t&lt;/b&gt;');
  });
});
