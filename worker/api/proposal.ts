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
import { DEFAULT_AI_MODEL, categorisePoll, reviewPoll } from '../services/ai';
import { loadEnabledTopics } from './categories';
import { TOPIC_SLUG_PATTERN, topicNames } from '../../shared/categories';
import { checkRateLimit } from '../services/rateLimit';
import { enforceSameOrigin } from '../services/csrf';
import { ownerHash } from '../services/owner';
import { isValidServerKey, serverHmacKey } from '../services/ip';
import { pollNumberStatement } from '../services/pollNumber';
import { requireUser } from '../services/session';
import { checkAccountAge } from '../services/users';
import { apiError } from '../../shared/http';
import { errorMessage, type ApiErrorCode, type ApiErrorParams } from '../../shared/errors';

const MAX_TITLE_LENGTH = 200;
const MIN_DESCRIPTION_LENGTH = 20;
const MAX_DESCRIPTION_LENGTH = 2000;
const DEFAULT_PROPOSAL_RATE_LIMIT = '1/d';
const DEFAULT_POLL_DELAY_HOURS = 48;

export async function handleProposalRequest(request: Request, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('POST_ONLY', 405, { extra: { ok: false } });
  }

  const auth = await requireUser(request, env);
  if (!auth.ok) return auth.response;

  const csrf = enforceSameOrigin(request, { viaCookie: true });
  if (csrf) return csrf;

  // The owner hash is the only thing that lets the submitter list, close, or
  // withdraw this poll later, and it can be derived only with the server key. A
  // deployment without that key must refuse the submission rather than write a poll
  // whose owner can never be established: the row would be public and permanently
  // unmanageable while the submitter still received a success response. The check
  // runs before the insert, so no such row is ever created.
  if (!isValidServerKey(serverHmacKey(env))) {
    return apiError('SERVER_NOT_CONFIGURED', 503, { extra: { ok: false } });
  }

  const delayHours = Number(env.user_poll_delay_hours ?? DEFAULT_POLL_DELAY_HOURS);
  const accountAge = checkAccountAge(auth.user.createdAt, delayHours);
  if (!accountAge.allowed) {
    return apiError('ACCOUNT_TOO_NEW_POLL', 403, {
      params: { hours: delayHours },
      extra: { ok: false, remainingHours: accountAge.remainingHours }
    });
  }

  const body = await readJson(request);
  if (!body) {
    return apiError('INVALID_JSON', 400, { extra: { ok: false } });
  }

  const validation = validateProposal(body);
  if (!validation.ok) {
    return apiError(validation.code, 400, { params: validation.params, extra: { ok: false } });
  }
  const { title, description, pollType, duration, options } = validation.input;
  const mode = durationMode(duration);

  // Reject case-insensitive duplicate titles among polls that are pending or open.
  const duplicate = await env.DB.prepare(
    `SELECT id FROM polls
     WHERE status IN (?, ?) AND LOWER(TRIM(title)) = LOWER(TRIM(?)) LIMIT 1`
  ).bind(PollStatus.Pending, PollStatus.Open, title).first<{ id: number }>();
  if (duplicate) {
    return apiError('DUPLICATE_POLL_TITLE', 409, { extra: { ok: false } });
  }

  const limited = await checkRateLimit(env, 'proposal', `user:${auth.user.id}`, env.proposal_rate_limit, DEFAULT_PROPOSAL_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('PROPOSAL_RATE_LIMIT', 429, { extra: { ok: false } });
  }

  // The submitter's explicit category always wins. Only when none was chosen does
  // an enabled auto-topic fill it in, and a failed suggestion simply leaves
  // the poll untopicalized.
  const requestedTopic = typeof body.topic === 'string' ? body.topic.trim().toLowerCase() : '';
  let topicId: number | null = null;
  if (requestedTopic) {
    if (!TOPIC_SLUG_PATTERN.test(requestedTopic)) {
      return apiError('INVALID_TOPIC', 400, { extra: { ok: false } });
    }
    const topics = await loadEnabledTopics(env);
    const match = topics.find((topic) => topic.slug === requestedTopic);
    if (!match) {
      return apiError('UNKNOWN_TOPIC', 400, { extra: { ok: false } });
    }
    topicId = match.id;
  }
  if (topicId === null && env.ai_auto_topic === true && env.ai_provider !== 'off') {
    topicId = await suggestTopic(env, title, description);
  }

  // With auto-approval enabled a submitted poll is published immediately, unless
  // the admin configured an AI review prompt and AI is enabled: then the model
  // decides, and a rejected or failed review leaves the poll pending for an admin.
  const reviewPrompt = (env.ai_review_prompt ?? '').trim();
  let autoApprove = env.auto_approve_polls === true;
  if (autoApprove && env.ai_provider !== 'off' && reviewPrompt) {
    autoApprove = await reviewProposal(env, reviewPrompt, {
      title,
      description,
      pollType: getPollTypeLabel(pollType),
      options: options.map((option) => option.label)
    });
  }

  // `start_at` is no longer written: a new poll has no start time and its end
  // date is stamped when it opens. An auto-approved deadline poll opens in the
  // same statement, so only then is its end date computed here.
  const openNow = autoApprove && mode === PollMode.Deadline;
  const endAt = openNow ? durationSeconds(duration) : null;

  // The poll row and its option rows are written as one batch. `last_insert_rowid()`
  // would be clobbered by the first option insert, so the new poll id is read
  // back through a scalar subquery that each statement evaluates itself. The poll
  // id is the only link and the labels are public anyway.
  const newPollId = '(SELECT id FROM polls ORDER BY id DESC LIMIT 1)';
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO polls (title, description, mode, poll_type, duration_seconds, end_at, status, reviewed_at, topic_id)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN unixepoch() + ? ELSE NULL END, ?, ?, ?)`
    ).bind(
      title,
      description,
      mode,
      pollType,
      durationSeconds(duration),
      openNow ? 1 : 0,
      endAt ?? 0,
      autoApprove ? PollStatus.Open : PollStatus.Pending,
      autoApprove ? Math.floor(Date.now() / 1000) : null,
      topicId
    ),
    ...options.map((option) => env.DB.prepare(
      `INSERT INTO poll_options (poll_id, position, label)
       VALUES (${newPollId}, ?, ?)`
    ).bind(option.position, option.label))
  ];

  const results = await env.DB.batch(statements);
  const pollId = Number(results[0]?.meta.last_row_id ?? 0);

  // The owner is stored as a one-way hash computed with the poll id, so it can
  // only be written after the row exists. The server key was verified before the
  // insert, so the hash is always available here. An auto-approved poll also takes
  // its public number now; both run as one transaction, so a published poll is
  // never left without an owner or a number.
  const followUp: D1PreparedStatement[] = [];
  const hash = await ownerHash(auth.user.id, pollId, serverHmacKey(env));
  if (hash) {
    followUp.push(env.DB.prepare('UPDATE polls SET owner_hash = ? WHERE id = ?').bind(hash, pollId));
  }
  if (autoApprove) {
    followUp.push(pollNumberStatement(env.DB, pollId));
  }
  if (followUp.length > 0) await env.DB.batch(followUp);

  return Response.json({
    ok: true,
    message: autoApprove ? 'poll published' : 'proposal submitted for review',
    pollId,
    pollType: getPollTypeLabel(pollType),
    status: autoApprove ? 'open' : 'pending'
  }, { status: 201 });
}

// Runs the admin-defined review prompt against a submission. Any failure (model
// error, timeout, or unusable answer) is treated as "not approved" so the poll
// stays pending for a human instead of being published unreviewed.
async function reviewProposal(
  env: HandlerEnv,
  prompt: string,
  input: { title: string; description: string | null; pollType: string; options: string[] }
): Promise<boolean> {
  const result = await reviewPoll(
    env,
    env.ai_model?.trim() || DEFAULT_AI_MODEL,
    prompt,
    {
      title: input.title,
      description: input.description ?? undefined,
      pollType: input.pollType,
      options: input.options
    }
  );
  return result.ok && result.value === true;
}

// Asks the categoriser for a slug and maps it to an enabled topic id. Any
// failure (model error, no match) leaves the poll untopicalized.
async function suggestTopic(
  env: HandlerEnv,
  title: string,
  description: string | null
): Promise<number | null> {
  const topics = await loadEnabledTopics(env);
  if (topics.length === 0) return null;
  const result = await categorisePoll(env, env.ai_model?.trim() || DEFAULT_AI_MODEL, {
    title,
    description: description ?? undefined,
    topics: topics.map((topic) => ({
      slug: topic.slug,
      names: topicNames(topic.slug, topic.name)
    }))
  });
  if (!result.ok || !result.value) return null;
  return topics.find((topic) => topic.slug === result.value)?.id ?? null;
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
  | { ok: false; code: ApiErrorCode; params: ApiErrorParams; message: string };

// Validates a proposal payload. The description is optional: an empty or omitted
// description is accepted and stored as NULL, while a provided description must
// be substantive (at least MIN_DESCRIPTION_LENGTH characters). The duration and
// the poll type are required, and the poll must carry 2 to 7 options, each 1 to
// 80 characters after trimming and all distinct.
export function validateProposal(body: Record<string, unknown>): ProposalValidation {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    const params = { max: MAX_TITLE_LENGTH };
    return { ok: false, code: 'TITLE_TOO_LONG', params, message: errorMessage('TITLE_TOO_LONG', params) };
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    return { ok: false, code: 'PROPOSAL_DESCRIPTION_INVALID', params: {}, message: errorMessage('PROPOSAL_DESCRIPTION_INVALID') };
  }
  const trimmedDescription = typeof body.description === 'string' ? body.description.trim() : '';
  if (trimmedDescription.length > 0
    && (trimmedDescription.length < MIN_DESCRIPTION_LENGTH || trimmedDescription.length > MAX_DESCRIPTION_LENGTH)) {
    const params = { min: MIN_DESCRIPTION_LENGTH, max: MAX_DESCRIPTION_LENGTH };
    return { ok: false, code: 'DESCRIPTION_LENGTH', params, message: errorMessage('DESCRIPTION_LENGTH', params) };
  }
  const description = trimmedDescription.length > 0 ? trimmedDescription : null;

  // `pollType` is required and is one of the three stored types (verdict, single
  // choice, multiple choice). A "verdict" poll is submitted as a single-answer
  // poll whose options the proposal form pre-fills with Approve, Neutral, and
  // Oppose.
  const pollType = getPollTypeCode(body.pollType);
  if (pollType === null) {
    return { ok: false, code: 'PROPOSAL_TYPE_INVALID', params: {}, message: errorMessage('PROPOSAL_TYPE_INVALID') };
  }

  if (!isPollDuration(body.duration)) {
    const params = { options: POLL_DURATIONS.join(', ') };
    return { ok: false, code: 'DURATION_INVALID', params, message: errorMessage('DURATION_INVALID', params) };
  }

  // A poll needs 2 to 7 custom options, each 1 to 80 characters after trimming
  // and all distinct. A plain string array is accepted as well as
  // `{ position, label }` entries, so the client can submit the rows in order.
  const optionValidation = validatePollOptions(body.options);
  if (!optionValidation.ok) {
    return { ok: false, code: optionValidation.code, params: optionValidation.params, message: optionValidation.message };
  }
  const options = optionValidation.options;

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