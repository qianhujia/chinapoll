import { sha256 } from '../services/hashchain';
import { D1Database } from '@cloudflare/workers-types';
import { RATE_LIMIT_PATTERN } from './settings';
import {
  getVoteOptionCode,
  getVoteOptionLabel,
  VoteOption as VoteOptionCode,
  type VoteOptionLabel
} from '../enums';

export type VoteOption = VoteOptionLabel;

const DEFAULT_VOTE_RATE_LIMIT = '5/h';
const VOTE_SALT = 'chinapoll-local-dev-salt';

function parseRateLimit(rateLimitStr: string): { count: number; windowMs: number } {
  const match = rateLimitStr.match(RATE_LIMIT_PATTERN);
  if (!match) return { count: 5, windowMs: 3_600_000 };
  const count = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    w: 7 * 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000
  };
  return { count, windowMs: unitMs[unit] || 3_600_000 };
}

async function getVoteRateLimit(db: D1Database): Promise<{ count: number; windowMs: number }> {
  const row = await db.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).bind('vote_rate_limit').first();

  if (row?.value && typeof row.value === 'string') {
    return parseRateLimit(row.value);
  }
  return parseRateLimit(DEFAULT_VOTE_RATE_LIMIT);
}

export async function handleVoteStatusRequest(request: Request, env: any): Promise<Response> {
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
  if (!Number.isSafeInteger(pollId) || pollId < 1 || !/^[0-9a-f]{64}$/i.test(tokenHash)) {
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

export async function handleVoteRequest(request: Request, env: any): Promise<Response> {
  const { count: voteRateLimit, windowMs: voteWindowMs } = await getVoteRateLimit(env.DB);
  const now = Date.now();
  const bucketStart = now - (now % voteWindowMs);

  if (env.read_only_mode === true) {
    return new Response(JSON.stringify({ ok: false, message: 'readonly mode enabled' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, message: 'POST only' }), {
      status: 405,
      headers: { 'content-type': 'application/json' }
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, message: 'invalid JSON' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const pollId = Number(body.pollId ?? 0);
  const option = getVoteOptionCode(body.option);
  const tokenHash = String(body.tokenHash ?? '');
  const turnstileResponse = String(body.turnstileToken ?? '');

  if (!Number.isSafeInteger(pollId) || pollId < 1 || option === null || !tokenHash) {
    return new Response(JSON.stringify({ ok: false, message: 'bad request' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const localSkipTurnstile = !env.turnstile_enable || !env.turnstile_secret_key;
  if (!localSkipTurnstile && !turnstileResponse) {
    return new Response(JSON.stringify({ ok: false, message: 'turnstile verification required' }), {
      status: 403,
      headers: { 'content-type': 'application/json' }
    });
  }

  const remoteIp = request.headers.get('cf-connecting-ip') ?? '127.0.0.1';
  const ipPrefixHash = await sha256(`${VOTE_SALT}:${remoteIp.split('.').slice(0, 3).join('.')}`);
  const tsBucket = bucketStart;

  const existingVote: any = await env.DB.prepare(
    'SELECT id FROM votes WHERE poll_id = ? AND voter_token_hash = ? LIMIT 1'
  ).bind(pollId, tokenHash).first();

  if (existingVote) {
    return new Response(JSON.stringify({ ok: false, message: 'duplicate vote' }), {
      status: 409,
      headers: { 'content-type': 'application/json' }
    });
  }

  const rateLimitResult: any = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM votes WHERE ip_prefix_hash = ? AND ts_bucket = ?`
  ).bind(ipPrefixHash, tsBucket).first();

  if ((Number(rateLimitResult?.count ?? 0)) >= voteRateLimit) {
    return new Response(JSON.stringify({ ok: false, message: 'rate limit reached' }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    });
  }

  const insertResult = await env.DB.prepare(
    `INSERT INTO votes (poll_id, voter_token_hash, ip_prefix_hash, option, ts_bucket)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(poll_id, voter_token_hash) DO NOTHING`
  ).bind(pollId, tokenHash, ipPrefixHash, option, tsBucket).run();

  if (!insertResult.meta.changes) {
    return new Response(JSON.stringify({ ok: false, message: 'duplicate vote' }), {
      status: 409,
      headers: { 'content-type': 'application/json' }
    });
  }

  const countsResult: any = await env.DB.prepare(
    `SELECT option, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option`
  ).bind(pollId).all();

  const counts: Record<VoteOption, number> = { approve: 0, oppose: 0, neutral: 0 };
  for (const row of countsResult.results ?? []) {
    const key = getVoteOptionLabel(Number(row.option));
    counts[key] = Number(row.count ?? 0);
  }

  return new Response(JSON.stringify({
    ok: true,
    message: 'vote accepted',
    counts,
    voted: true
  }), {
    headers: { 'content-type': 'application/json' }
  });
}
