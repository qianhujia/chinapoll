// Frontend vote-control tests.
//
// The vote controls are built from the poll's own options array, so a verdict
// poll with two or three preset rows renders exactly those buttons.
// `renderVoteButton` and `renderVoteGroup` are pure markup and are checked
// directly. `updateVoteGroup` and `selectVoteOption` are exercised against a
// small stand-in that implements exactly the DOM surface they use
// (querySelector, querySelectorAll, dataset, setAttribute, textContent,
// classList, disabled), which keeps this unit test free of a DOM dependency
// while still checking the behaviour that matters: numbers are cleared and the
// selected state survives when the counts are withheld.

import { describe, expect, it } from 'vitest';
import {
  VOTE_SELECTED_CLASS,
  optionLabel,
  renderVoteButton,
  renderVoteGroup,
  selectVoteOption,
  updateVoteGroup
} from '../src/ui';
import type { PollOption } from '../src/lib/poll';

// The preset rows of a verdict poll, in row order.
const PRESETS: PollOption[] = [
  { id: 21, position: 1, label: null, presetKey: 'approve' },
  { id: 22, position: 2, label: null, presetKey: 'oppose' },
  { id: 23, position: 3, label: null, presetKey: 'neutral' }
];

// The same rows with counts, as the results payload carries them.
function counted(counts: number[]): PollOption[] {
  return PRESETS.map((option, index) => ({ ...option, count: counts[index] }));
}

interface FakePath {
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

interface FakeButton {
  dataset: Record<string, string>;
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
  buttons: FakeButton[];
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): unknown[];
}

