// Voting endpoints.
//
// Votes are anonymous: the only identifier stored is the SHA-256 hash of a
// per-poll token the browser derives locally. Rate limiting uses a keyed,
// daily-rotated hash of the network bucket (never a raw address) and lives in
// the RateLimiter Durable Object, so no IP-derived value is written to D1.
//
// A ballot is always one row in `votes`. A verdict poll stores its answer in
// `votes.option`; a choice poll stores NULL there and keeps its selections in
// the child table `vote_selections`, so the same unique index still enforces
// one ballot per (poll, token).

import type { HandlerEnv } from '../index';
import { checkRateLimit } from '../services/rateLimit';
import { clientAddress, hashedNetworkBucket, serverHmacKey } from '../services/ip';
import { verifyTurnstile } from '../services/turnstile';
import {
  choiceCounts,
  isChoicePollType,
  MAX_POLL_OPTIONS,
  requiredSelectionCount,
  type ChoiceCounts
} from '../services/pollType';
import {
  getVoteOptionCode,
  getVoteOptionLabel,
  PollMode,
  PollStatus,
  PollType,
  type PollTypeLabel,
  VoteOption as VoteOptionCode,
  type VoteOptionLabel
} from '../enums';

export type VoteOption = VoteOptionLabel;

const DEFAULT_VOTE_RATE_LIMIT = '5/h';
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/i;

// Counts below the configured threshold are withheld so a tiny sample cannot be
// used to infer how one person voted.
function buildCounts(
  counts: Record<VoteOption, number>,
  threshold: number
): { counts: Record<VoteOption, number> | null; hidden: boolean; threshold: number } {
  const total = counts.approve + counts.oppose + counts.neutral;
  if (threshold > 0 && total < threshold) {
    return { counts: null, hidden: true, threshold };
  }
  return { counts, hidden: false, threshold };
}

// Loads the option list of a choice poll, including the count per option, in
// one aggregate query.
async function loadOptionCounts(
  env: HandlerEnv,
  pollId: number
): Promise<Array<{ id: number; label: string; position: number; count: number }>> {
  const result = await env.DB.prepare(
    `SELECT o.id, o.label, o.position, COALESCE(COUNT(vs.vote_id), 0) AS count
     FROM poll_options o
     LEFT JOIN vote_selections vs ON vs.option_id = o.id
     WHERE o.poll_id = ?
     GROUP BY o.id
     ORDER BY o.position ASC`
  ).bind(pollId).all<{ id: number; label: string; position: number; count: number }>();
  return (result.results ?? []).map((row) => ({
    id: Number(row.id),
    label: row.label,
    position: Number(row.position),
    count: Number(row.count)
  }));
}

