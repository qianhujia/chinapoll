// Shared options engine.
//
// Every poll keeps its options in `poll_options` as plain text labels, every
// ballot records one `vote_selections` row per chosen option, and one counting
// function and one results shape serve both poll types (single choice and
// multiple choice, see worker/enums.ts). Options are identified by `id` in every
// request and response, and the frontend renders the stored label.
//
// Anonymity is unchanged: the only voter identifier is the per-poll token hash,
// and every public shape below publishes per-option counts only.

import { PollType, type PollTypeLabel } from '../enums';
import { pollTypeLabel, requiredSelectionCount } from './pollType';
import { chunk } from '../../shared/db';
import { errorMessage, type ApiErrorCode } from '../../shared/errors';

export interface PollOption {
  id: number;
  position: number;
  /** The option text the submitter wrote. */
  label: string;
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
  label: string;
}

const OPTION_COLUMNS = 'id, position, label';

function toOption(row: OptionRow): PollOption {
  return {
    id: Number(row.id),
    position: Number(row.position),
    label: String(row.label)
  };
}

// Returns the options of a poll from `poll_options`, ordered by position.
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

  // One query per batch: a D1 statement binds at most 100 parameters, and a page
  // of polls can reach that.
  for (const batch of chunk(pollIds)) {
    const placeholders = batch.map(() => '?').join(', ');
    const result = await env.DB.prepare(
      `SELECT poll_id, ${OPTION_COLUMNS} FROM poll_options
       WHERE poll_id IN (${placeholders})
       ORDER BY poll_id ASC, position ASC`
    ).bind(...batch).all<OptionRow & { poll_id: number }>();

    for (const row of result.results ?? []) {
      byPoll.get(Number(row.poll_id))?.push(toOption(row));
    }
  }
  return byPoll;
}

export type SelectionResult =
  | { ok: true; optionIds: number[] }
  | { ok: false; code: ApiErrorCode; message: string };

// Validates the submitted ballot against the poll type and returns the selected
// option IDs. Every ID must belong to the poll, so a caller cannot vote with
// another poll's option, and the per-type count rules are applied through
// `requiredSelectionCount`: exactly one option for a single choice poll, one to
// seven distinct options for a multiple choice poll.
export function validateSelections(poll: PollLike, options: PollOption[], body: unknown): SelectionResult {
  const source = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const pollType = Number(poll.poll_type ?? PollType.SingleChoice);
  const rawIds = source.optionIds;
  if (rawIds !== undefined && !Array.isArray(rawIds)) {
    return { ok: false, code: 'BAD_REQUEST', message: errorMessage('BAD_REQUEST') };
  }

  const rule = requiredSelectionCount(pollType);
  if (rule === null) return { ok: false, code: 'BAD_REQUEST', message: errorMessage('BAD_REQUEST') };

  const ids = ((rawIds as unknown[] | undefined) ?? []).map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    return { ok: false, code: 'BAD_REQUEST', message: errorMessage('BAD_REQUEST') };
  }
  const distinct = [...new Set(ids)];
  if (distinct.length !== ids.length) {
    return { ok: false, code: 'DUPLICATE_OPTION', message: errorMessage('DUPLICATE_OPTION') };
  }

  const allowed = new Set(options.map((option) => option.id));
  if (distinct.some((id) => !allowed.has(id))) {
    return { ok: false, code: 'UNKNOWN_OPTION', message: errorMessage('UNKNOWN_OPTION') };
  }
  if (distinct.length < rule.min || distinct.length > rule.max) {
    return { ok: false, code: 'BAD_REQUEST', message: errorMessage('BAD_REQUEST') };
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

  // One pair of queries per batch: a D1 statement binds at most 100 parameters,
  // and a page of polls can reach that.
  for (const batch of chunk(pollIds)) {
    const placeholders = batch.map(() => '?').join(', ');
    const ballotRows = await env.DB.prepare(
      `SELECT poll_id, COUNT(*) AS ballots FROM votes
       WHERE poll_id IN (${placeholders}) GROUP BY poll_id`
    ).bind(...batch).all<{ poll_id: number; ballots: number }>();
    for (const row of ballotRows.results ?? []) {
      const tally = tallies.get(Number(row.poll_id));
      if (tally) tally.ballots = Number(row.ballots);
    }

    const countRows = await env.DB.prepare(
      `SELECT poll_id, option_id, COUNT(*) AS count FROM vote_selections
       WHERE poll_id IN (${placeholders}) GROUP BY poll_id, option_id`
    ).bind(...batch).all<{ poll_id: number; option_id: number; count: number }>();
    for (const row of countRows.results ?? []) {
      tallies.get(Number(row.poll_id))?.counts.set(Number(row.option_id), Number(row.count));
    }
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
    pollType: pollTypeLabel(Number(poll.poll_type ?? PollType.SingleChoice)),
    ballots: tally.ballots,
    hidden,
    threshold,
    options: hidden
      ? null
      : options.map((option) => ({
        id: option.id,
        position: option.position,
        label: option.label,
        count: Number(tally.counts.get(option.id) ?? 0)
      }))
  };
}

export { pollTypeLabel };
export type { PollTypeLabel };
