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
import { serverHmacKey } from '../services/ip';
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

  const validation = validateProposal(body);
  if (!validation.ok) {
    return Response.json({ ok: false, message: validation.message }, { status: 400 });
  }
  const { title, description, mode, startAt, endAt } = validation.input;

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
  const hash = await ownerHash(auth.user.id, pollId, serverHmacKey(env));
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

export interface ProposalInput {
  title: string;
  description: string | null;
  mode: PollMode;
  startAt: string;
  endAt: string;
}

export type ProposalValidation =
  | { ok: true; input: ProposalInput }
  | { ok: false; message: string };

// Validates a proposal payload. The description is optional: an empty or omitted
// description is accepted and stored as NULL, while a provided description must
// be substantive (at least MIN_DESCRIPTION_LENGTH characters). A deadline poll
// must include a start time in the future and an end time after the start.
export function validateProposal(body: Record<string, unknown>, now = Date.now()): ProposalValidation {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: `a poll needs a title of at most ${MAX_TITLE_LENGTH} characters` };
  }

  const mode = getPollModeCode(body.mode);
  if (!mode) {
    return { ok: false, message: 'a poll needs a valid voting mode' };
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    return { ok: false, message: 'invalid proposal description' };
  }
  const trimmedDescription = typeof body.description === 'string' ? body.description.trim() : '';
  if (trimmedDescription.length > 0
    && (trimmedDescription.length < MIN_DESCRIPTION_LENGTH || trimmedDescription.length > MAX_DESCRIPTION_LENGTH)) {
    return {
      ok: false,
      message: `a description must be between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters`
    };
  }
  const description = trimmedDescription.length > 0 ? trimmedDescription : null;

  const startAt = typeof body.startAt === 'string' ? body.startAt : '';
  const endAt = typeof body.endAt === 'string' ? body.endAt : '';
  if (mode === PollMode.Deadline) {
    const startTimestamp = Date.parse(startAt);
    const endTimestamp = Date.parse(endAt);
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)
      || startTimestamp <= now || endTimestamp <= startTimestamp) {
      return { ok: false, message: 'a deadline poll needs a start time in the future and an end time after the start' };
    }
  }

  return { ok: true, input: { title, description, mode, startAt, endAt } };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}