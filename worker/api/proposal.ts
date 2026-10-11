// Poll proposal submission.
//
// Submitting requires a signed-in account and the account-age gate. Just like a
// vote, a proposal is rate limited per account through the Durable Object. The
// response deliberately omits the submitter so no public JSON carries a username.

import type { HandlerEnv } from '../index';
import { getPollModeCode, PollMode, PollStatus, toUnixSeconds } from '../enums';
import { checkRateLimit } from '../services/rateLimit';
import { enforceSameOrigin } from '../services/csrf';
import { ownerHash } from '../services/owner';
import { requireUser } from '../services/session';
import { checkAccountAge } from '../services/users';

const MAX_TITLE_LENGTH = 200;
const MIN_DESCRIPTION_LENGTH = 20;
const MAX_DESCRIPTION_LENGTH = 2000;
const DEFAULT_PROPOSAL_RATE_LIMIT = '1/d';
const DEFAULT_POLL_DELAY_HOURS = 48;

export async function handleProposalRequest(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'POST only' }, { status: 405 });
  }

  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

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
  if (!title || title.length > MAX_TITLE_LENGTH || !mode
    || description.length < MIN_DESCRIPTION_LENGTH || description.length > MAX_DESCRIPTION_LENGTH
    || (mode === PollMode.Deadline && (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)
      || startTimestamp <= Date.now() || endTimestamp <= startTimestamp))) {
    return Response.json({
      ok: false,
      message: `a poll needs a title, a description of at least ${MIN_DESCRIPTION_LENGTH} characters, and a valid schedule`
    }, { status: 400 });
  }

  // Reject case-insensitive duplicate titles among polls that are pending or open.
  const duplicate = await env.DB.prepare(
    `SELECT id FROM polls
     WHERE status IN (?, ?) AND LOWER(TRIM(title)) = LOWER(TRIM(?)) LIMIT 1`
  ).bind(PollStatus.Pending, PollStatus.Open, title).first<{ id: number }>();
  if (duplicate) {
    return Response.json({ ok: false, message: 'a poll with this title is already pending or open' }, { status: 409 });
  }

  const limited = await checkRateLimit(env, 'proposal', `user:${auth.user.id}`, env.proposal_rate_limit, DEFAULT_PROPOSAL_RATE_LIMIT);
  if (!limited.allowed) {
    return Response.json({ ok: false, message: 'proposal rate limit reached' }, { status: 429 });
  }

  // With auto-approval enabled a submitted poll is published immediately;
  // otherwise it stays pending until an admin approves it.
  const autoApprove = env.auto_approve_polls === true;

  const result = await env.DB.prepare(
    `INSERT INTO polls (title, description, mode, start_at, end_at, status, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    title,
    description,
    mode,
    mode === PollMode.Deadline ? toUnixSeconds(startAt) : null,
    mode === PollMode.Deadline ? toUnixSeconds(endAt) : null,
    autoApprove ? PollStatus.Open : PollStatus.Pending,
    autoApprove ? Math.floor(Date.now() / 1000) : null
  ).run();

  const pollId = Number(result.meta.last_row_id);

  // The owner is stored as a one-way hash computed with the poll id, so it can
  // only be written after the row exists.
  const hash = await ownerHash(auth.user.id, pollId, env.IP_HASH_KEY);
  if (hash) {
    await env.DB.prepare('UPDATE polls SET owner_hash = ? WHERE id = ?').bind(hash, pollId).run();
  }

  return Response.json({
    ok: true,
    message: autoApprove ? 'poll published' : 'proposal submitted for review',
    pollId,
    status: autoApprove ? 'open' : 'pending'
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