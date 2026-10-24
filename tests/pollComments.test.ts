// Frontend poll-comment tests.
//
// `renderCommentsHeader` and `renderCommentForm` are pure markup, so they are
// checked directly: the Comment button belongs at the top right of the comments
// list instead of a centred button in a card of its own, and it targets the form
// card above the list, which the page opens and scrolls to.

import { describe, expect, it } from 'vitest';
import { renderCommentForm, renderCommentsHeader } from '../src/pages/poll';

// Translations are not loaded in this environment, so `t()` falls back to the
// i18n key and the assertions below read those keys.
describe('renderCommentsHeader', () => {
  it('puts the comment toggle at the top right of the comments list', () => {
    const markup = renderCommentsHeader(true);

    // The title and the button share one header row, and the row keeps the gap
    // below the heading so the rest of the card is unchanged.
    expect(markup).toContain('commentsTitle');
    expect(markup).toContain('flex items-start justify-between');
    expect(markup).toContain('data-toggle-comment');
    expect(markup).toContain('commentToggle');
    // The button opens the form card that sits above the comments list, and it is
    // closed to begin with.
    expect(markup).toContain('aria-controls="comment-form"');
    expect(markup).toContain('aria-expanded="false"');
    // It is no longer the centred button that used to sit in the form card.
    expect(markup).not.toContain('mx-auto');
  });

  it('omits the toggle for a signed-out visitor', () => {
    const markup = renderCommentsHeader(false);

    expect(markup).toContain('commentsTitle');
    expect(markup).not.toContain('data-toggle-comment');
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

  it('shows the sign-in prompt in place of the form for a signed-out visitor', () => {
    const markup = renderCommentForm(false);

    expect(markup).toContain('commentLoginRequired');
    expect(markup).toContain('loginRequiredAction');
    expect(markup).not.toContain('id="comment-form"');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('data-submit-comment');
  });
});