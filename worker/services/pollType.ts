// Shared poll-type helpers.
//
// A poll is one of three ballot shapes (see worker/enums.ts). Every type keeps
// its options in `poll_options`: a verdict poll holds the preset rows
// `approve` and `oppose` (and optional `neutral`) whose label is NULL, and a
// choice poll holds 2 to 7 custom labeled rows. Every ballot records one
// `vote_selections` row per chosen option. Every public response shows the
// ballots per poll and the counts per option only - never which options were
// chosen together on one ballot.

import { getPollTypeLabel, PollType, type PollTypeLabel } from '../enums';

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 7;
export const MAX_OPTION_LABEL_LENGTH = 80;

export type PollOptionCount = {
  id: number;
  label: string | null;
  presetKey: string | null;
  position: number;
  count: number;
};

// The preset keys of a verdict poll, in row order. `neutral` is optional.
export type PresetKey = 'approve' | 'oppose' | 'neutral';

export const VERDICT_PRESET_KEYS: ReadonlyArray<PresetKey> = ['approve', 'oppose', 'neutral'];

// The preset rows a verdict poll must always carry, and the one it may omit.
export const REQUIRED_VERDICT_PRESET_KEYS: ReadonlyArray<PresetKey> = ['approve', 'oppose'];
export const OPTIONAL_VERDICT_PRESET_KEYS: ReadonlyArray<PresetKey> = ['neutral'];

export function isPresetKey(value: unknown): value is PresetKey {
  return typeof value === 'string' && (VERDICT_PRESET_KEYS as ReadonlyArray<string>).includes(value);
}

// Validates the `presetKeys` of a verdict proposal: `approve` and `oppose` are
// required, `neutral` is optional, and nothing else is accepted. The returned
// keys are always in row order (approve, oppose, neutral).
export function validatePresetKeys(value: unknown): { ok: true; presetKeys: PresetKey[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'a verdict poll needs the preset keys approve and oppose' };
  }
  const requested = new Set<PresetKey>();
  for (const entry of value) {
    if (!isPresetKey(entry)) {
      return { ok: false, message: 'a verdict poll only accepts the preset keys approve, oppose, and neutral' };
    }
    if (requested.has(entry)) {
      return { ok: false, message: 'the preset keys must be unique' };
    }
    requested.add(entry);
  }
  for (const key of REQUIRED_VERDICT_PRESET_KEYS) {
    if (!requested.has(key)) {
      return { ok: false, message: `a verdict poll must include the preset key ${key}` };
    }
  }
  return { ok: true, presetKeys: VERDICT_PRESET_KEYS.filter((key) => requested.has(key)) };
}

export function isChoicePollType(pollType: number): boolean {
  return pollType === PollType.SingleChoice || pollType === PollType.MultiChoice;
}

// Number of selections a ballot of this type must carry.
export function requiredSelectionCount(pollType: number): { min: number; max: number } | null {
  if (pollType === PollType.Verdict) return { min: 1, max: 1 };
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

// One option row of a proposal: a custom row carries a label, a preset row
// carries a preset key. Exactly one of the two is set.
export interface ParsedOption {
  position: number;
  label: string | null;
  presetKey: PresetKey | null;
}

export type PollOptionsValidation =
  | { ok: true; options: ParsedOption[] }
  | { ok: false; message: string };

// Validates an option list: 2 to 7 rows, 1 to 80 characters each after
// trimming, position 1..7, and no duplicates. A plain string array is accepted
// as well as `{ position, label }` entries; a string entry takes its position
// from its index, so a client can submit the rows in order.
export function validatePollOptions(value: unknown): PollOptionsValidation {
  const entries = toOptionEntries(value);
  if (entries === null) {
    return { ok: false, message: 'a choice poll needs 2 to 7 options' };
  }
  if (entries.length < MIN_POLL_OPTIONS || entries.length > MAX_POLL_OPTIONS) {
    return { ok: false, message: `a choice poll needs ${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} options` };
  }

  const options: ParsedOption[] = [];
  const seenLabels = new Set<string>();
  const seenPositions = new Set<number>();

  for (const entry of entries) {
    const raw = entry as Record<string, unknown>;
    const position = typeof entry === 'string' ? options.length + 1 : Number(raw.position);
    if (!Number.isSafeInteger(position) || position < 1 || position > MAX_POLL_OPTIONS) {
      return { ok: false, message: `option positions must be between 1 and ${MAX_POLL_OPTIONS}` };
    }
    if (seenPositions.has(position)) {
      return { ok: false, message: 'option positions must be unique' };
    }
    seenPositions.add(position);

    const label = validateOptionLabel(typeof entry === 'string' ? entry : raw.label, position);
    if (!label.ok) return { ok: false, message: label.message };

    const key = label.label.toLowerCase();
    if (seenLabels.has(key)) {
      return { ok: false, message: 'option labels must be unique' };
    }
    seenLabels.add(key);
    options.push({ position, label: label.label, presetKey: null });
  }

  options.sort((left, right) => left.position - right.position);
  return { ok: true, options };
}

// Builds the ordered preset rows of a verdict poll from its preset keys.
export function presetOptionRows(presetKeys: ReadonlyArray<PresetKey>): ParsedOption[] {
  return VERDICT_PRESET_KEYS
    .filter((key) => presetKeys.includes(key))
    .map((key, index) => ({ position: index + 1, label: null, presetKey: key }));
}

// Normalizes the accepted option shapes to a list of entries, or null when the
// value is not a usable array.
function toOptionEntries(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry) => typeof entry === 'string' || (typeof entry === 'object' && entry !== null));
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