// Number of ballots cast on a poll. The threshold applies to ballots.
async function countBallots(env: HandlerEnv, pollId: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?'
  ).bind(pollId).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function handleVoteStatusRequest(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ message: 'POST only' }, { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  const pollId = Number(body.pollId ?? 0);
  const tokenHash = typeof body.tokenHash === 'string' ? body.tokenHash : '';
  if (!Number.isSafeInteger(pollId) || pollId < 1 || !TOKEN_HASH_PATTERN.test(tokenHash)) {
    return Response.json({ message: 'bad request' }, { status: 400 });
  }

  const vote: { id: number; option: VoteOptionCode | null } | null = await env.DB.prepare(
    'SELECT id, option FROM votes WHERE poll_id = ? AND voter_token_hash = ? LIMIT 1'
  ).bind(pollId, tokenHash).first();

  // A choice ballot reports its option ids so the page can restore the
  // selection; a verdict ballot reports its single verdict.
  let optionIds: number[] = [];
  if (vote) {
    const selections = await env.DB.prepare(
      'SELECT option_id FROM vote_selections WHERE vote_id = ? ORDER BY option_id ASC'
    ).bind(vote.id).all<{ option_id: number }>();
    optionIds = (selections.results ?? []).map((row) => Number(row.option_id));
  }

  return Response.json({
    pollId,
    voted: Boolean(vote),
    option: vote && vote.option !== null ? getVoteOptionLabel(vote.option) : null,
    optionIds
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}
export async function handleVoteRequest(request: Request, env: HandlerEnv): Promise<Response> {
  if (env.read_only_mode === true) {
    return Response.json({ ok: false, message: 'readonly mode enabled' }, { status: 503 });
  }
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'POST only' }, { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: 'invalid JSON' }, { status: 400 });
  }

  const pollId = Number(body.pollId ?? 0);
  const tokenHash = String(body.tokenHash ?? '');
  const turnstileResponse = String(body.turnstileToken ?? '');

  if (!Number.isSafeInteger(pollId) || pollId < 1 || !TOKEN_HASH_PATTERN.test(tokenHash)) {
    return Response.json({ ok: false, message: 'bad request' }, { status: 400 });
  }

  const poll = await env.DB.prepare(
    'SELECT status, mode, start_at, end_at, poll_type FROM polls WHERE id = ?'
  ).bind(pollId).first<{
    status: number;
    mode: number;
    start_at: number | null;
    end_at: number | null;
    poll_type: number;
  }>();
  if (!poll) {
    return Response.json({ ok: false, message: 'poll not found' }, { status: 404 });
  }

  const pollType = Number(poll.poll_type ?? PollType.Verdict);
  const selection = readSelection(body, pollType);
  if (!selection.ok) {
    return Response.json({ ok: false, message: selection.message }, { status: 400 });
  }

  // Every referenced option must belong to this poll.
  let optionIds: number[] = [];
  if (isChoicePollType(pollType)) {
    optionIds = selection.optionIds;
    const placeholders = optionIds.map(() => '?').join(', ');
    const owned = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM poll_options WHERE poll_id = ? AND id IN (${placeholders})`
    ).bind(pollId, ...optionIds).first<{ total: number }>();
    if (Number(owned?.total ?? 0) !== optionIds.length) {
      return Response.json({ ok: false, message: 'unknown option' }, { status: 400 });
    }
  }

  // Turnstile is enforced only when it is enabled and fully configured.
  if (env.turnstile_enable && env.turnstile_secret_key) {
    if (!turnstileResponse || !await verifyTurnstile(env.turnstile_secret_key, turnstileResponse)) {
      return Response.json({ ok: false, message: 'turnstile verification failed' }, { status: 403 });
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const withinDeadline = poll.mode !== PollMode.Deadline
    || ((poll.start_at === null || poll.start_at <= nowSeconds)
      && (poll.end_at === null || nowSeconds <= poll.end_at));
  if (poll.status !== PollStatus.Open || !withinDeadline) {
    return Response.json({ ok: false, message: 'poll is not open' }, { status: 409 });
  }

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env));
  if (!ipHash) {
    return Response.json({ ok: false, message: 'server key is not configured' }, { status: 503 });
  }

  const limited = await checkRateLimit(env, 'vote', ipHash, env.vote_rate_limit, DEFAULT_VOTE_RATE_LIMIT);
  if (!limited.allowed) {
    return Response.json({ ok: false, message: 'rate limit reached' }, { status: 429 });
  }

  // The ON CONFLICT clause both inserts and detects a duplicate in one round
  // trip, so no separate existence check is needed.
  // Timestamps are coarsened to the hour so a vote cannot be correlated with
  // edge logs or with another row created at the same second.
  const coarseNow = nowSeconds - (nowSeconds % 3600);
  const insertResult = await env.DB.prepare(
    `INSERT INTO votes (poll_id, voter_token_hash, option, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(poll_id, voter_token_hash) DO NOTHING`
  ).bind(pollId, tokenHash, selection.option, coarseNow).run();

  if (!insertResult.meta.changes) {
    return Response.json({ ok: false, message: 'duplicate vote' }, { status: 409 });
  }

  // The selections are written in one batch right after the ballot, keyed by
  // the ballot row that was just inserted.
  if (optionIds.length > 0) {
    const voteId = Number(insertResult.meta.last_row_id);
    if (voteId > 0) {
      await env.DB.batch(optionIds.map((optionId) => env.DB.prepare(
        'INSERT INTO vote_selections (vote_id, option_id) VALUES (?, ?)'
      ).bind(voteId, optionId)));
    }
  }

  const threshold = Number(env.min_votes_to_display ?? 0);

  // A choice poll answers with the ballot total and one entry per option; the
  // threshold applies to the number of ballots.
  if (isChoicePollType(pollType)) {
    const ballots = await countBallots(env, pollId);
    const visible = choiceCounts(ballots, await loadOptionCounts(env, pollId), threshold);
    return Response.json({
      ok: true,
      message: 'vote accepted',
      counts: visible.counts,
      hidden: visible.hidden,
      threshold: visible.threshold,
      voted: true
    });
  }

  const countsResult: any = await env.DB.prepare(
    'SELECT option, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option'
  ).bind(pollId).all();

  const counts: Record<VoteOption, number> = { approve: 0, oppose: 0, neutral: 0 };
  for (const row of countsResult.results ?? []) {
    // A NULL option belongs to a choice ballot and is not a verdict.
    if (row.option === null) continue;
    counts[getVoteOptionLabel(Number(row.option))] = Number(row.count ?? 0);
  }

  const visible = buildCounts(counts, threshold);
  return Response.json({
    ok: true,
    message: 'vote accepted',
    counts: visible.counts,
    hidden: visible.hidden,
    threshold: visible.threshold,
    voted: true
  });
}

type SelectionResult =
  | { ok: true; option: VoteOptionCode | null; optionIds: number[] }
  | { ok: false; message: string };

// Validates the ballot against the poll type: type 1 requires `option` and
// rejects `optionIds`; type 2 requires exactly one distinct id; type 3 requires
// 1 to 7 distinct ids.
function readSelection(body: any, pollType: number): SelectionResult {
  const optionIdsRaw = body?.optionIds;
  if (optionIdsRaw !== undefined && !Array.isArray(optionIdsRaw)) {
    return { ok: false, message: 'bad request' };
  }

  if (!isChoicePollType(pollType)) {
    const option = getVoteOptionCode(body?.option);
    if (option === null) {
      return { ok: false, message: 'bad request' };
    }
    if (Array.isArray(optionIdsRaw) && optionIdsRaw.length > 0) {
      return { ok: false, message: 'this poll does not accept option ids' };
    }
    return { ok: true, option, optionIds: [] };
  }

  if (body?.option !== undefined) {
    return { ok: false, message: 'this poll does not accept a verdict' };
  }
  const ids = (optionIdsRaw as unknown[] | undefined ?? []).map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    return { ok: false, message: 'bad request' };
  }
  const distinct = [...new Set(ids)];
  if (distinct.length !== ids.length) {
    return { ok: false, message: 'duplicate option' };
  }
  const required = requiredSelectionCount(pollType);
  if (!required || distinct.length < required.min
    || distinct.length > Math.min(required.max, MAX_POLL_OPTIONS)) {
    return { ok: false, message: 'bad request' };
  }
  return { ok: true, option: null, optionIds: distinct };
}

export type { ChoiceCounts, PollTypeLabel };