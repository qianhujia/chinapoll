// Frontend poll-description tests.
//
// `renderPollDescription` is pure markup, so it is checked directly: the
// description is clamped to two lines in the darker ink colour, and the
// expand/collapse toggle starts hidden until `bindDescription` measures that the
// text actually overflows the clamp.

import { describe, expect, it } from 'vitest';
import { renderPollDescription } from '../src/pages/poll';

// Translations are not loaded in this environment, so `t()` falls back to the
// i18n key and the assertions below read those keys.
describe('renderPollDescription', () => {
  it('clamps the description to two lines in the darker ink colour', () => {
    const markup = renderPollDescription('A long description.');

    expect(markup).toContain('data-poll-description');
    expect(markup).toContain('data-description-text');
    expect(markup).toContain('line-clamp-2');
    expect(markup).toContain('whitespace-pre-wrap');
    // The text reads in the dark ink colour rather than the muted grey.
    expect(markup).toContain('text-ink');
    expect(markup).not.toContain('text-muted');
    expect(markup).toContain('A long description.');
  });

  it('renders the toggle hidden, carrying both labels', () => {
    const markup = renderPollDescription('A long description.');

    expect(markup).toContain('data-action="toggle-description"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-expand-label="descriptionExpand"');
    expect(markup).toContain('data-collapse-label="descriptionCollapse"');
    // The toggle stays hidden until an overflow is measured.
    expect(markup).toMatch(/data-action="toggle-description"[^>]* hidden>/);
  });

  it('escapes the description text', () => {
    const markup = renderPollDescription('<b>bold</b> & "quotes"');

    expect(markup).not.toContain('<b>bold</b>');
    expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;');
  });
});
