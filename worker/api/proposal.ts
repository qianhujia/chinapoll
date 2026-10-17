// Poll proposal submission.
//
// Submitting requires a signed-in account and the account-age gate. Just like a
// vote, a proposal is rate limited per account through the Durable Object. The
// response deliberately omits the submitter so no public JSON carries a username.
//
// The form carries a duration instead of a start and end time: `none` means the
// poll never ends and every other label is a fixed number of days. The end date
// itself is computed when the poll opens, so a poll that waits for review still
// gets its full duration.

import type { HandlerEnv } from '../index';
import {
  durationMode,
  durationSeconds,
  getPollTypeCode,
  getPollTypeLabel,
  isPollDuration,
  PollMode,
  PollStatus,
  PollType,
  POLL_DURATIONS,
  type PollDuration
} from '../enums';
import { validatePollOptions, type ParsedOption } from '../services/pollType';
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
  const { title, description, pollType, duration, options } = validation.input;
  const mode = durationMode(duration);

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

  // `start_at` is no longer written: a new poll has no start time and its end
  // date is stamped when it opens. An auto-approved deadline poll opens in the
  // same statement, so only then is its end date computed here.
  const openNow = autoApprove && mode === PollMode.Deadline;
  const endAt = openNow ? durationSeconds(duration) : null;
  const result = await env.DB.prepare(
    `INSERT INTO polls (title, description, mode, poll_type, duration_seconds, end_at, status, reviewed_at)
     VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN unixepoch() + ? ELSE NULL END, ?, ?)`
  ).bind(
    title,
    description,
    mode,
    pollType,
    durationSeconds(duration),
    openNow ? 1 : 0,
    endAt ?? 0,
    autoApprove ? PollStatus.Open : PollStatus.Pending,
    autoApprove ? Math.floor(Date.now() / 1000) : null
  ).run();

  const pollId = Number(result.meta.last_row_id);

  // The options of a choice poll are written right after the poll row. The
  // poll id is the only link and the labels are public anyway.
  if (options.length > 0 && pollId > 0) {
    await env.DB.batch(options.map((option) => env.DB.prepare(
      'INSERT INTO poll_options (poll_id, position, label) VALUES (?, ?, ?)'
    ).bind(pollId, option.position, option.label)));
  }

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
    pollType: getPollTypeLabel(pollType),
    status: autoApprove ? 'open' : 'pending'
  }, { status: 201 });
}

export interface ProposalInput {
  title: string;
  description: string | null;
  pollType: PollType;
  duration: PollDuration;
  options: ParsedOption[];
}

export type ProposalValidation =
  | { ok: true; input: ProposalInput }
  | { ok: false; message: string };

// Validates a proposal payload. The description is optional: an empty or omitted
// description is accepted and stored as NULL, while a provided description must
// be substantive (at least MIN_DESCRIPTION_LENGTH characters). The duration is
// required and must be one of the seven offered labels; a choice poll must carry
// 2 to 7 options, each 1 to 80 characters after trimming and all distinct.
export function validateProposal(body: Record<string, unknown>): ProposalValidation {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: `a poll needs a title of at most ${MAX_TITLE_LENGTH} characters` };
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

  // `pollType` is optional and defaults to verdict so a client that predates the
  // poll types release keeps working.
  const pollType = body.pollType === undefined
    ? PollType.Verdict
    : getPollTypeCode(body.pollType);
  if (pollType === null) {
    return { ok: false, message: 'a poll needs a valid type' };
  }

  if (!isPollDuration(body.duration)) {
    return { ok: false, message: `duration must be one of ${POLL_DURATIONS.join(', ')}` };
  }

  // Options are required for a choice poll and forbidden for a verdict poll. A
  // plain string array is accepted as well as `{ position, label }` entries, so
  // the client can submit the rows in order.
  let options: ParsedOption[] = [];
  if (pollType !== PollType.Verdict) {
    const optionValidation = validatePollOptions(body.options);
    if (!optionValidation.ok) return { ok: false, message: optionValidation.message };
    options = optionValidation.options;
  } else if (Array.isArray(body.options) && body.options.length > 0) {
    return { ok: false, message: 'a verdict poll does not accept options' };
  }

  return {
    ok: true,
    input: { title, description, pollType, duration: body.duration, options }
  };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}