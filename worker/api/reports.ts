// Poll and comment reporting.
//
// Reporting does not require an account. A report stores no reporter identifier:
// there is no address, no network bucket, no user id, and `created_at` is
// coarsened to the hour like votes and comments, so a report cannot be tied back
// to a person or correlated with edge logs. Rate limiting uses the keyed,
// daily-rotated network hash through the RateLimiter Durable Object, so no
// IP-derived value is written to D1.
//
// A poll report auto-hides the poll once a threshold is reached (see
// `applyAutoHide`). A comment report is reviewed by hand instead: the same threshold
// would be cheap to abuse from one network on a single comment, and an admin already
// has a direct delete for it.

import type { HandlerEnv } from '../index';
import { logAudit } from '../../admin/lib/audit';
import { enforceSameOrigin } from '../services/csrf';
import { checkRateLimit } from '../services/rateLimit';
import { clientAddress, hashedNetworkBucket, serverHmacKey } from '../services/ip';
import { isTurnstileEnabled, turnstileSecretKey, verifyTurnstile } from '../services/turnstile';
import {
  getPollReportReasonCode,
  PollReportReason,
  PollStatus,
  PRIORITY_REPORT_REASONS
} from '../enums';
import { apiError } from '../../shared/http';

const DEFAULT_REPORT_RATE_LIMIT = '3/d';
const DEFAULT_AUTO_HIDE_THRESHOLD = 5;
const DEFAULT_AUTO_HIDE_PRIORITY_THRESHOLD = 2;
const MAX_NOTE_LENGTH = 300;
const POLL_REPORT_PATH_PATTERN = /^\/api\/polls\/([1-9]\d*)\/report$/;
// A comment is reported through its public id, the same random identifier the public
// comment API returns.
const COMMENT_REPORT_PATH_PATTERN = /^\/api\/comments\/([0-9a-f]{16})\/report$/i;
// Reason codes that count toward the priority auto-hide threshold (5, 6, 7).
const PRIORITY_REASON_LIST = PRIORITY_REPORT_REASONS.join(', ');

