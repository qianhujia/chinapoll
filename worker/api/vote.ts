// Voting endpoints.
//
// Votes are anonymous: the only identifier stored is the SHA-256 hash of a
// per-poll token the browser derives locally. Rate limiting uses a keyed,
// daily-rotated hash of the network bucket (never a raw address) and lives in
// the RateLimiter Durable Object, so no IP-derived value is written to D1.

import type { HandlerEnv } from '../index';
import { checkRateLimit } from '../services/rateLimit';
import { clientAddress, hashedNetworkBucket } from '../services/ip';
import { verifyTurnstile } from '../services/turnstile';
import {
  getVoteOptionCode,
  getVoteOptionLabel,
  PollMode,
  PollStatus,
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

  const vote: { option: VoteOptionCode } | null = await env.DB.prepare(
    'SELECT option FROM votes WHERE poll_id = ? AND voter_token_hash = ? LIMIT 1'
  ).bind(pollId, tokenHash).first();

  return Response.json({
    pollId,
    voted: Boolean(vote),
    option: vote ? getVoteOptionLabel(vote.option) : null
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
  const option = getVoteOptionCode(body.option);
  const tokenHash = String(body.tokenHash ?? '');
  const turnstileResponse = String(body.turnstileToken ?? '');

  if (!Number.isSafeInteger(pollId) || pollId < 1 || option === null || !TOKEN_HASH_PATTERN.test(tokenHash)) {
    return Response.json({ ok: false, message: 'bad request' }, { status: 400 });
  }

  // Turnstile is enforced only when it is enabled and fully configured.
  if (env.turnstile_enable && env.turnstile_secret_key) {
    if (!turnstileResponse || !await verifyTurnstile(env.turnstile_secret_key, turnstileResponse)) {
      return Response.json({ ok: false, message: 'turnstile verification failed' }, { status: 403 });
    }
  }

  const poll = await env.DB.prepare(
    'SELECT status, mode, start_at, end_at FROM polls WHERE id = ?'
  ).bind(pollId).first<{ status: number; mode: number; start_at: number | null; end_at: number | null }>();
  if (!poll) {
    return Response.json({ ok: false, message: 'poll not found' }, { status: 404 });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const withinDeadline = poll.mode !== PollMode.Deadline
    || ((poll.start_at === null || poll.start_at <= nowSeconds)
      && (poll.end_at === null || nowSeconds <= poll.end_at));
  if (poll.status !== PollStatus.Open || !withinDeadline) {
    return Response.json({ ok: false, message: 'poll is not open' }, { status: 409 });
  }

  const ipHash = await hashedNetworkBucket(clientAddress(request), env.IP_HASH_KEY);
  if (!ipHash) {
    return Response.json({ ok: false, message: 'ip hash key is not configured' }, { status: 503 });
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
  ).bind(pollId, tokenHash, option, coarseNow).run();

  if (!insertResult.meta.changes) {
    return Response.json({ ok: false, message: 'duplicate vote' }, { status: 409 });
  }

  const countsResult: any = await env.DB.prepare(
    'SELECT option, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option'
  ).bind(pollId).all();

  const counts: Record<VoteOption, number> = { approve: 0, oppose: 0, neutral: 0 };
  for (const row of countsResult.results ?? []) {
    counts[getVoteOptionLabel(Number(row.option))] = Number(row.count ?? 0);
  }

  const threshold = Number(env.min_votes_to_display ?? 0);
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