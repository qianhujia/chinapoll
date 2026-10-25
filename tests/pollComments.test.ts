// Frontend poll-comment tests.
//
// `renderCommentsHeader` and `renderCommentForm` are pure markup, so they are
// checked directly: the action button sits right after the comments heading and
// targets the form card above the list, which the page opens and scrolls to. A
// signed-out visitor gets a sign-in button in its place and no form at all.

import { describe, expect, it } from 'vitest';
import { renderCommentForm, renderCommentsHeader } from '../src/pages/poll';

// Translations are not loaded in this environment, so `t()` falls back to the
// i18n key and the assertions below read those keys.
describe('renderCommentsHeader', () => {
  it('puts the comment button right after the heading', () => {
    const markup = renderCommentsHeader(true);

    // The title and the button share one left-aligned row, and the row keeps the
    // gap below the heading so the rest of the card is unchanged.
    expect(markup).toContain('commentsTitle');
    expect(markup).toContain('flex flex-wrap items-center gap-3');
    expect(markup).not.toContain('justify-between');
    expect(markup).toContain('data-toggle-comment');
    expect(markup).toContain('commentToggle');
    // The button follows the heading.
    expect(markup.indexOf('commentsTitle')).toBeLessThan(markup.indexOf('commentToggle'));
    // The button opens the form card that sits above the comments list, and it is
    // closed to begin with.
    expect(markup).toContain('aria-controls="comment-form"');
    expect(markup).toContain('aria-expanded="false"');
    // It is no longer the centred button that used to sit in the form card.
    expect(markup).not.toContain('mx-auto');
  });

  it('shows a sign-in button after the heading for a signed-out visitor', () => {
    const markup = renderCommentsHeader(false);

    expect(markup).toContain('commentsTitle');
    // There is no form to toggle, so the button links to the login page instead.
    expect(markup).not.toContain('data-toggle-comment');
    expect(markup).not.toContain('commentToggle');
    expect(markup).toContain('commentLoginAction');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('data-route="/login"');
    expect(markup.indexOf('commentsTitle')).toBeLessThan(markup.indexOf('commentLoginAction'));
  });
});

describe('renderCommentForm', () => {
  it('renders the collapsed form card as the toggle target', () => {
    const markup = renderCommentForm(true);

    // The card itself is the target, so collapsing the form leaves no empty card
    // behind above the comments list.
    expect(markup).toContain('id="comment-form" hidden');
    expect(markup.match(/<section/g)).toHaveLength(1);
    expect(markup).toContain('id="comment"');
    expect(markup).toContain('minlength="5"');
    expect(markup).toContain('maxlength="140"');
    expect(markup).toContain('data-submit-comment');
    expect(markup).toContain('comment-submit-status');
    expect(markup).toContain('comment-id-note');
    // The toggle itself belongs to the comments header only.
    expect(markup).not.toContain('data-toggle-comment');
    expect(markup).not.toContain('commentToggle');
  });

  it('renders no form for a signed-out visitor', () => {
    // The sign-in button in the comments header replaces the form, so a
    // signed-out visitor gets no card at all.
    expect(renderCommentForm(false)).toBe('');
  });
});