function makeButton(optionId: number): FakeButton {
  const path: FakePath = {
    attributes: { d: '' },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const countElement = { textContent: '' };
  const classes = new Set<string>();
  return {
    dataset: { optionId: String(optionId) },
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

// Builds one fake rendered group shaped like the markup `renderVoteGroup`
// produces for the given options.
function makeGroup(options: PollOption[]): FakeGroup {
  const buttons = options.map((option) => makeButton(option.id));
  return {
    dataset: {},
    title: null,
    buttons,
    setAttribute(name, value) {
      if (name === 'title') this.title = value;
    },
    querySelector(selector) {
      const match = selector.match(/^\[data-option-id="(\d+)"\]$/);
      if (!match) return null;
      return buttons.find((button) => button.dataset.optionId === match[1]) ?? null;
    },
    querySelectorAll(selector) {
      return selector === '[data-option-id]' ? buttons : [];
    }
  };
}

describe('optionLabel', () => {
  it('translates a preset key and shows a stored label as-is', () => {
    // Translations are not loaded here, so `t()` falls back to the i18n key.
    expect(optionLabel({ label: null, presetKey: 'approve' })).toBe('approve');
    expect(optionLabel({ label: 'Bus', presetKey: null })).toBe('Bus');
  });
});

describe('renderVoteButton', () => {
  const isDisabled = (markup: string): boolean => /\sdisabled(\s|>)/.test(markup);

  it('renders the count and the fill bar when the count is known', () => {
    const markup = renderVoteButton(PRESETS[0], 3, 4, false, 'vote');

    expect(markup).toContain('data-option-id="21"');
    expect(markup).toContain('data-vote-count="21">3<');
    expect(markup).toContain('approve: 3');
    expect(isDisabled(markup)).toBe(false);
  });

  it('keeps the label and hides the number when the count is withheld', () => {
    const markup = renderVoteButton(PRESETS[1], null, 0, false, 'vote');

    expect(markup).toContain('>oppose<');
    expect(markup).not.toMatch(/data-vote-count="\d+">\d/);
    expect(markup).toContain('aria-label="oppose"');
  });

  it('marks the button disabled when asked', () => {
    expect(isDisabled(renderVoteButton(PRESETS[2], 0, 3, true, 'alreadyVoted'))).toBe(true);
  });
});

describe('renderVoteGroup', () => {
  it('renders one button per preset row of the poll', () => {
    const markup = renderVoteGroup({
      pollId: 7,
      options: counted([1, 2, 0]),
      hidden: false,
      disabled: false,
      title: 'vote'
    });

    expect(markup).toContain('data-vote-group="7"');
    expect(markup.match(/data-option-id="/g)).toHaveLength(3);
    // The order follows the options array, so the poll decides the scale.
    expect(markup.indexOf('data-option-id="21"')).toBeLessThan(markup.indexOf('data-option-id="22"'));
    expect(markup.indexOf('data-option-id="22"')).toBeLessThan(markup.indexOf('data-option-id="23"'));
  });

  it('renders only the rows of a poll without a neutral option', () => {
    const markup = renderVoteGroup({
      pollId: 8,
      options: counted([1, 2]).slice(0, 2),
      hidden: true,
      disabled: false,
      title: 'vote'
    });

    expect(markup.match(/data-option-id="/g)).toHaveLength(2);
    expect(markup).not.toContain('neutral');
    expect(markup).toContain('data-counts-hidden="true"');
    expect(markup).not.toMatch(/data-vote-count="\d+">\d/);
  });

  it('highlights the stored selection and disables only that button', () => {
    const markup = renderVoteGroup({
      pollId: 9,
      options: counted([1, 2, 3]),
      hidden: true,
      disabled: false,
      title: 'vote',
      selectedId: 22
    });

    expect(markup).toContain(VOTE_SELECTED_CLASS);
    const buttons = markup.split('<button').slice(1);
    expect(buttons).toHaveLength(3);
    // Only the selected button is disabled.
    expect(buttons.filter((button) => /\sdisabled(\s|>)/.test(button))).toHaveLength(1);
  });
});

describe('updateVoteGroup', () => {
  it('writes the numbers and the fill bars when counts are known', () => {
    const group = makeGroup(PRESETS);
    updateVoteGroup(group as unknown as HTMLElement, counted([3, 0, 1]));

    expect(group.dataset.countsHidden).toBe('false');
    expect(group.buttons[0].countElement.textContent).toBe('3');
    expect(group.buttons[1].countElement.textContent).toBe('0');
    expect(group.buttons[2].countElement.textContent).toBe('1');
    expect(group.buttons[0].path.attributes.d).not.toBe('');
    expect(group.buttons[1].path.attributes.d).toBe('');
    expect(group.buttons[0].attributes['aria-label']).toBe('approve: 3');
  });

  it('clears the numbers and the fill bars when the options are withheld', () => {
    const group = makeGroup(PRESETS);
    // Seed visible numbers first, as a poll that was above the threshold would.
    updateVoteGroup(group as unknown as HTMLElement, counted([3, 0, 1]));

    expect(() => updateVoteGroup(group as unknown as HTMLElement, null)).not.toThrow();
    expect(group.dataset.countsHidden).toBe('true');
    for (const button of group.buttons) {
      expect(button.countElement.textContent).toBe('');
      expect(button.path.attributes.d).toBe('');
    }
  });
});

describe('selectVoteOption', () => {
  // The class is a list of tokens, so membership is checked per token.
  const hasSelected = (button: FakeButton): boolean =>
    VOTE_SELECTED_CLASS.split(' ').every((token) => button.classList.contains(token));

  it('highlights one button, disables the group, and keeps the numbers hidden', () => {
    const group = makeGroup(PRESETS);

    selectVoteOption(group as unknown as HTMLElement, 22);

    expect(hasSelected(group.buttons[1])).toBe(true);
    expect(hasSelected(group.buttons[0])).toBe(false);
    expect(hasSelected(group.buttons[2])).toBe(false);
    // Every button is disabled, and no count is written by this call.
    for (const button of group.buttons) expect(button.disabled).toBe(true);
    expect(group.buttons[1].countElement.textContent).toBe('');
    expect(group.title).toBe('alreadyVoted');
  });

  it('applies each selected class token separately', () => {
    // `classList` cannot hold a space-separated string as one token, so every
    // token has to be toggled on its own or the styling never applies.
    const group = makeGroup(PRESETS);
    selectVoteOption(group as unknown as HTMLElement, 21);
    const tokens = VOTE_SELECTED_CLASS.split(' ');
    expect(tokens.length).toBeGreaterThan(1);
    for (const token of tokens) {
      expect(group.buttons[0].classList.contains(token)).toBe(true);
      expect(group.buttons[1].classList.contains(token)).toBe(false);
    }
  });
});
