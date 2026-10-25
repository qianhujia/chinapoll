// Frontend poll-menu and report-dialog tests.
//
// `renderPollMenu`, `reportMenuEntryMarkup`, and `reportModalMarkup` are pure
// markup, so they are checked directly: the three-dot button at the top right of
// the poll title hosts the report entry, and the report itself is a dialog built
// on demand instead of a card appended to the page.

import { describe, expect, it } from 'vitest';
import { renderPollMenu, reportMenuEntryMarkup, reportModalMarkup } from '../src/pages/poll';
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
    expect(markup.match(/<circle /g)).toHaveLength(3);

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