export async function handleReportRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('POST_ONLY', 405, { extra: { ok: false } });
  }

  // Reporting needs no account either, so the Origin check comes first: a
  // third-party page must not be able to file reports from its visitors'
  // browsers, which would spend each visitor's report budget and could push a
  // poll over the auto-hide threshold.
  const csrf = enforceSameOrigin(request);
  if (csrf) return csrf;

  const pollMatch = url.pathname.match(POLL_REPORT_PATH_PATTERN);
  const commentMatch = pollMatch ? null : url.pathname.match(COMMENT_REPORT_PATH_PATTERN);
  if (!pollMatch && !commentMatch) {
    return apiError('RESOURCE_NOT_FOUND', 404, { extra: { ok: false } });
  }
  const pollId = pollMatch ? Number(pollMatch[1]) : 0;
  const commentPublicId = commentMatch ? commentMatch[1].toLowerCase() : '';
  if (pollMatch && !Number.isSafeInteger(pollId)) {
    return apiError('INVALID_POLL_ID', 400, { extra: { ok: false } });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return apiError('INVALID_JSON', 400, { extra: { ok: false } });
  }

  const reason = getPollReportReasonCode(body.reason);
  if (reason === null) {
    return apiError('INVALID_REPORT_REASON', 400, { extra: { ok: false } });
  }

  const noteValue = body.note;
  if (noteValue !== undefined && noteValue !== null && typeof noteValue !== 'string') {
    return apiError('INVALID_NOTE', 400, { extra: { ok: false } });
  }
  const note = typeof noteValue === 'string' ? noteValue.trim() : '';
  if (reason !== PollReportReason.Other && note.length > 0) {
    return apiError('NOTE_NOT_ALLOWED', 400, { extra: { ok: false } });
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return apiError('NOTE_TOO_LONG', 400, { params: { max: MAX_NOTE_LENGTH }, extra: { ok: false } });
  }

  // Turnstile is enforced only when both keys are configured.
  const turnstileResponse = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (isTurnstileEnabled(env)) {
    if (!turnstileResponse || !await verifyTurnstile(turnstileSecretKey(env), turnstileResponse, new URL(request.url).hostname)) {
      return apiError('TURNSTILE_FAILED', 403, { extra: { ok: false } });
    }
  }

  // A report targets content that is visible to the public: a poll that is open or
  // closed, or a comment on such a poll. A comment that does not exist, or that sits
  // on a poll the public cannot see, answers like a missing reportable target, so the
  // endpoint never reveals which polls and comments exist.
  let commentId = 0;
  if (pollMatch) {
    const poll = await env.DB.prepare(
      'SELECT status FROM polls WHERE id = ?'
    ).bind(pollId).first<{ status: number }>();
    if (!poll || (poll.status !== PollStatus.Open && poll.status !== PollStatus.Closed)) {
      return apiError('POLL_NOT_FOUND', 404, { extra: { ok: false } });
    }
  } else {
    const comment = await env.DB.prepare(
      `SELECT c.id, p.status FROM comments c
       JOIN polls p ON p.id = c.poll_id
       WHERE c.public_id = ?`
    ).bind(commentPublicId).first<{ id: number; status: number }>();
    if (!comment || (comment.status !== PollStatus.Open && comment.status !== PollStatus.Closed)) {
      return apiError('COMMENT_NOT_FOUND', 404, { extra: { ok: false } });
    }
    commentId = Number(comment.id);
  }

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env));
  if (!ipHash) {
    return apiError('SERVER_NOT_CONFIGURED', 503, { extra: { ok: false } });
  }

  const limited = await checkRateLimit(env, 'report', ipHash, env.report_rate_limit, DEFAULT_REPORT_RATE_LIMIT);
  if (!limited.allowed) {
    return apiError('REPORT_RATE_LIMIT', 429, { extra: { ok: false } });
  }

  // Coarsen the timestamp to the hour so a report cannot be correlated with a
  // session or edge-log timestamp. The note is stored only for "other".
  const nowSeconds = Math.floor(Date.now() / 1000);
  const coarseNow = nowSeconds - (nowSeconds % 3600);
  const storedNote = reason === PollReportReason.Other && note.length > 0 ? note : null;
  if (pollMatch) {
    await env.DB.prepare(
      'INSERT INTO poll_reports (poll_id, reason, note, created_at) VALUES (?, ?, ?, ?)'
    ).bind(pollId, reason, storedNote, coarseNow).run();

    await applyAutoHide(env, pollId);
  } else {
    await env.DB.prepare(
      'INSERT INTO comment_reports (comment_id, reason, note, created_at) VALUES (?, ?, ?, ?)'
    ).bind(commentId, reason, storedNote, coarseNow).run();
  }

  // The report id is deliberately not returned.
  return Response.json({ ok: true }, { status: 201 });
}

// Counts the open reports for a poll and hides the poll for review when either
// auto-hide threshold is reached. Setting a threshold to 0 disables that rule.
async function applyAutoHide(env: HandlerEnv, pollId: number): Promise<void> {
  const totalThreshold = Number(env.report_auto_hide_threshold ?? DEFAULT_AUTO_HIDE_THRESHOLD);
  const priorityThreshold = Number(env.report_auto_hide_priority_threshold ?? DEFAULT_AUTO_HIDE_PRIORITY_THRESHOLD);
  if (totalThreshold <= 0 && priorityThreshold <= 0) return;

  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN reason IN (${PRIORITY_REASON_LIST}) THEN 1 ELSE 0 END), 0) AS priority
     FROM poll_reports WHERE poll_id = ? AND resolved_at IS NULL`
  ).bind(pollId).first<{ total: number; priority: number }>();

  const total = Number(counts?.total ?? 0);
  const priority = Number(counts?.priority ?? 0);
  const hide = (totalThreshold > 0 && total >= totalThreshold)
    || (priorityThreshold > 0 && priority >= priorityThreshold);
  if (!hide) return;

  // Move the poll out of public listings until an admin reviews it.
  await env.DB.prepare(
    'UPDATE polls SET status = ?, reviewed_at = NULL, updated_at = unixepoch() WHERE id = ?'
  ).bind(PollStatus.Pending, pollId).run();

  await logAudit(env, {
    actor: null,
    action: 'poll.auto_hidden',
    targetType: 'poll',
    targetId: pollId,
    details: {
      openReports: total,
      priorityReports: priority,
      reportAutoHideThreshold: totalThreshold,
      reportAutoHidePriorityThreshold: priorityThreshold
    }
  });
}
