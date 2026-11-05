// Frontend poll-menu, share-dialog, and report-dialog tests.
//
// `renderPollMenu`, `shareDialogMarkup`, `reportMenuEntryMarkup`, and `reportModalMarkup` are
// pure markup, so they are checked directly: the share button and the three-dot menu at the
// top right of the poll title host the poll's own actions, and both the report and the share
// dialog are built on demand instead of being appended to the page - so the page content
// carries no share row. `copyPollLink` is the behaviour behind the dialog's copy control, so
// it is checked with the browser APIs it reaches for stubbed. The share flow is checked at
// the source level too: the poll page must never reach for the browser's share sheet.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { copyPollLink, renderPollMenu, reportMenuEntryMarkup, reportModalMarkup, shareDialogMarkup } from '../src/pages/poll';
import { socialIconMarkup } from '../src/ui';
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
// Stands in for the page a share runs in: the origin the canonical address is built
// from, the browser APIs it may reach for, and the toast it reports through.
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

afterEach(() => {
  vi.unstubAllGlobals();
});

// The share button opens the page's own dialog instead of the browser's share sheet, so the
// visitor always picks a network here (or copies the link), and the dialog is built on demand
// rather than living in the page content.
describe('the share flow', () => {
  const source = (): string => readFileSync('src/pages/poll.ts', 'utf8');

  it('never hands the poll to the browser share sheet', () => {
    // A share sheet would put an unstyled, untranslated sheet in front of the visitor - and
    // on some platforms hands the link out before a target is chosen.
    expect(source()).not.toContain('navigator.share');
    expect(source()).not.toContain('shareSheet');
  });

  it('opens the dialog from the share button and keeps the controls out of the page', () => {
    // The dialog is built when the button is pressed, and the poll's own markup renders no
    // share row: `shareDialogMarkup` is the only home of the share controls.
    expect(source()).toContain("querySelector<HTMLButtonElement>('[data-poll-share]')");
    expect(source()).toContain('openShareDialog');
    expect(source()).toContain('shareDialogMarkup(pollUrl(poll.number), poll.title)');
    expect(source()).not.toContain('renderShareRow');
    expect(source()).not.toContain('data-poll-share-row');
  });
});

describe('copyPollLink', () => {
  it('copies the canonical address and confirms it', async () => {
    // The dialog's copy control copies even where the browser offers a share sheet of its
    // own: someone who asks for the link wants the link.
    const page = stubPage({ share: async () => {} });

    await copyPollLink(42);

    // The copy control copies, whatever the browser's share sheet could do.
    expect(page.copied).toEqual(['https://chinapoll.org/poll/42']);
    expect(page.shared).toHaveLength(0);
    expect(page.toast.hidden).toBe(false);
    expect(page.toast.innerHTML).toContain('shareCopied');
  });

  it('reports a refused copy instead of claiming success', async () => {
    const page = stubPage({ clipboard: { writeText: async () => { throw new Error('denied'); } } });

    await copyPollLink(42);

    expect(page.toast.innerHTML).toContain('shareFailed');
    expect(page.toast.innerHTML).not.toContain('shareCopied');
  });
});

