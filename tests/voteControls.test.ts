// Frontend vote-control tests.
//
// Every poll is a choice poll now, so the vote controls are the radio (single
// choice) or checkbox (multiple choice) list. Every row carries its option's count,
// keeps its whole-percent share back until the row is hovered or tapped, and fills a
// background in proportion to that share; the results bars are only rendered where no
// ballot carries that standing. `renderChoiceInputs`, `renderResults`,
// `optionSharePercent`, and `bindShareReveal` are pure, so they are checked directly.

import { describe, expect, it } from 'vitest';
import { bindShareReveal, optionSharePercent, renderChoiceInputs, renderPollNav, renderResults } from '../src/pages/poll';
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

  it('shows the standing of each option once the results are public', () => {
    const markup = renderChoiceInputs('single_choice', OPTIONS, false, [], {
      ballots: 4,
      hidden: false,
      threshold: 0,
      options: [
        { id: 11, label: 'Bus', position: 1, count: 3 },
        { id: 12, label: 'Metro', position: 2, count: 1 }
      ]
    });

    // The count follows the label, pushed to the right of the row by `ml-auto`, so the
    // numbers sit beside the choices they belong to. The whole-percent share waits in
    // its own slot, which the stylesheet reveals on hover or tap.
    expect(markup).toContain('<span class="relative ml-auto shrink-0 pl-3 text-sm tabular-nums text-muted" data-choice-share>3<span data-share-percent> · 75%</span></span>');
    expect(markup).toContain('data-choice-share>1<span data-share-percent> · 25%</span></span>');
    // Every option row is a share row, so the tap handler can find it.
    expect(markup.match(/data-share-row/g)).toHaveLength(2);
    // The row is filled in proportion to that share as well, so its background shows
    // the standing too. The row clips the fill, so it follows the rounded corners.
    expect(markup).toContain('overflow-hidden rounded-[14px]');
    expect(markup).toContain('class="absolute inset-y-0 left-0 bg-primary-soft" data-choice-fill style="width:75.0%"');
    expect(markup).toContain('data-choice-fill style="width:25.0%"');
  });

  it('holds the standing back while the server withholds the counts', () => {
    const markup = renderChoiceInputs('single_choice', OPTIONS, false);

    // Both slots are there for the post-ballot refresh, but they are empty, nothing
    // wide, and hidden: a poll below the threshold never shows a standing.
    expect(markup.match(/data-choice-share hidden><\/span>/g)).toHaveLength(2);
    expect(markup.match(/data-choice-fill style="width:0.0%" hidden>/g)).toHaveLength(2);
    expect(markup).not.toContain('data-share-percent');
    expect(markup).not.toMatch(/\d+ · \d+%/);
  });

  // The submit button is the one place the ballot's state is shown: its label is swapped
  // for the submitting wording while the vote is in flight (see `sendBallot`) and put
  // back afterwards, so the markup has to keep both the selector and the plain label.
  it('labels the one submit button the ballot state is shown on', () => {
    const markup = renderChoiceInputs('single_choice', OPTIONS, false);

    expect(markup.match(/data-choice-submit/g)).toHaveLength(1);
    expect(markup).toContain('type="submit" data-choice-submit >submitVote</button>');
    expect(markup).not.toContain('data-vote-submitting');
  });
});

describe('optionSharePercent', () => {
  it('rounds a share to a whole percent', () => {
    // 9469 of 10000 ballots is 94.69%, which reads as `95%` beside the option.
    expect(optionSharePercent(9469, 10000)).toBe(95);
    // A third and two thirds round to the nearest whole percent.
    expect(optionSharePercent(1, 3)).toBe(33);
    expect(optionSharePercent(2, 3)).toBe(67);
    // A poll nobody has voted in yet has no share to report.
    expect(optionSharePercent(0, 0)).toBe(0);
  });
});

// The tap reveal is bound to the page host, so it is checked against a stand-in that
// records the listener and answers with the rows the handler walks.
function makeShareRow() {
  const attributes = new Set<string>();
  return {
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string) => { attributes.add(name); },
    removeAttribute: (name: string) => { attributes.delete(name); },
    get open() { return attributes.has('data-share-open'); }
  };
}

function makeShareHost(rows: Array<ReturnType<typeof makeShareRow>>) {
  const listeners: Record<string, (event: { target: unknown }) => void> = {};
  const host = {
    addEventListener: (type: string, listener: (event: { target: unknown }) => void) => { listeners[type] = listener; },
    querySelectorAll: () => rows
  } as unknown as HTMLElement;
  return {
    host,
    // A tap whose target sits inside a row reports that row from `closest`.
    tap: (target: unknown) => listeners.click?.({ target })
  };
}

