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
// one ballot per (poll, token). All three types are validated, counted, and
// rendered through the shared engine in worker/services/options.ts.

import type { HandlerEnv } from '../index';
import { checkRateLimit } from '../services/rateLimit';
import { clientAddress, hashedNetworkBucket, serverHmacKey } from '../services/ip';
import { verifyTurnstile } from '../services/turnstile';
import {
  countPollBallots,
  getPollOptions,
  isChoicePollType,
  legacyVerdictCounts,
  toPublicResults,
  validateSelections,
  type PublicResults
} from '../services/options';
import {
  getVoteOptionLabel,
  PollMode,
  PollStatus,
  PollType,
  VoteOption as VoteOptionCode
} from '../enums';

const DEFAULT_VOTE_RATE_LIMIT = '5/h';
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/i;

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

  // Every type reports the stored selections as option IDs. A verdict poll also
  // reports its single verdict, so the two views agree.
  let optionIds: number[] = [];
  if (vote) {
    if (vote.option !== null) {
      optionIds = [Number(vote.option)];
    } else {
      const selections = await env.DB.prepare(
        'SELECT option_id FROM vote_selections WHERE vote_id = ? ORDER BY option_id ASC'
      ).bind(vote.id).all<{ option_id: number }>();
      optionIds = (selections.results ?? []).map((row) => Number(row.option_id));
    }
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
    'SELECT id, status, mode, start_at, end_at, poll_type FROM polls WHERE id = ?'
  ).bind(pollId).first<{
    id: number;
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
  const options = await getPollOptions(env, poll);
  const selection = validateSelections(poll, options, body);
  if (!selection.ok) {
    return Response.json({ ok: false, message: selection.message }, { status: 400 });
  }
  // A verdict ballot stores its verdict in `votes.option`; a choice ballot
  // stores NULL there and its selections in `vote_selections`.
  const verdictCode = isChoicePollType(pollType) ? null : selection.optionIds[0];

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
  ).bind(pollId, tokenHash, verdictCode, coarseNow).run();

  if (!insertResult.meta.changes) {
    return Response.json({ ok: false, message: 'duplicate vote' }, { status: 409 });
  }

  // The ballot and, for a choice poll, its selections are written as one batch,
  // keyed by the ballot row that was just inserted.
  if (isChoicePollType(pollType) && selection.optionIds.length > 0) {
    const voteId = Number(insertResult.meta.last_row_id);
    if (voteId > 0) {
      await env.DB.batch(selection.optionIds.map((optionId) => env.DB.prepare(
        'INSERT INTO vote_selections (vote_id, option_id) VALUES (?, ?)'
      ).bind(voteId, optionId)));
    }
  }

  // One results shape for every type; the threshold applies to the number of
  // ballots, so every option count is withheld together below it.
  const threshold = Number(env.min_votes_to_display ?? 0);
  const tally = await countPollBallots(env, { id: pollId, poll_type: pollType });
  const results: PublicResults = toPublicResults(poll, options, tally, threshold);

  return Response.json({
    ok: true,
    message: 'vote accepted',
    ...results,
    // Kept so existing clients keep reading the verdict counts the same way.
    counts: isChoicePollType(pollType) || results.hidden ? null : legacyVerdictCounts(tally),
    voted: true
  });
}
