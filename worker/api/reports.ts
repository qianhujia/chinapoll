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
import { verifyTurnstile } from '../services/turnstile';
import {
  getPollReportReasonCode,
  PollReportReason,
  PollStatus,
  PRIORITY_REPORT_REASONS
} from '../enums';

const DEFAULT_REPORT_RATE_LIMIT = '3/d';
const DEFAULT_AUTO_HIDE_THRESHOLD = 5;
const DEFAULT_AUTO_HIDE_PRIORITY_THRESHOLD = 2;
const MAX_NOTE_LENGTH = 300;
const REPORT_PATH_PATTERN = /^\/api\/polls\/([1-9]\d*)\/report$/;
// Reason codes that count toward the priority auto-hide threshold (5, 6, 7).
const PRIORITY_REASON_LIST = PRIORITY_REPORT_REASONS.join(', ');

export async function handleReportRequest(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'POST only' }, { status: 405 });
  }

  const match = url.pathname.match(REPORT_PATH_PATTERN);
  if (!match) {
    return Response.json({ ok: false, message: 'not found' }, { status: 404 });
  }
  const pollId = Number(match[1]);
  if (!Number.isSafeInteger(pollId)) {
    return Response.json({ ok: false, message: 'invalid poll ID' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, message: 'invalid JSON' }, { status: 400 });
  }

  const reason = getPollReportReasonCode(body.reason);
  if (reason === null) {
    return Response.json({ ok: false, message: 'invalid report reason' }, { status: 400 });
  }

  const noteValue = body.note;
  if (noteValue !== undefined && noteValue !== null && typeof noteValue !== 'string') {
    return Response.json({ ok: false, message: 'invalid note' }, { status: 400 });
  }
  const note = typeof noteValue === 'string' ? noteValue.trim() : '';
  if (reason !== PollReportReason.Other && note.length > 0) {
    return Response.json({ ok: false, message: 'a note is only allowed with reason "other"' }, { status: 400 });
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return Response.json({ ok: false, message: `a note must be at most ${MAX_NOTE_LENGTH} characters` }, { status: 400 });
  }

  // Turnstile is enforced only when it is enabled and fully configured.
  const turnstileResponse = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (env.turnstile_enable && env.turnstile_secret_key) {
    if (!turnstileResponse || !await verifyTurnstile(env.turnstile_secret_key, turnstileResponse)) {
      return Response.json({ ok: false, message: 'turnstile verification failed' }, { status: 403 });
    }
  }

  // A report targets a poll that is visible to the public: open or closed.
  const poll = await env.DB.prepare(
    'SELECT status FROM polls WHERE id = ?'
  ).bind(pollId).first<{ status: number }>();
  if (!poll || (poll.status !== PollStatus.Open && poll.status !== PollStatus.Closed)) {
    return Response.json({ ok: false, message: 'poll not found' }, { status: 404 });
  }

  const ipHash = await hashedNetworkBucket(clientAddress(request), serverHmacKey(env));
  if (!ipHash) {
    return Response.json({ ok: false, message: 'server key is not configured' }, { status: 503 });
  }

  const limited = await checkRateLimit(env, 'report', ipHash, env.report_rate_limit, DEFAULT_REPORT_RATE_LIMIT);
  if (!limited.allowed) {
    return Response.json({ ok: false, message: 'report rate limit reached' }, { status: 429 });
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
