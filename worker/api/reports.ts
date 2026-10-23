// Poll reporting.
//
// Reporting does not require an account. A report stores no reporter identifier:
// there is no address, no network bucket, no user id, and `created_at` is
// coarsened to the hour like votes and comments, so a report cannot be tied back
// to a person or correlated with edge logs. Rate limiting uses the keyed,
// daily-rotated network hash through the RateLimiter Durable Object, so no
// IP-derived value is written to D1.

import type { HandlerEnv } from '../index';
import { logAudit } from '../../admin/lib/audit';
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
const REPORT_PATH_PATTERN = /^\/api\/polls\/([1-9]\d*)\/report$/;
// Reason codes that count toward the priority auto-hide threshold (5, 6, 7).
const PRIORITY_REASON_LIST = PRIORITY_REPORT_REASONS.join(', ');

export async function handleReportRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('POST_ONLY', 405, { extra: { ok: false } });
  }

  const match = url.pathname.match(REPORT_PATH_PATTERN);
  if (!match) {
    return apiError('RESOURCE_NOT_FOUND', 404, { extra: { ok: false } });
  }
  const pollId = Number(match[1]);
  if (!Number.isSafeInteger(pollId)) {
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

  // A report targets a poll that is visible to the public: open or closed.
  const poll = await env.DB.prepare(
    'SELECT status FROM polls WHERE id = ?'
  ).bind(pollId).first<{ status: number }>();
  if (!poll || (poll.status !== PollStatus.Open && poll.status !== PollStatus.Closed)) {
    return apiError('POLL_NOT_FOUND', 404, { extra: { ok: false } });
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
  await env.DB.prepare(
    'INSERT INTO poll_reports (poll_id, reason, note, created_at) VALUES (?, ?, ?, ?)'
  ).bind(pollId, reason, reason === PollReportReason.Other && note.length > 0 ? note : null, coarseNow).run();

  await applyAutoHide(env, pollId);

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