describe('bindShareReveal', () => {
  it('reveals the tapped row and hides every other', () => {
    const first = makeShareRow();
    const second = makeShareRow();
    const { host, tap } = makeShareHost([first, second]);
    bindShareReveal(host);

    tap({ closest: () => first });
    expect(first.open).toBe(true);
    expect(second.open).toBe(false);

    tap({ closest: () => second });
    expect(first.open).toBe(false);
    expect(second.open).toBe(true);
  });

  it('toggles the open row and closes it on a tap outside', () => {
    const row = makeShareRow();
    const { host, tap } = makeShareHost([row]);
    bindShareReveal(host);

    tap({ closest: () => row });
    expect(row.open).toBe(true);
    // Tapping the open row again puts its percent away.
    tap({ closest: () => row });
    expect(row.open).toBe(false);

    tap({ closest: () => row });
    expect(row.open).toBe(true);
    // A tap that lands outside every row closes the open one.
    tap({ closest: () => null });
    expect(row.open).toBe(false);
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
    // The count is visible and the whole-percent share is held in its own slot, which
    // the row reveals on hover or tap. The share is of the ballots cast, not of the
    // option counts, and it reads as a whole percent: `75%`, not `75.0%`.
    expect(markup).toContain('data-result-count>3<span data-share-percent> · 75%</span>');
    expect(markup).toContain('data-result-count>1<span data-share-percent> · 25%</span>');
    // Both rows carry the share row hook the tap handler looks for.
    expect(markup.match(/data-share-row/g)).toHaveLength(2);
    // No label keeps a decimal.
    expect(markup).not.toContain('75.0%</span>');
    // The bar itself keeps the unrounded share, so its width stays smooth from one
    // ballot to the next while only the label is rounded.
    expect(markup).toContain('style="width:75.0%"');
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

    // The pair sits at the bottom of the poll's own box, not in a card of its own: a
    // margin above it and muted text set it apart from the content it follows.
    expect(markup).toContain('<nav class="mt-6 flex flex-wrap items-center gap-3" aria-label="pollNavLabel">');
    expect(markup).not.toContain('rounded-[22px]');
    expect(markup).not.toContain('shadow-card');
    expect(markup).not.toContain('bg-panel');
    // Both links read as muted text that turns primary on hover; the previous one
    // sits on the left and the next is pushed to the right.
    expect(markup).toContain('class="flex min-w-0 items-center gap-2 text-muted no-underline hover:text-primary"');
    expect(markup).toContain('class="ml-auto flex min-w-0 items-center gap-2 text-muted no-underline hover:text-primary"');
    expect(markup).not.toContain('text-ink');
    // The labels are light rather than body weight, and there are two of them.
    expect(markup.match(/<span class="truncate text-sm font-light">/g)).toHaveLength(2);
    // The direction is a chevron icon, with no visible arrow or label text.
    expect(markup).toContain('m15 18-6-6 6-6');
    expect(markup).toContain('m9 18 6-6-6-6');
    expect(markup).not.toContain('←');
    expect(markup).not.toContain('→');
    expect(markup).not.toContain('text-xs text-muted');
    // The links follow the public number, not the primary key.
    expect(markup).toContain('href="/poll/4"');
    expect(markup).toContain('#4 Older poll');
    expect(markup).toContain('href="/poll/9"');
    expect(markup).toContain('#9 Newer poll');
    expect(markup).not.toContain('/poll/10');
    expect(markup).not.toContain('/poll/14');
    // Translations are not loaded here, so `t()` falls back to the i18n key; the
    // direction stays available to assistive technology through the aria-label.
    expect(markup).toContain('pollNavLabel');
    expect(markup).toContain('prevPoll');
    expect(markup).toContain('nextPoll');
  });

  it('renders only the direction that exists', () => {
    const markup = renderPollNav(null, { id: 14, number: 9, title: 'Newer poll' });

    expect(markup).toContain('href="/poll/9"');
    expect(markup).not.toContain('prevPoll');
    expect(markup).toContain('data-poll-nav="next"');
    expect(markup).not.toContain('data-poll-nav="prev"');
    expect(markup).not.toContain('m15 18-6-6 6-6');
  });

  it('escapes a neighbour title', () => {
    const markup = renderPollNav(null, { id: 14, number: 14, title: '<b>Newer</b>' });

    expect(markup).not.toContain('<b>');
    expect(markup).toContain('&lt;b&gt;');
  });
});
