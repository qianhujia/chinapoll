import { getPollModeCode, PollMode, PollStatus, toUnixSeconds } from '../enums';
import { RATE_LIMIT_PATTERN } from './settings';
import { ipBucket } from '../services/ip';
import { requireUser } from '../services/session';
import { checkAccountAge } from '../services/users';

interface ProposalEnv {
  DB: D1Database;
  user_poll_delay_hours?: number;
  auto_approve_polls?: boolean;
}

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const DEFAULT_PROPOSAL_RATE_LIMIT = '1/d';
const DEFAULT_POLL_DELAY_HOURS = 48;

function parseRateLimit(rateLimitStr: string): { count: number; windowMs: number } {
  const match = rateLimitStr.match(RATE_LIMIT_PATTERN);
  if (!match) return { count: 1, windowMs: 24 * 60 * 60 * 1000 };
  const count = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    w: 7 * 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000
  };
  return { count, windowMs: unitMs[unit] || 24 * 60 * 60 * 1000 };
}

async function getProposalRateLimit(db: any): Promise<{ count: number; windowMs: number }> {
  const row = await db.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).bind('proposal_rate_limit').first();

  if (row?.value && typeof row.value === 'string') {
    return parseRateLimit(row.value);
  }
  return parseRateLimit(DEFAULT_PROPOSAL_RATE_LIMIT);
}

export async function handleProposalRequest(request: Request, env: ProposalEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'POST only' }, { status: 405 });
  }

  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const delayHours = Number(env.user_poll_delay_hours ?? DEFAULT_POLL_DELAY_HOURS);
  const accountAge = checkAccountAge(auth.user.createdAt, delayHours);
  if (!accountAge.allowed) {
    return Response.json({
      ok: false,
      message: `new accounts can submit a poll once the account is ${delayHours} hours old`,
      remainingHours: accountAge.remainingHours
    }, { status: 403 });
  }

  const body = await readJson(request);
  if (!body) {
    return Response.json({ ok: false, message: 'invalid JSON' }, { status: 400 });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const mode = getPollModeCode(body.mode);
  const startAt = typeof body.startAt === 'string' ? body.startAt : '';
  const endAt = typeof body.endAt === 'string' ? body.endAt : '';
  const startTimestamp = Date.parse(startAt);
  const endTimestamp = Date.parse(endAt);
  if (body.description !== undefined && typeof body.description !== 'string') {
    return Response.json({ ok: false, message: 'invalid proposal description' }, { status: 400 });
  }
  if (!title || title.length > MAX_TITLE_LENGTH || description.length > MAX_DESCRIPTION_LENGTH || !mode
    || (mode === PollMode.Deadline && (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)
      || startTimestamp <= Date.now() || endTimestamp <= startTimestamp))) {
    return Response.json({ ok: false, message: 'invalid proposal title or schedule' }, { status: 400 });
  }

  const { count: proposalRateLimit, windowMs: proposalWindowMs } = await getProposalRateLimit(env.DB);
  const now = Date.now();
  const bucketStart = now - (now % proposalWindowMs);

  const remoteIp = request.headers.get('cf-connecting-ip') ?? '127.0.0.1';
  const ipPrefix = ipBucket(remoteIp);

  const rateLimitResult: any = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM polls WHERE ip_prefix = ? AND ts_bucket = ?`
  ).bind(ipPrefix, bucketStart).first();

  if ((Number(rateLimitResult?.count ?? 0)) >= proposalRateLimit) {
    return Response.json({ ok: false, message: 'proposal rate limit reached' }, { status: 429 });
  }

  // With auto-approval enabled a submitted poll is published immediately;
  // otherwise it stays pending until an admin approves it.
  const autoApprove = env.auto_approve_polls === true;

  const result = await env.DB.prepare(
    `INSERT INTO polls (title, description, mode, start_at, end_at, status, reviewed_at, ip_prefix, ts_bucket, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    title,
    description || null,
    mode,
    mode === PollMode.Deadline ? toUnixSeconds(startAt) : null,
    mode === PollMode.Deadline ? toUnixSeconds(endAt) : null,
    autoApprove ? PollStatus.Open : PollStatus.Pending,
    autoApprove ? Math.floor(Date.now() / 1000) : null,
    ipPrefix,
    bucketStart,
    auth.user.id
  ).run();

  const pollId = Number(result.meta.last_row_id);
  return Response.json({
    ok: true,
    message: autoApprove ? 'poll published' : 'proposal submitted for review',
    pollId,
    status: autoApprove ? 'open' : 'pending',
    submitter: auth.user.username
  }, { status: 201 });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
