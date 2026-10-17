// Shared options engine.
//
// Every poll exposes a list of options stored in `poll_options`, every ballot is
// a set of selected option IDs stored in `vote_selections`, and one counting
// function, one results shape, and one snapshot shape serve all three poll types
// (see worker/enums.ts).
//
// A verdict poll's rows are presets: `label` is NULL and `preset_key` names the
// fixed, translated scale (`approve`, `oppose`, `neutral`). A choice poll's rows
// carry the label the submitter wrote. Either way an option is identified by
// `id` in every request and response; the frontend renders `t(presetKey)` for a
// preset row and the stored label otherwise.
//
// Anonymity is unchanged: the only voter identifier is the per-poll token hash,
// and every public shape below publishes per-option counts only - including for
// a verdict poll, whose single selection is a preset row like any other option.

import { PollType, type PollTypeLabel } from '../enums';
import { isChoicePollType, isPresetKey, pollTypeLabel, requiredSelectionCount, type PresetKey } from './pollType';

export interface PollOption {
  id: number;
  position: number;
  /** Submitter text of a choice option; NULL for a verdict preset row. */
  label: string | null;
  /** `approve`, `oppose`, or `neutral` for a verdict preset row; NULL otherwise. */
  presetKey: string | null;
}

export interface PollOptionCount extends PollOption {
  count: number;
}

export interface PollTally {
  ballots: number;
  counts: Map<number, number>;
}

// The single public results shape returned by the vote endpoint, the stats
// endpoint, and the poll listings. `options` is null below the threshold while
// `ballots` is still returned.
export interface PublicResults {
  pollType: PollTypeLabel;
  ballots: number;
  hidden: boolean;
  threshold: number;
  options: PollOptionCount[] | null;
}

export interface OptionsEnv {
  DB: D1Database;
}

interface PollLike {
  id?: number;
  poll_type?: number;
}

interface OptionRow {
  id: number;
  position: number;
  label: string | null;
  preset_key: string | null;
}

const OPTION_COLUMNS = 'id, position, label, preset_key';

function toOption(row: OptionRow): PollOption {
  return {
    id: Number(row.id),
    position: Number(row.position),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    presetKey: row.preset_key === null || row.preset_key === undefined ? null : String(row.preset_key)
  };
}

// Returns the options of a poll from `poll_options`, ordered by position, for
// every poll type.
export async function getPollOptions(env: OptionsEnv, poll: PollLike): Promise<PollOption[]> {
  if (poll.id === undefined) return [];
  const result = await env.DB.prepare(
    `SELECT ${OPTION_COLUMNS} FROM poll_options WHERE poll_id = ? ORDER BY position ASC`
  ).bind(Number(poll.id)).all<OptionRow>();
  return (result.results ?? []).map(toOption);
}

