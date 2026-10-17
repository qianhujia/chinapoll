// Frontend vote-control tests.
//
// `renderVoteButton` and `renderVoteGroup` are pure markup, so they are checked
// directly. `updateVoteGroup` and `selectVoteOption` are exercised against a
// small stand-in that implements exactly the DOM surface they use
// (querySelector, dataset, setAttribute, textContent, classList, disabled), which
// keeps this unit test free of a DOM dependency while still checking the
// behaviour that matters: numbers are cleared and the selected state survives
// when the counts are withheld.

import { describe, expect, it } from 'vitest';
import {
  VOTE_SELECTED_CLASS,
  renderVoteButton,
  renderVoteGroup,
  selectVoteOption,
  updateVoteGroup
} from '../src/ui';

interface FakePath {
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

interface FakeButton {
  attributes: Record<string, string>;
  disabled: boolean;
  classes: Set<string>;
  path: FakePath;
  countElement: { textContent: string };
  classList: { toggle(name: string, force?: boolean): void; contains(name: string): boolean };
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): unknown;
}

interface FakeGroup {
  dataset: Record<string, string>;
  title: string | null;
  buttons: Record<string, FakeButton>;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): unknown;
}

// Builds one fake rendered group with the three verdict buttons, shaped like the
// markup `renderVoteGroup` produces.
function makeGroup(): FakeGroup {
  const buttons: Record<string, FakeButton> = {};
  for (const option of ['approve', 'neutral', 'oppose']) {
    const path: FakePath = {
      attributes: { d: '' },
      setAttribute(name, value) { this.attributes[name] = value; }
    };
    const countElement = { textContent: '' };
    const classes = new Set<string>();
    buttons[option] = {
      attributes: {},
      disabled: false,
      classes,
      path,
      countElement,
      classList: {
        toggle(name, force) {
          // The real DOMTokenList throws on a token containing whitespace, which
          // is what makes a single `classList.toggle('a b')` call a bug.
          if (/\s/.test(name)) throw new Error(`InvalidCharacterError: "${name}" is not a valid token`);
          const on = force ?? !classes.has(name);
          if (on) classes.add(name); else classes.delete(name);
        },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      querySelector(selector) {
        if (selector === '[data-vote-count]') return countElement;
        if (selector === '[data-vote-fill] path') return path;
        return null;
      }
    };
  }

  return {
    dataset: {},
    title: null,
    buttons,
    setAttribute(name, value) {
      if (name === 'title') this.title = value;
    },
    querySelector(selector) {
      const match = selector.match(/^\[data-option="([a-z]+)"\]$/);
      return match ? buttons[match[1]] : null;
    }
  };
}

describe('renderVoteButton', () => {
  // The buttons always carry utility classes such as `disabled:cursor-not-allowed`
  // and `hover:enabled:brightness-95`, so the state is asserted on the attribute
  // itself rather than on the substring.
  const isDisabled = (markup: string): boolean => /\sdisabled(\s|>)/.test(markup);

  it('renders the label and the number when a count is known', () => {
    const markup = renderVoteButton('approve', 4, 10, false, 'approve');
    expect(markup).toContain('data-option="approve"');
    // The label and the count are both present, and the button stays enabled.
    expect(markup).toContain('>approve</span>');
    expect(markup).toContain('aria-label="approve: 4"');
    expect(markup).toContain('data-vote-count="approve">4<');
    expect(isDisabled(markup)).toBe(false);
  });

  it('renders the label without a number when the count is withheld', () => {
    const markup = renderVoteButton('oppose', null, 0, false, 'oppose');
    // The label and the icon stay, so the button is still usable...
    expect(markup).toContain('data-option="oppose"');
    expect(markup).toContain('>oppose</span>');
    expect(markup).toContain('aria-label="oppose"');
    expect(isDisabled(markup)).toBe(false);
    // ...but no number and no fill are drawn.
    expect(markup).toContain('data-vote-count="oppose"></span>');
    expect(markup).not.toMatch(/data-vote-count="oppose">\d/);
    expect(markup).toContain('<path d="" fill=');
  });

  it('keeps the existing output for a disabled button', () => {
    const markup = renderVoteButton('neutral', 0, 3, true, 'already voted');
    expect(isDisabled(markup)).toBe(true);
    expect(markup).toContain('title="already voted"');
    expect(markup).toContain('data-vote-count="neutral">0<');
  });
});

describe('renderVoteGroup', () => {
  const isDisabled = (markup: string): boolean => /\sdisabled(\s|>)/.test(markup);

  it('renders all three buttons and marks the group while counts are hidden', () => {
    const markup = renderVoteGroup({
      pollId: 7,
      counts: null,
      hidden: true,
      disabled: false,
      title: 'vote'
    });
    expect(markup).toContain('data-vote-group="7"');
    expect(markup).toContain('data-counts-hidden="true"');
    for (const option of ['approve', 'neutral', 'oppose']) {
      expect(markup).toContain(`data-option="${option}"`);
    }
    // Nothing is disabled: the threshold hides results only.
    expect(isDisabled(markup)).toBe(false);
  });

  it('marks the selected option without publishing a count', () => {
    const markup = renderVoteGroup({
      pollId: 8,
      counts: null,
      hidden: true,
      disabled: false,
      title: 'vote',
      selected: 'oppose'
    });
    expect(markup).toContain(VOTE_SELECTED_CLASS);
    expect(markup).toContain('data-counts-hidden="true"');
    expect(markup).not.toMatch(/data-vote-count="[a-z]+">\d/);
    // Only the selected button carries the `disabled` attribute.
    const buttons = markup.split('<button').slice(1);
    expect(buttons).toHaveLength(3);
    expect(buttons.filter((button) => /\sdisabled(\s|>)/.test(button))).toHaveLength(1);
  });
});

describe('updateVoteGroup', () => {
  it('writes the numbers and the fill bars when counts are known', () => {
    const group = makeGroup();
    updateVoteGroup(group as unknown as HTMLElement, { approve: 3, neutral: 1, oppose: 0 });

    expect(group.dataset.countsHidden).toBe('false');
    expect(group.buttons.approve.countElement.textContent).toBe('3');
    expect(group.buttons.neutral.countElement.textContent).toBe('1');
    expect(group.buttons.oppose.countElement.textContent).toBe('0');
    expect(group.buttons.approve.path.attributes.d).not.toBe('');
    expect(group.buttons.oppose.path.attributes.d).toBe('');
    expect(group.buttons.approve.attributes['aria-label']).toBe('approve: 3');
  });

  it('clears the numbers and the fill bars when counts are null', () => {
    const group = makeGroup();
    // Seed visible numbers first, as a poll that was above the threshold would.
    updateVoteGroup(group as unknown as HTMLElement, { approve: 3, neutral: 1, oppose: 0 });

    expect(() => updateVoteGroup(group as unknown as HTMLElement, null)).not.toThrow();
    expect(group.dataset.countsHidden).toBe('true');
    for (const option of ['approve', 'neutral', 'oppose'] as const) {
      expect(group.buttons[option].countElement.textContent).toBe('');
      expect(group.buttons[option].path.attributes.d).toBe('');
      expect(group.buttons[option].attributes['aria-label']).toBe(option);
    }
  });
});

describe('selectVoteOption', () => {
  // The class is a list of tokens, so membership is checked per token.
  const hasSelected = (button: FakeButton): boolean =>
    VOTE_SELECTED_CLASS.split(' ').every((token) => button.classList.contains(token));

  it('highlights one button, disables the group, and keeps the numbers hidden', () => {
    const group = makeGroup();

    selectVoteOption(group as unknown as HTMLElement, 'oppose');

    expect(hasSelected(group.buttons.oppose)).toBe(true);
    expect(hasSelected(group.buttons.approve)).toBe(false);
    expect(hasSelected(group.buttons.neutral)).toBe(false);
    // Every button is disabled, and no count is written by this call.
    expect(group.buttons.approve.disabled).toBe(true);
    expect(group.buttons.neutral.disabled).toBe(true);
    expect(group.buttons.oppose.disabled).toBe(true);
    expect(group.buttons.oppose.countElement.textContent).toBe('');
    expect(group.title).toBe('alreadyVoted');
  });

  it('applies each selected class token separately', () => {
    // `classList` cannot hold a space-separated string as one token, so every
    // token has to be toggled on its own or the styling never applies.
    const group = makeGroup();
    selectVoteOption(group as unknown as HTMLElement, 'approve');
    const tokens = VOTE_SELECTED_CLASS.split(' ');
    expect(tokens.length).toBeGreaterThan(1);
    for (const token of tokens) {
      expect(group.buttons.approve.classList.contains(token)).toBe(true);
      expect(group.buttons.oppose.classList.contains(token)).toBe(false);
    }
  });
});
