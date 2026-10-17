// Shared poll-type helpers.
//
// A poll is one of three ballot shapes (see worker/enums.ts). Type 1 keeps the
// three-verdict behaviour and stores its answer in `votes.option`; types 2 and
// 3 store their selections in `vote_selections` and expose per-option counts.
// Every public response shows the ballots per poll and the counts per option
// only - never which options were chosen together on one ballot.

import { getPollTypeLabel, PollType, type PollTypeLabel } from '../enums';

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 7;
export const MAX_OPTION_LABEL_LENGTH = 80;

export interface PollOptionCount {
  id: number;
  label: string;
  position: number;
  count: number;
}

export interface ChoiceCounts {
  ballots: number;
  options: PollOptionCount[];
}

export function isChoicePollType(pollType: number): boolean {
  return pollType === PollType.SingleChoice || pollType === PollType.MultiChoice;
}

// Number of selections a ballot of this type must carry.
export function requiredSelectionCount(pollType: number): { min: number; max: number } | null {
  if (pollType === PollType.SingleChoice) return { min: 1, max: 1 };
  if (pollType === PollType.MultiChoice) return { min: 1, max: MAX_POLL_OPTIONS };
  return null;
}

export type PollTypeValidation = { ok: true; label: PollTypeLabel } | { ok: false; message: string };

export function validateOptionLabel(value: unknown, position: number): { ok: true; label: string } | { ok: false; message: string } {
  const label = typeof value === 'string' ? value.trim() : '';
  if (label.length < 1 || label.length > MAX_OPTION_LABEL_LENGTH) {
    return { ok: false, message: `option ${position} must be 1 to ${MAX_OPTION_LABEL_LENGTH} characters` };
  }
  return { ok: true, label };
}

export interface ParsedOption {
  position: number;
  label: string;
}

export type PollOptionsValidation =
  | { ok: true; options: ParsedOption[] }
  | { ok: false; message: string };

// Validates an option list: 2 to 7 rows, 1 to 80 characters each after
// trimming, position 1..7, and no duplicates.
export function validatePollOptions(value: unknown): PollOptionsValidation {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'a choice poll needs 2 to 7 options' };
  }
  if (value.length < MIN_POLL_OPTIONS || value.length > MAX_POLL_OPTIONS) {
    return { ok: false, message: `a choice poll needs ${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} options` };
  }

  const options: ParsedOption[] = [];
  const seenLabels = new Set<string>();
  const seenPositions = new Set<number>();

  for (const entry of value) {
    const raw = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
    const position = Number(raw.position);
    if (!Number.isSafeInteger(position) || position < 1 || position > MAX_POLL_OPTIONS) {
      return { ok: false, message: `option positions must be between 1 and ${MAX_POLL_OPTIONS}` };
    }
    if (seenPositions.has(position)) {
      return { ok: false, message: 'option positions must be unique' };
    }
    seenPositions.add(position);

    const label = validateOptionLabel(raw.label, position);
    if (!label.ok) return { ok: false, message: label.message };

    const key = label.label.toLowerCase();
    if (seenLabels.has(key)) {
      return { ok: false, message: 'option labels must be unique' };
    }
    seenLabels.add(key);
    options.push({ position, label: label.label });
  }

  options.sort((left, right) => left.position - right.position);
  return { ok: true, options };
}

// Builds the public `counts` shape of a choice poll: the number of ballots and
// one entry per option, sorted by position. A zero-count option is included so
// the bar list is stable. Below the ballot threshold every count is withheld.
export function choiceCounts(
  ballots: number,
  options: Array<{ id: number; label: string; position: number; count?: number }>,
  threshold: number
): { counts: ChoiceCounts | null; hidden: boolean; threshold: number } {
  if (threshold > 0 && ballots < threshold) {
    return { counts: null, hidden: true, threshold };
  }
  return {
    counts: {
      ballots,
      options: options.map((option) => ({
        id: Number(option.id),
        label: option.label,
        position: Number(option.position),
        count: Number(option.count ?? 0)
      }))
    },
    hidden: false,
    threshold
  };
}

// Label of a poll type, tolerating an unknown stored value so a public listing
// never fails because of one bad row.
export function pollTypeLabel(value: number): PollTypeLabel {
  try {
    return getPollTypeLabel(value);
  } catch {
    return 'verdict';
  }
}