// Same as `getPollOptions` but for a page of polls at once, so a listing costs
// one query instead of one per row (paginate, then aggregate).
export async function getOptionsForPolls(
  env: OptionsEnv,
  polls: Array<PollLike & { id: number }>
): Promise<Map<number, PollOption[]>> {
  const byPoll = new Map<number, PollOption[]>();
  if (polls.length === 0) return byPoll;
  const pollIds = polls.map((poll) => Number(poll.id)).filter((id) => Number.isSafeInteger(id));
  for (const pollId of pollIds) byPoll.set(pollId, []);
  if (pollIds.length === 0) return byPoll;

  const placeholders = pollIds.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT poll_id, ${OPTION_COLUMNS} FROM poll_options
     WHERE poll_id IN (${placeholders})
     ORDER BY poll_id ASC, position ASC`
  ).bind(...pollIds).all<OptionRow & { poll_id: number }>();

  for (const row of result.results ?? []) {
    byPoll.get(Number(row.poll_id))?.push(toOption(row));
  }
  return byPoll;
}

// The preset row of a poll, or null when the poll does not carry it.
export function presetOption(options: PollOption[], key: PresetKey): PollOption | null {
  return options.find((option) => option.presetKey === key) ?? null;
}

// The count of one preset row, or 0 when the poll does not carry it - which is
// how an absent `neutral` row reports a zero instead of going missing.
export function presetCount(options: PollOption[], tally: PollTally, key: PresetKey): number {
  const option = presetOption(options, key);
  return option ? Number(tally.counts.get(option.id) ?? 0) : 0;
}

export type SelectionResult =
  | { ok: true; optionIds: number[] }
  | { ok: false; message: string };

// Validates the submitted ballot against the poll type and returns the selected
// option IDs. Every ID must belong to the poll, so a caller cannot vote with
// another poll's option, and the per-type count rules are applied through
// `requiredSelectionCount`.
//
// The legacy `option` field stays accepted on a verdict poll and resolves to
// that poll's preset row, so older clients keep working; `optionIds` with one
// option ID is the unified form.
export function validateSelections(poll: PollLike, options: PollOption[], body: unknown): SelectionResult {
  const source = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const pollType = Number(poll.poll_type ?? PollType.Verdict);
  const rawIds = source.optionIds;
  if (rawIds !== undefined && !Array.isArray(rawIds)) {
    return { ok: false, message: 'bad request' };
  }
  const legacyOption = source.option;

  const rule = requiredSelectionCount(pollType);
  if (rule === null) return { ok: false, message: 'bad request' };

  const ids = ((rawIds as unknown[] | undefined) ?? []).map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    return { ok: false, message: 'bad request' };
  }
  const distinct = [...new Set(ids)];
  if (distinct.length !== ids.length) {
    return { ok: false, message: 'duplicate option' };
  }

  if (legacyOption !== undefined) {
    // A verdict label is refused on a choice poll and resolves to a preset row
    // on a verdict poll.
    if (pollType !== PollType.Verdict) {
      return { ok: false, message: 'this poll does not accept a verdict' };
    }
    if (!isPresetKey(legacyOption)) return { ok: false, message: 'bad request' };
    const preset = presetOption(options, legacyOption);
    if (preset === null) return { ok: false, message: 'unknown option' };
    if (distinct.length === 0) return { ok: true, optionIds: [preset.id] };
    if (distinct.length !== 1 || distinct[0] !== preset.id) {
      return { ok: false, message: 'bad request' };
    }
    return { ok: true, optionIds: [preset.id] };
  }

  const allowed = new Set(options.map((option) => option.id));
  if (distinct.some((id) => !allowed.has(id))) {
    return { ok: false, message: 'unknown option' };
  }
  if (distinct.length < rule.min || distinct.length > rule.max) {
    return { ok: false, message: 'bad request' };
  }
  return { ok: true, optionIds: distinct };
}

// Counts the ballots and the per-option counts of a page of polls with two
// aggregate queries total (paginate, then aggregate): the ballot total comes
// from `votes` and the counts from `vote_selections` grouped by
// (poll_id, option_id). Polls without rows keep the zero tally inserted below.
export async function countBallots(
  env: OptionsEnv,
  polls: Array<PollLike & { id: number }>
): Promise<Map<number, PollTally>> {
  const tallies = new Map<number, PollTally>();
  if (polls.length === 0) return tallies;

  const pollIds = polls.map((poll) => Number(poll.id)).filter((id) => Number.isSafeInteger(id));
  for (const pollId of pollIds) tallies.set(pollId, { ballots: 0, counts: new Map() });
  if (pollIds.length === 0) return tallies;

  const placeholders = pollIds.map(() => '?').join(', ');
  const ballotRows = await env.DB.prepare(
    `SELECT poll_id, COUNT(*) AS ballots FROM votes
     WHERE poll_id IN (${placeholders}) GROUP BY poll_id`
  ).bind(...pollIds).all<{ poll_id: number; ballots: number }>();
  for (const row of ballotRows.results ?? []) {
    const tally = tallies.get(Number(row.poll_id));
    if (tally) tally.ballots = Number(row.ballots);
  }

  const countRows = await env.DB.prepare(
    `SELECT poll_id, option_id, COUNT(*) AS count FROM vote_selections
     WHERE poll_id IN (${placeholders}) GROUP BY poll_id, option_id`
  ).bind(...pollIds).all<{ poll_id: number; option_id: number; count: number }>();
  for (const row of countRows.results ?? []) {
    tallies.get(Number(row.poll_id))?.counts.set(Number(row.option_id), Number(row.count));
  }

  return tallies;
}

// Convenience wrapper for a single poll.
export async function countPollBallots(env: OptionsEnv, poll: PollLike & { id: number }): Promise<PollTally> {
  const tallies = await countBallots(env, [poll]);
  return tallies.get(Number(poll.id)) ?? { ballots: 0, counts: new Map() };
}

// Builds the single public results shape. The threshold is applied to the number
// of ballots: below it every option count is withheld together, which is what
// keeps a poll with a couple of ballots from revealing how one person voted.
export function toPublicResults(
  poll: PollLike,
  options: PollOption[],
  tally: PollTally,
  threshold: number
): PublicResults {
  const hidden = threshold > 0 && tally.ballots < threshold;
  return {
    pollType: pollTypeLabel(Number(poll.poll_type ?? PollType.Verdict)),
    ballots: tally.ballots,
    hidden,
    threshold,
    options: hidden
      ? null
      : options.map((option) => ({
        id: option.id,
        position: option.position,
        label: option.label,
        presetKey: option.presetKey,
        count: Number(tally.counts.get(option.id) ?? 0)
      }))
  };
}

// The legacy verdict `counts` object, kept on verdict responses so existing
// clients keep working. It is filled from the poll's preset rows by preset key,
// so a poll that dropped its neutral row reports a zero.
export function legacyVerdictCounts(
  options: PollOption[],
  tally: PollTally
): { approve: number; neutral: number; oppose: number } {
  return {
    approve: presetCount(options, tally, 'approve'),
    neutral: presetCount(options, tally, 'neutral'),
    oppose: presetCount(options, tally, 'oppose')
  };
}

export { isChoicePollType, pollTypeLabel };
export type { PollTypeLabel };
