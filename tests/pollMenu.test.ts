// Frontend poll-menu and report-dialog tests.
//
// `renderPollMenu`, `reportMenuEntryMarkup`, and `reportModalMarkup` are pure
// markup, so they are checked directly: the share button and the three-dot menu at
// the top right of the poll title host the poll's own actions, and the report itself
// is a dialog built on demand instead of a card appended to the page. `sharePoll` is
// the behaviour behind the share button, so it is checked with the browser APIs it
// reaches for stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPollMenu, reportMenuEntryMarkup, reportModalMarkup, sharePoll } from '../src/pages/poll';
import { REPORT_REASONS } from '../src/lib/poll';

// Translations are not loaded in this environment, so `t()` falls back to the
// i18n key and the assertions below read those keys.
describe('renderPollMenu', () => {
  it('builds a collapsed three-dot menu that hosts the report entry', () => {
    const markup = renderPollMenu(7, false);

    // The toggle next to the title, closed by default and announced as a menu.
    expect(markup).toContain('data-poll-menu-root');
    expect(markup).toContain('data-poll-menu-toggle');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-controls="poll-menu"');
    // The three dots: the vertical ellipsis icon draws three circles.
    const toggle = markup.slice(markup.indexOf('data-poll-menu-toggle'), markup.indexOf('id="poll-menu"'));
    expect(toggle.match(/<circle /g)).toHaveLength(3);

    // The report entry sits inside the dropdown, which stays closed until the
    // toggle is pressed. The form is not part of the menu.
    const panel = markup.slice(markup.indexOf('id="poll-menu"'), markup.indexOf('data-poll-menu-backdrop'));
    expect(panel).toContain('role="menu"');
    expect(panel).toContain('hidden');
    expect(panel).toContain('role="menuitem"');
    expect(panel).toContain('data-report-open');
    expect(panel).toContain('reportLink');
    expect(panel).not.toContain('data-report-already');
    expect(markup).not.toContain('data-report-form');
    expect(markup).not.toContain('data-report-dialog');
  });

  it('shows the confirmation note in place of the entry once the poll is reported', () => {
    const markup = renderPollMenu(7, true);
    const panel = markup.slice(markup.indexOf('id="poll-menu"'), markup.indexOf('data-poll-menu-backdrop'));

    // The menu stays available, but it no longer offers the report action.
    expect(markup).toContain('data-poll-menu-toggle');
    expect(panel).toContain('data-report-already');
    expect(panel).toContain('reportAlreadySent');
    expect(panel).not.toContain('data-report-open');
  });

  // Sharing is an action of its own, not a menu entry: the button sits to the left of
  // the dots so the poll's actions read as one group.
  it('puts a share button to the left of the three dots', () => {
    const markup = renderPollMenu(7, false);

    expect(markup).toContain('data-poll-share');
    expect(markup).toContain('aria-label="sharePoll"');
    // The share mark - three nodes joined by two lines - is not the menu's ellipsis.
    expect(markup).toContain('<circle cx="18" cy="5" r="3" />');
    expect(markup).toContain('<line x1="8.59" x2="15.42"');
    // The button comes before the menu root, and both are the same 36px round icon
    // button.
    expect(markup.indexOf('data-poll-share')).toBeLessThan(markup.indexOf('data-poll-menu-root'));
    expect(markup.match(/h-9 w-9 cursor-pointer items-center justify-center rounded-full/g)).toHaveLength(2);
    // Sharing never opens the dropdown: the panel stays closed until the dots are
    // pressed.
    expect(markup.slice(0, markup.indexOf('data-poll-menu-root'))).not.toContain('role="menu"');
  });
});

describe('reportMenuEntryMarkup', () => {
  it('offers the report entry until the report is sent', () => {
    const markup = reportMenuEntryMarkup(false);

    expect(markup).toContain('data-report-open');
    expect(markup).toContain('role="menuitem"');
    expect(markup).not.toContain('data-report-already');
  });

  it('replaces the entry with a plain confirmation note afterwards', () => {
    const markup = reportMenuEntryMarkup(true);

    // A static note rather than a disabled button, since the action is gone for
    // this browser.
    expect(markup).toContain('data-report-already');
    expect(markup).toContain('reportAlreadySent');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('data-report-open');
  });
});