// The share dialog is the only home of the share controls: the poll's canonical address, a
// copy control, and one entry per network. The networks are plain links to their own share
// dialogs, so they work without a script; the copy control needs the clipboard, which is why
// it is a button.
describe('shareDialogMarkup', () => {
  const URL = 'https://chinapoll.org/poll/42';
  const TITLE = '拆墙：完全取消对境外网站的访问限制';

  it('offers the address, the copy control, the networks, and a close button', () => {
    const markup = shareDialogMarkup(URL, TITLE);

    // The dialog is a modal card that names itself, and it shows the address as it will be
    // shared. Translations are not loaded here, so `t()` falls back to the i18n key.
    expect(markup).toContain('data-share-dialog');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="share-dialog-title"');
    expect(markup).toContain('>sharePoll</h2>');
    expect(markup).toContain(`data-share-url>${URL}</span>`);
    expect(markup).toContain('data-copy-link');
    expect(markup).toContain('>shareCopyLink</button>');
    expect(markup).toContain('data-share-close');
    expect(markup).toContain('>shareClose</button>');
    // Each entry names itself for assistive technology, and the networks are named as the
    // networks name themselves.
    expect(markup).toContain('aria-label="shareToX"');
    expect(markup).toContain('aria-label="shareToFacebook"');
    expect(markup).toContain('aria-label="shareToWhatsApp"');
    expect(markup).toContain('aria-label="shareToTelegram"');
    expect(markup).toContain('aria-label="shareToWeibo"');
    expect(markup).toContain('aria-label="shareToReddit"');
    expect(markup).toContain('>X</a>');
    expect(markup).toContain('>Facebook</a>');
    expect(markup).toContain('>WhatsApp</a>');
    expect(markup).toContain('>Telegram</a>');
    expect(markup).toContain('>Weibo</a>');
    expect(markup).toContain('>Reddit</a>');
    // Every entry carries its network's own mark, inlined beside the name and drawn in the
    // network's brand colour.
    expect(markup.match(/<svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="#[0-9a-f]{6}" aria-hidden="true">/g))
      .toHaveLength(6);
    for (const colour of ['#000000', '#0866ff', '#25d366', '#26a5e4', '#df2029', '#ff4500']) {
      expect(markup).toContain(`fill="${colour}"`);
    }
  });

  it('carries the address and the title, encoded, into each share dialog', () => {
    const markup = shareDialogMarkup(URL, TITLE);
    const encodedText = encodeURIComponent(TITLE);
    const encodedUrl = 'https%3A%2F%2Fchinapoll.org%2Fpoll%2F42';

    // Each network takes the address and the text as query parameters, in an attribute that
    // escapes the ampersands for HTML.
    expect(markup)
      .toContain(`href="https://twitter.com/intent/tweet?url=${encodedUrl}&amp;text=${encodedText}"`);
    expect(markup).toContain(`href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}"`);
    expect(markup).toContain(`href="https://t.me/share/url?url=${encodedUrl}&amp;text=${encodedText}"`);
    expect(markup)
      .toContain(`href="https://service.weibo.com/share/share.php?url=${encodedUrl}&amp;title=${encodedText}"`);
    expect(markup)
      .toContain(`href="https://www.reddit.com/submit?url=${encodedUrl}&amp;title=${encodedText}"`);
    // WhatsApp takes one message: the title, a space, and the address.
    expect(markup).toContain(`href="https://wa.me/?text=${encodeURIComponent(`${TITLE} ${URL}`)}"`);
    // Every network is opened in its own tab, with no handle on this one.
    expect(markup.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(6);
  });

  it('escapes a hostile title and address instead of letting them inject markup', () => {
    const markup = shareDialogMarkup('https://chinapoll.org/poll/42"><script>alert(1)</script>', '<b>Title</b>');

    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<b>Title</b>');
    expect(markup).toContain('%3Cscript%3E');
    expect(markup).toContain('%3Cb%3ETitle%3C%2Fb%3E');
  });
});

// The marks are brand paths inlined on the same 24x24 grid the interface icons use, drawn in
// each network's own brand colour, so the dialog fetches nothing from a network and the mark
// travels with the bundle.
describe('socialIconMarkup', () => {
  it('draws every network the dialog offers in its brand colour, and nothing for an unknown slug', () => {
    const marks: ReadonlyArray<readonly [string, string, string]> = [
      ['x', 'M14.234 10.162', '#000000'],
      ['facebook', 'M9.101 23.691', '#0866ff'],
      ['whatsapp', 'M17.472 14.382', '#25d366'],
      ['telegram', 'M11.944 0A12', '#26a5e4'],
      ['weibo', 'M10.098 20.323', '#df2029'],
      ['reddit', 'M12 0C5.373', '#ff4500']
    ];

    for (const [network, startsWith, colour] of marks) {
      const markup = socialIconMarkup(network, 'h-4 w-4');

      expect(markup).toContain(`<svg class="h-4 w-4" viewBox="0 0 24 24" fill="${colour}" aria-hidden="true">`);
      expect(markup).toContain(`<path d="${startsWith}`);
      expect(markup.endsWith('</svg>')).toBe(true);
    }

    // A slug with no mark renders nothing, so an entry reads as its name alone.
    expect(socialIconMarkup('nope', 'h-4 w-4')).toBe('');
  });
});
