// Voting endpoints.
//
// Votes are anonymous: the only identifier stored is the SHA-256 hash of a
// per-poll token the browser derives locally. Rate limiting uses a keyed,
// daily-rotated hash of the network bucket (never a raw address) and lives in
// the RateLimiter Durable Object, so no IP-derived value is written to D1.
//
// A ballot is one row in `votes`, which holds no choice data at all, plus one
// `vote_selections` row per chosen option. The unique index on
// (poll_id, voter_token_hash) still enforces one ballot per browser, and the
// options are validated, counted, and rendered through the shared engine in
// worker/services/options.ts. A ballot always reports its selections as option
// IDs; there is no separate verdict field.

import type { HandlerEnv } from '../index';
import { enforceSameOrigin } from '../services/csrf';
import { checkRateLimit } from '../services/rateLimit';
import { clientAddress, hashedNetworkBucket, serverHmacKey } from '../services/ip';
import { isTurnstileEnabled, turnstileSecretKey, verifyTurnstile } from '../services/turnstile';
import {
  countPollBallots,
  getPollOptions,
  toPublicResults,
  validateSelections,
  type PublicResults
} from '../services/options';
import { PollMode, PollStatus, PollType } from '../enums';
import { apiError } from '../../shared/http';

const DEFAULT_VOTE_RATE_LIMIT = '5/h';
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/i;

export async function handleVoteStatusRequest(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('POST_ONLY', 405);
  }

  // `null` is valid JSON, so the shape is checked rather than only parsed: a body
  // that is not an object is a bad request, not a server error.
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError('INVALID_JSON', 400);
  }

  const pollId = Number(body.pollId ?? 0);
  const tokenHash = typeof body.tokenHash === 'string' ? body.tokenHash : '';
  if (!Number.isSafeInteger(pollId) || pollId < 1 || !TOKEN_HASH_PATTERN.test(tokenHash)) {
    return apiError('BAD_REQUEST', 400);
  }

  const vote: { id: number } | null = await env.DB.prepare(
    'SELECT id FROM votes WHERE poll_id = ? AND voter_token_hash = ? LIMIT 1'
  ).bind(pollId, tokenHash).first();

  // The stored choices are reported as option IDs, in display order.
  let optionIds: number[] = [];
  if (vote) {
    const selections = await env.DB.prepare(
      `SELECT vs.option_id
       FROM vote_selections vs
       JOIN poll_options o ON o.id = vs.option_id
       WHERE vs.vote_id = ? ORDER BY o.position ASC`
    ).bind(vote.id).all<{ option_id: number }>();
    optionIds = (selections.results ?? []).map((row) => Number(row.option_id));
  }

  return Response.json({
    pollId,
    voted: Boolean(vote),
    optionIds
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

export async function handleVoteRequest(request: Request, env: HandlerEnv): Promise<Response> {
  // 423 Locked, kept distinct from the 503 that a missing server key returns so a
  // read-only window is not mistaken for a misconfiguration.
  if (env.read_only_mode === true) {
    return apiError('READ_ONLY', 423, { extra: { ok: false } });
  }
  if (request.method !== 'POST') {
    return apiError('POST_ONLY', 405, { extra: { ok: false } });
  }

  // Refused before the body is read. Voting takes no account, so without this a
  // third-party page could POST here from every visitor's browser with a fresh
  // token hash each time, turning each visitor into one ballot from a distinct
  // network bucket and walking around the per-network limit. Turnstile closes the
  // same hole through its hostname check, but it is optional.
  const csrf = enforceSameOrigin(request);
  if (csrf) return csrf;

  // Same shape check as the status endpoint: `null` parses as JSON but is not a
  // ballot, and it has to be a 400 rather than a thrown property read.
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError('INVALID_JSON', 400, { extra: { ok: false } });
  }

  const pollId = Number(body.pollId ?? 0);
  const tokenHash = String(body.tokenHash ?? '');
  const turnstileResponse = String(body.turnstileToken ?? '');

  if (!Number.isSafeInteger(pollId) || pollId < 1 || !TOKEN_HASH_PATTERN.test(tokenHash)) {
    return apiError('BAD_REQUEST', 400, { extra: { ok: false } });
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
    return apiError('POLL_NOT_FOUND', 404, { extra: { ok: false } });
  }

  const pollType = Number(poll.poll_type ?? PollType.SingleChoice);
  const options = await getPollOptions(env, poll);
  const selection = validateSelections(poll, options, body);
  if (!selection.ok) {
    return apiError(selection.code, 400, { extra: { ok: false } });
  }

  // Turnstile is enforced only when both keys are configured.
  if (isTurnstileEnabled(env)) {
    if (!turnstileResponse || !await verifyTurnstile(turnstileSecretKey(env), turnstileResponse, new URL(request.url).hostname)) {
      return apiError('TURNSTILE_FAILED', 403, { extra: { ok: false } });
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const withinDeadline = poll.mode !== PollMode.Deadline
    || ((poll.start_at === null || poll.start_at <= nowSeconds)
      && (poll.end_at === null || nowSeconds <= poll.end_at));
  if (poll.status !== PollStatus.Open || !withinDeadline) {
    return apiError('POLL_NOT_OPEN', 409, { extra: { ok: false } });
  }

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env));
  if (!ipHash) {
    return apiError('SERVER_NOT_CONFIGURED', 503, { extra: { ok: false } });
  }

  const limited = await checkRateLimit(env, 'vote', ipHash, env.vote_rate_limit, DEFAULT_VOTE_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('RATE_LIMIT_EXCEEDED', 429, { extra: { ok: false } });
  }

  // The ON CONFLICT clause both inserts and detects a duplicate in one round
  // trip, so no separate existence check is needed.
  // Timestamps are coarsened to the hour so a vote cannot be correlated with
  // edge logs or with another row created at the same second.
  const coarseNow = nowSeconds - (nowSeconds % 3600);
  const insertResult = await env.DB.prepare(
    `INSERT INTO votes (poll_id, voter_token_hash, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(poll_id, voter_token_hash) DO NOTHING`
  ).bind(pollId, tokenHash, coarseNow).run();

  if (!insertResult.meta.changes) {
    return apiError('DUPLICATE_VOTE', 409, { extra: { ok: false } });
  }

  // The ballot row is written first, then one selection row per chosen option,
  // keyed by the ballot id that was just inserted. A failure while writing the
  // selections rolls the ballot back, so a partial ballot is never left behind.
  const voteId = Number(insertResult.meta.last_row_id);
  if (voteId > 0 && selection.optionIds.length > 0) {
    try {
      await env.DB.batch(selection.optionIds.map((optionId) => env.DB.prepare(
        'INSERT INTO vote_selections (poll_id, vote_id, option_id) VALUES (?, ?, ?)'
      ).bind(pollId, voteId, optionId)));
    } catch {
      await env.DB.prepare('DELETE FROM votes WHERE id = ?').bind(voteId).run();
      return apiError('VOTE_NOT_STORED', 500, { extra: { ok: false } });
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
    voted: true
  });
}