describe('reportModalMarkup', () => {
  it('renders a dialog with one radio per reason and the submit button disabled', () => {
    const markup = reportModalMarkup();

    expect(markup).toContain('data-report-dialog');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="report-modal-title"');
    expect(markup).toContain('id="report-modal-title"');
    expect(markup).toContain('data-report-form');
    expect(markup.match(/data-report-reason/g)).toHaveLength(REPORT_REASONS.length);
    expect(markup).toContain('data-report-submit disabled');
    expect(markup).toContain('data-report-cancel');
    expect(markup).toContain('data-report-status');
    expect(markup).toContain('data-report-note-wrap hidden');
    // The Turnstile widget is rendered only when a site key is configured, which
    // the built-in defaults used here do not provide.
    expect(markup).not.toContain('data-turnstile-report');
    // The confirmation note belongs to the menu entry, not to the dialog, and the
    // old trailing report card is gone.
    expect(markup).not.toContain('data-report-already');
    expect(markup).not.toContain('data-report-root');
  });
});
describe('sharePoll', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Stands in for the page the share runs in: the origin the canonical address is
  // built from, the browser APIs it may reach for, and the toast it reports through.
  function stubPage(options: {
    share?: (data: { title?: string; url?: string }) => Promise<void>;
    clipboard?: { writeText: (text: string) => Promise<void> };
  } = {}) {
    const copied: string[] = [];
    const shared: Array<{ title?: string; url?: string }> = [];
    const toast = { innerHTML: '', hidden: true };
    vi.stubGlobal('window', { location: { origin: 'https://chinapoll.org' } });
    vi.stubGlobal('navigator', {
      ...(options.share
        ? { share: async (data: { title?: string; url?: string }) => { shared.push(data); await options.share!(data); } }
        : {}),
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
          await options.clipboard?.writeText(text);
        }
      }
    });
    vi.stubGlobal('document', { querySelector: () => toast });
    return { copied, shared, toast };
  }

  it('hands the poll to the browser share sheet when there is one', async () => {
    const page = stubPage({ share: async () => {} });

    await sharePoll(42, 'Bike lanes on Main Street');

    // The canonical address, with the poll's number and title, and nothing copied
    // behind the sheet's back.
    expect(page.shared).toEqual([
      { title: '#42 Bike lanes on Main Street', url: 'https://chinapoll.org/poll/42' }
    ]);
    expect(page.copied).toHaveLength(0);
    expect(page.toast.hidden).toBe(true);
  });

  it('copies the canonical address and confirms it when the browser cannot share', async () => {
    const page = stubPage();

    await sharePoll(42, 'Bike lanes on Main Street');

    expect(page.copied).toEqual(['https://chinapoll.org/poll/42']);
    expect(page.toast.hidden).toBe(false);
    expect(page.toast.innerHTML).toContain('shareCopied');
  });

  it('stays quiet when the share sheet is dismissed', async () => {
    const page = stubPage({
      share: async () => { throw Object.assign(new Error('dismissed'), { name: 'AbortError' }); }
    });

    await sharePoll(42, 'Bike lanes on Main Street');

    // Dismissing the sheet is not a failure, and the link is not copied instead.
    expect(page.copied).toHaveLength(0);
    expect(page.toast.hidden).toBe(true);
  });

  it('falls back to the clipboard and reports a failed copy as an error', async () => {
    const page = stubPage({
      share: async () => { throw new Error('unavailable'); },
      clipboard: { writeText: async () => { throw new Error('denied'); } }
    });

    await sharePoll(42, 'Bike lanes on Main Street');

    // A share sheet that fails for another reason leaves the copy as the last resort,
    // and a refused copy is reported instead of claiming success.
    expect(page.toast.hidden).toBe(false);
    expect(page.toast.innerHTML).toContain('shareFailed');
    expect(page.toast.innerHTML).not.toContain('shareCopied');
  });
});
