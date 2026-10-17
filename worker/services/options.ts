// Shared options engine.
//
// Every poll exposes a list of options, every ballot is a set of selected option
// IDs, and one counting function, one results shape, and one snapshot shape
// serve all three poll types (see worker/enums.ts).
//
// The three types stay distinct in the schema because the verdict scale is
// fixed, translated from the i18n files, and comparable across polls. In code
// they share this engine: a verdict poll's options are **virtual** - three fixed
// entries with IDs 1, 2, 3 whose `label` is an i18n key, never stored in
// `poll_options`. A choice poll's options are the stored rows.
//
// Anonymity is unchanged: the only voter identifier is the per-poll token hash,
// and every public shape below publishes per-option counts only, never which
// options were chosen together on one ballot.

import { getVoteOptionLabel, PollType, VoteOption, type PollTypeLabel } from '../enums';
import { isChoicePollType, MAX_POLL_OPTIONS, pollTypeLabel } from './pollType';

export interface PollOption {
  id: number;
  position: number;
  /**
   * For a virtual option this is the i18n key (`approve`, `neutral`, `oppose`);
   * for a stored option it is the label the submitter wrote. The frontend
   * translates a virtual label and shows a stored label as-is.
   */
  label: string;
  virtual: boolean;
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

// The three fixed verdict options. IDs match the VoteOption codes (approve 1,
// oppose 2, neutral 3) so a verdict ballot keeps storing its answer in
// `votes.option` exactly as before; the display order is approve, neutral,
// oppose, which is the order the UI has always used.
export const VERDICT_OPTIONS: ReadonlyArray<PollOption> = [
  { id: VoteOption.Approve, position: 1, label: 'approve', virtual: true },
  { id: VoteOption.Neutral, position: 2, label: 'neutral', virtual: true },
  { id: VoteOption.Oppose, position: 3, label: 'oppose', virtual: true }
];

// Maps a verdict label to its fixed option ID.
export function verdictOptionId(value: unknown): number | null {
  if (value === 'approve') return VoteOption.Approve;
  if (value === 'oppose') return VoteOption.Oppose;
  if (value === 'neutral') return VoteOption.Neutral;
  return null;
}

// Maps a fixed verdict option ID back to its label.
export function verdictOptionLabel(id: number): string {
  return getVoteOptionLabel(id);
}

// Returns the options of a poll: the three virtual verdict entries, or the
// stored `poll_options` rows ordered by position.
export async function getPollOptions(env: OptionsEnv, poll: PollLike): Promise<PollOption[]> {
  const pollType = Number(poll.poll_type ?? PollType.Verdict);
  if (!isChoicePollType(pollType)) return [...VERDICT_OPTIONS];
  if (poll.id === undefined) return [];

  const result = await env.DB.prepare(
    'SELECT id, position, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC'
  ).bind(Number(poll.id)).all<{ id: number; position: number; label: string }>();

  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    position: Number(row.position),
    label: row.label,
    virtual: false
  }));
}

