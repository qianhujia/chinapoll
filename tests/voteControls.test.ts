// Frontend vote-control tests.
//
// Every poll is a choice poll now, so the vote controls are the radio (single
// choice) or checkbox (multiple choice) list plus the results bars.
// `renderChoiceInputs` and `renderResults` are pure markup, so they are checked
// directly.

import { describe, expect, it } from 'vitest';
import { renderChoiceInputs, renderPollNav, renderResults } from '../src/pages/poll';
import type { PollOption } from '../src/lib/poll';

// Two stored options, shaped like the poll detail response. Translations are not
// loaded in this environment, so `t()` falls back to the i18n key.
const OPTIONS: PollOption[] = [
  { id: 11, label: 'Bus', position: 1 },
  { id: 12, label: 'Metro', position: 2 }
];

describe('renderChoiceInputs', () => {
  it('renders one radio per option for a single choice poll', () => {
    const markup = renderChoiceInputs('single_choice', OPTIONS, false);

    expect(markup).toContain('data-choice-form');
    expect(markup).toContain('data-poll-type="single_choice"');
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup).not.toContain('type="checkbox"');
    // The option id is the value that is submitted.
    expect(markup).toContain('value="11"');
    expect(markup).toContain('value="12"');
    expect(markup).toContain('>Bus<');
    expect(markup).toContain('>Metro<');
    // Nothing is pre-selected for a fresh visitor, and nothing is disabled. The
    // check is on the attribute, because the utility classes also mention
    // "disabled:".
    expect(markup).not.toContain('checked');
    expect(markup).not.toMatch(/\sdisabled(\s|>)/);
  });

  it('renders checkboxes for a multiple choice poll', () => {
    const markup = renderChoiceInputs('multi_choice', OPTIONS, false);

    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).not.toContain('type="radio"');
    expect(markup).toContain('data-poll-type="multi_choice"');
  });

  // A verdict poll is a single-answer poll, so it renders radios rather than
  // checkboxes even though it is its own type.
  it('renders radios for a verdict poll', () => {
    const markup = renderChoiceInputs('verdict', [
      { id: 21, label: 'Approve', position: 1 },
      { id: 22, label: 'Neutral', position: 2 },
      { id: 23, label: 'Oppose', position: 3 }
    ], false);

    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).toContain('data-poll-type="verdict"');
    expect(markup).toContain('>Approve<');
  });

  it('pre-checks the stored selections and disables the form for a returning voter', () => {
    const markup = renderChoiceInputs('multi_choice', OPTIONS, true, [12]);

    // Only the stored option is checked.
    const bus = markup.slice(markup.indexOf('value="11"'), markup.indexOf('value="12"'));
    expect(bus).not.toContain('checked');
    expect(markup.slice(markup.indexOf('value="12"'))).toContain('checked');
    // Every input and the submit button are disabled.
    expect(markup.match(/\sdisabled(\s|>)/g)).toHaveLength(3);
    expect(markup).toContain('alreadyVoted');
  });

  it('escapes an option label and needs no options to render the form', () => {
    const markup = renderChoiceInputs('single_choice', [
      { id: 1, label: '<script>alert(1)</script>', position: 1 }
    ], false);

    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
    // A poll with no rows still renders an empty form rather than an empty string.
    expect(renderChoiceInputs('single_choice', [], false)).toContain('data-choice-form');
  });
});

describe('renderResults', () => {
  const results = {
    pollType: 'single_choice' as const,
    ballots: 4,
    hidden: false,
    threshold: 0,
    options: [
      { id: 11, label: 'Bus', position: 1, count: 3 },
      { id: 12, label: 'Metro', position: 2, count: 1 }
    ]
  };

  it('renders one bar per option with its count and share of the ballots', () => {
    const markup = renderResults(results);

    expect(markup.match(/data-result-option=/g)).toHaveLength(2);
    // The share is of the ballots cast, not of the option counts.
    expect(markup).toContain('3 · 75.0%');
    expect(markup).toContain('1 · 25.0%');
    expect(markup).toContain('>Bus<');
    // The bars follow the positions, and nothing groups the selections.
    expect(markup.indexOf('data-result-option="11"')).toBeLessThan(markup.indexOf('data-result-option="12"'));
    expect(markup).not.toContain('selection');
  });

  it('renders nothing when the poll has no options', () => {
    expect(renderResults({ ...results, options: [] })).toBe('');
    expect(renderResults({ ...results, options: null })).toBe('');
  });
});

describe('renderPollNav', () => {
  it('renders nothing when the poll has no neighbor in either direction', () => {
    expect(renderPollNav(null, null)).toBe('');
  });

  it('links the previous and next poll with their numbers and titles', () => {
    const markup = renderPollNav(
      { id: 10, number: 4, title: 'Older poll' },
      { id: 14, number: 9, title: 'Newer poll' }
    );

    // The links follow the public number, not the primary key.
    expect(markup).toContain('href="/poll/4"');
    expect(markup).toContain('#4 Older poll');
    expect(markup).toContain('href="/poll/9"');
    expect(markup).toContain('#9 Newer poll');
    expect(markup).not.toContain('/poll/10');
    expect(markup).not.toContain('/poll/14');
    // Translations are not loaded here, so `t()` falls back to the i18n key.
    expect(markup).toContain('pollNavLabel');
    expect(markup).toContain('prevPoll');
    expect(markup).toContain('nextPoll');
  });

  it('renders only the direction that exists', () => {
    const markup = renderPollNav(null, { id: 14, number: 9, title: 'Newer poll' });

    expect(markup).toContain('href="/poll/9"');
    expect(markup).not.toContain('prevPoll');
  });

  it('escapes a neighbour title', () => {
    const markup = renderPollNav(null, { id: 14, number: 14, title: '<b>Newer</b>' });

    expect(markup).not.toContain('<b>');
    expect(markup).toContain('&lt;b&gt;');
  });
});
