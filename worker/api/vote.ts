import { sha256 } from '../services/hashchain';
import {
  getVoteOptionCode,
  getVoteOptionLabel,
  VoteOption as VoteOptionCode,
  type VoteOptionLabel
} from '../enums';

export type VoteOption = VoteOptionLabel;

const DEFAULT_VOTE_RATE_LIMIT_PER_IP_BUCKET_PER_HOUR = 5;
const VOTE_SALT = 'chinapoll-local-dev-salt';

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

  const issueId = Number(body.issueId ?? 0);
  const tokenHash = typeof body.tokenHash === 'string' ? body.tokenHash : '';
  if (!Number.isSafeInteger(issueId) || issueId < 1 || !/^[0-9a-f]{64}$/i.test(tokenHash)) {
    return Response.json({ message: 'bad request' }, { status: 400 });
  }

  const vote: { option: VoteOptionCode } | null = await env.DB.prepare(
    'SELECT option FROM votes WHERE issue_id = ? AND voter_token_hash = ? LIMIT 1'
  ).bind(issueId, tokenHash).first();

  return Response.json({
    issueId,
    voted: Boolean(vote),
    option: vote ? getVoteOptionLabel(vote.option) : null
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

export async function handleVoteRequest(request: Request, env: any): Promise<Response> {
  const voteRateLimit = Number(
    env.VOTE_RATE_LIMIT_PER_IP_BUCKET_PER_HOUR ?? DEFAULT_VOTE_RATE_LIMIT_PER_IP_BUCKET_PER_HOUR
  );
  if (!Number.isSafeInteger(voteRateLimit) || voteRateLimit < 1) {
    return Response.json({ message: 'invalid VOTE_RATE_LIMIT_PER_IP_BUCKET_PER_HOUR configuration' }, { status: 500 });
  }

  if (String(env.READ_ONLY_MODE ?? '').toLowerCase() === 'true') {
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

  const issueId = Number(body.issueId ?? 0);
  const option = getVoteOptionCode(body.option);
  const tokenHash = String(body.tokenHash ?? '');
  const turnstileResponse = String(body.turnstileToken ?? '');

  if (!Number.isSafeInteger(issueId) || issueId < 1 || option === null || !tokenHash) {
    return new Response(JSON.stringify({ ok: false, message: 'bad request' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const localSkipTurnstile = String(env.TURNSTILE_SKIP ?? '').toLowerCase() === 'true' || !env.TURNSTILE_SECRET_KEY;
  if (!localSkipTurnstile && !turnstileResponse) {
    return new Response(JSON.stringify({ ok: false, message: 'turnstile verification required' }), {
      status: 403,
      headers: { 'content-type': 'application/json' }
    });
  }

  const remoteIp = request.headers.get('cf-connecting-ip') ?? '127.0.0.1';
  const ipPrefixHash = await sha256(`${VOTE_SALT}:${remoteIp.split('.').slice(0, 3).join('.')}`);
  const tsHour = Math.floor(Date.now() / 3_600_000) * 3_600;

  const existingVote: any = await env.DB.prepare(
    'SELECT id FROM votes WHERE issue_id = ? AND voter_token_hash = ? LIMIT 1'
  ).bind(issueId, tokenHash).first();

  if (existingVote) {
    return new Response(JSON.stringify({ ok: false, message: 'duplicate vote' }), {
      status: 409,
      headers: { 'content-type': 'application/json' }
    });
  }

  const rateLimitResult: any = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM votes WHERE ip_prefix_hash = ? AND ts_hour = ?`
  ).bind(ipPrefixHash, tsHour).first();

  if ((Number(rateLimitResult?.count ?? 0)) >= voteRateLimit) {
    return new Response(JSON.stringify({ ok: false, message: 'rate limit reached' }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    });
  }

  const insertResult = await env.DB.prepare(
    `INSERT INTO votes (issue_id, voter_token_hash, ip_prefix_hash, option, ts_hour)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(issue_id, voter_token_hash) DO NOTHING`
  ).bind(issueId, tokenHash, ipPrefixHash, option, tsHour).run();

  if (!insertResult.meta.changes) {
    return new Response(JSON.stringify({ ok: false, message: 'duplicate vote' }), {
      status: 409,
      headers: { 'content-type': 'application/json' }
    });
  }

  const countsResult: any = await env.DB.prepare(
    `SELECT option, COUNT(*) as count FROM votes WHERE issue_id = ? GROUP BY option`
  ).bind(issueId).all();

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