// Same as `getPollOptions` but for a page of polls at once, so a listing costs
// one aggregate query instead of one per row (paginate, then aggregate).
export async function getOptionsForPolls(
  env: OptionsEnv,
  polls: Array<PollLike & { id: number }>
): Promise<Map<number, PollOption[]>> {
  const byPoll = new Map<number, PollOption[]>();
  const choicePollIds: number[] = [];

  for (const poll of polls) {
    const pollType = Number(poll.poll_type ?? PollType.Verdict);
    if (isChoicePollType(pollType)) choicePollIds.push(Number(poll.id));
    else byPoll.set(Number(poll.id), [...VERDICT_OPTIONS]);
  }
  if (choicePollIds.length === 0) return byPoll;

  const placeholders = choicePollIds.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT poll_id, id, position, label FROM poll_options
     WHERE poll_id IN (${placeholders})
     ORDER BY poll_id ASC, position ASC`
  ).bind(...choicePollIds).all<{ poll_id: number; id: number; position: number; label: string }>();

  for (const row of result.results ?? []) {
    const pollId = Number(row.poll_id);
    const entry = byPoll.get(pollId) ?? [];
    entry.push({
      id: Number(row.id),
      position: Number(row.position),
      label: row.label,
      virtual: false
    });
    byPoll.set(pollId, entry);
  }
  // A choice poll with no stored rows still gets an (empty) entry.
  for (const pollId of choicePollIds) if (!byPoll.has(pollId)) byPoll.set(pollId, []);
  return byPoll;
}

export type SelectionResult =
  | { ok: true; optionIds: number[] }
  | { ok: false; message: string };

// Validates the submitted ballot against the poll type and returns the selected
// option IDs. Every ID must belong to the poll: a verdict ID must be one of the
// three fixed codes and a stored ID must be one of the poll's own rows, so a
// caller cannot vote with another poll's option.
//
// The legacy `option` field stays accepted for verdict polls so older clients
// and the existing integration tests keep working; `optionIds` with one virtual
// ID is the unified form.
export function validateSelections(poll: PollLike, options: PollOption[], body: unknown): SelectionResult {
  const source = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const pollType = Number(poll.poll_type ?? PollType.Verdict);
  const rawIds = source.optionIds;
  if (rawIds !== undefined && !Array.isArray(rawIds)) {
    return { ok: false, message: 'bad request' };
  }
  const legacyOption = source.option;

  if (!isChoicePollType(pollType)) {
    // Type 1: exactly one verdict, given either as the legacy label or as one
    // virtual option ID.
    if (Array.isArray(rawIds)) {
      if (rawIds.length !== 1) return { ok: false, message: 'bad request' };
      const id = Number(rawIds[0]);
      if (!Number.isSafeInteger(id) || !VERDICT_OPTIONS.some((option) => option.id === id)) {
        return { ok: false, message: 'bad request' };
      }
      if (legacyOption !== undefined && verdictOptionId(legacyOption) !== id) {
        return { ok: false, message: 'bad request' };
      }
      return { ok: true, optionIds: [id] };
    }
    const id = verdictOptionId(legacyOption);
    if (id === null) return { ok: false, message: 'bad request' };
    return { ok: true, optionIds: [id] };
  }

  // Types 2 and 3: stored IDs only, and `option` is not accepted.
  if (legacyOption !== undefined) {
    return { ok: false, message: 'this poll does not accept a verdict' };
  }
  const ids = ((rawIds as unknown[] | undefined) ?? []).map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    return { ok: false, message: 'bad request' };
  }
  const distinct = [...new Set(ids)];
  if (distinct.length !== ids.length) {
    return { ok: false, message: 'duplicate option' };
  }

  const allowed = new Set(options.filter((option) => !option.virtual).map((option) => option.id));
  if (distinct.some((id) => !allowed.has(id))) {
    return { ok: false, message: 'unknown option' };
  }

  if (pollType === PollType.SingleChoice) {
    if (distinct.length !== 1) return { ok: false, message: 'bad request' };
    return { ok: true, optionIds: distinct };
  }
  if (distinct.length < 1 || distinct.length > MAX_POLL_OPTIONS) {
    return { ok: false, message: 'bad request' };
  }
  return { ok: true, optionIds: distinct };
}

// Counts the ballots and the per-option counts of a page of polls. Two
// aggregate queries per type cover everything (paginate, then aggregate): a
// verdict poll keeps its answer in `votes.option`, a choice poll in
// `vote_selections`. Polls without rows keep the zero tally inserted below.
export async function countBallots(
  env: OptionsEnv,
  polls: Array<PollLike & { id: number }>
): Promise<Map<number, PollTally>> {
  const tallies = new Map<number, PollTally>();
  if (polls.length === 0) return tallies;

  const verdictIds: number[] = [];
  const choiceIds: number[] = [];
  for (const poll of polls) {
    const id = Number(poll.id);
    tallies.set(id, { ballots: 0, counts: new Map() });
    if (isChoicePollType(Number(poll.poll_type ?? PollType.Verdict))) choiceIds.push(id);
    else verdictIds.push(id);
  }

  // A ballot is one row in `votes` for every type, so the ballot total is the
  // same query for both groups.
  for (const ids of [verdictIds, choiceIds]) {
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await env.DB.prepare(
      `SELECT poll_id, COUNT(*) AS ballots FROM votes
       WHERE poll_id IN (${placeholders}) GROUP BY poll_id`
    ).bind(...ids).all<{ poll_id: number; ballots: number }>();
    for (const row of rows.results ?? []) {
      const tally = tallies.get(Number(row.poll_id));
      if (tally) tally.ballots = Number(row.ballots);
    }
  }

  if (verdictIds.length > 0) {
    const placeholders = verdictIds.map(() => '?').join(', ');
    const rows = await env.DB.prepare(
      `SELECT poll_id, option, COUNT(*) AS count FROM votes
       WHERE poll_id IN (${placeholders}) AND option IS NOT NULL
       GROUP BY poll_id, option`
    ).bind(...verdictIds).all<{ poll_id: number; option: number; count: number }>();
    for (const row of rows.results ?? []) {
      tallies.get(Number(row.poll_id))?.counts.set(Number(row.option), Number(row.count));
    }
  }

  if (choiceIds.length > 0) {
    const placeholders = choiceIds.map(() => '?').join(', ');
    const rows = await env.DB.prepare(
      `SELECT v.poll_id, vs.option_id, COUNT(*) AS count
       FROM vote_selections vs
       JOIN votes v ON v.id = vs.vote_id
       WHERE v.poll_id IN (${placeholders})
       GROUP BY v.poll_id, vs.option_id`
    ).bind(...choiceIds).all<{ poll_id: number; option_id: number; count: number }>();
    for (const row of rows.results ?? []) {
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
        virtual: option.virtual,
        count: Number(tally.counts.get(option.id) ?? 0)
      }))
  };
}

// The legacy verdict `counts` object, kept on verdict responses so existing
// clients and the pre-existing integration tests keep working.
export function legacyVerdictCounts(
  tally: PollTally
): { approve: number; neutral: number; oppose: number } {
  return {
    approve: Number(tally.counts.get(VoteOption.Approve) ?? 0),
    neutral: Number(tally.counts.get(VoteOption.Neutral) ?? 0),
    oppose: Number(tally.counts.get(VoteOption.Oppose) ?? 0)
  };
}

export { isChoicePollType, pollTypeLabel };
export type { PollTypeLabel };