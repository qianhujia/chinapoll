// Poll report moderation endpoints.
//
// Reports carry no reporter data, so the admin view lists one row per poll with
// aggregate counts, a reason breakdown, and the newest free-text notes. Polls
// with an open high-priority report (personal information, harassment, illegal
// content) sort first.

import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import { noStoreJson } from '../../shared/http';
import {
  getPollReportReasonLabel,
  getReportResolutionCode,
  PollReportReason,
  PRIORITY_REPORT_REASONS
} from '../lib/enums';

const MAX_PAGE_SIZE = 100;
const MAX_NOTES_PER_POLL = 5;
const PRIORITY_REASON_LIST = PRIORITY_REPORT_REASONS.join(', ');
const REPORT_REASON_CODES: PollReportReason[] = [
  PollReportReason.Spam,
  PollReportReason.Inappropriate,
  PollReportReason.Misleading,
  PollReportReason.Copyright,
  PollReportReason.PersonalInfo,
  PollReportReason.Harassment,
  PollReportReason.Illegal,
  PollReportReason.Other
];

type ReportStatusFilter = 'open' | 'resolved' | 'all';

interface ReportPollRow {
  poll_id: number;
  poll_title: string | null;
  total_count: number;
  open_count: number;
  priority_count: number;
}

interface ReportCommentRow {
  comment_id: number;
  public_id: string;
  comment: string;
  poll_id: number;
  poll_title: string | null;
  total_count: number;
  open_count: number;
  priority_count: number;
}

// The two report tables share one shape, so the breakdown and note loaders take the
// table and its target column rather than being written twice.
type ReportTable = 'poll_reports' | 'comment_reports';
type ReportTargetColumn = 'poll_id' | 'comment_id';

export async function handleReportsRequest(
  request: Request,
  url: URL,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  const resolveMatch = url.pathname.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
  if (resolveMatch) {
    if (request.method !== 'POST') return noStoreJson({ message: 'method not allowed' }, 405);
    const pollId = Number(resolveMatch[1]);
    if (!Number.isSafeInteger(pollId) || pollId < 1) {
      return noStoreJson({ message: 'invalid poll ID' }, 400);
    }
    return resolveReports(pollId, request, env, actor);
  }

  const commentResolveMatch = url.pathname.match(/^\/api\/admin\/comment-reports\/(\d+)\/resolve$/);
  if (commentResolveMatch) {
    if (request.method !== 'POST') return noStoreJson({ message: 'method not allowed' }, 405);
    const commentId = Number(commentResolveMatch[1]);
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      return noStoreJson({ message: 'invalid comment ID' }, 400);
    }
    return resolveCommentReports(commentId, request, env, actor);
  }

  if (url.pathname !== '/api/admin/reports') {
    return noStoreJson({ message: 'not found' }, 404);
  }
  if (request.method !== 'GET') return noStoreJson({ message: 'method not allowed' }, 405);
  return listReports(url, env);
}

function parseStatus(value: string | null): ReportStatusFilter | null {
  if (value === null || value === '' || value === 'open') return 'open';
  if (value === 'resolved') return 'resolved';
  if (value === 'all') return 'all';
  return null;
}

async function listReports(url: URL, env: AdminEnv): Promise<Response> {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return noStoreJson({ message: 'invalid pagination parameters' }, 400);
  }

  const status = parseStatus(url.searchParams.get('status'));
  if (status === null) {
    return noStoreJson({ message: 'invalid status filter' }, 400);
  }
  const statusClause = status === 'open'
    ? 'WHERE a.open_count > 0'
    : status === 'resolved'
      ? 'WHERE a.open_count = 0'
      : '';

  const aggregate = `WITH agg AS (
       SELECT poll_id,
              COUNT(*) AS total_count,
              SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN resolved_at IS NULL AND reason IN (${PRIORITY_REASON_LIST}) THEN 1 ELSE 0 END) AS priority_count
       FROM poll_reports GROUP BY poll_id
     )`;

  const countResult = await env.DB.prepare(
    `${aggregate} SELECT COUNT(*) AS total FROM agg a ${statusClause}`
  ).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  // Priority polls first, then by open count, so the urgent rows lead the list.
  const result = await env.DB.prepare(
    `${aggregate}
     SELECT a.poll_id, p.title AS poll_title, a.total_count, a.open_count, a.priority_count
     FROM agg a
     LEFT JOIN polls p ON p.id = a.poll_id
     ${statusClause}
     ORDER BY (a.priority_count > 0) DESC, a.open_count DESC, a.poll_id DESC
     LIMIT ? OFFSET ?`
  ).bind(pageSize, offset).all<ReportPollRow>();

  const rows = result.results ?? [];
  const pollIds = rows.map((row) => Number(row.poll_id));
  const [reasonsByPoll, notesByPoll] = await Promise.all([
    loadReasonBreakdown(env, 'poll_reports', 'poll_id', pollIds),
    loadNewestNotes(env, 'poll_reports', 'poll_id', pollIds)
  ]);

  // Comment reports are paginated separately: the poll table and the comment table are
  // independent lists that happen to share one page.
  const commentPage = Number(url.searchParams.get('commentsPage') ?? '1');
  if (!Number.isSafeInteger(commentPage) || commentPage < 1) {
    return noStoreJson({ message: 'invalid pagination parameters' }, 400);
  }
  const commentAggregate = `WITH agg AS (
       SELECT comment_id,
              COUNT(*) AS total_count,
              SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN resolved_at IS NULL AND reason IN (${PRIORITY_REASON_LIST}) THEN 1 ELSE 0 END) AS priority_count
       FROM comment_reports GROUP BY comment_id
     )`;

  const commentCountResult = await env.DB.prepare(
    `${commentAggregate} SELECT COUNT(*) AS total FROM agg a ${statusClause}`
  ).first<{ total: number }>();

  const commentTotal = Number(commentCountResult?.total ?? 0);
  const commentTotalPages = Math.max(1, Math.ceil(commentTotal / pageSize));
  const currentCommentPage = Math.min(commentPage, commentTotalPages);
  const commentOffset = (currentCommentPage - 1) * pageSize;

  const commentResult = await env.DB.prepare(
    `${commentAggregate}
     SELECT a.comment_id, c.public_id, c.comment, c.poll_id, p.title AS poll_title,
            a.total_count, a.open_count, a.priority_count
     FROM agg a
     JOIN comments c ON c.id = a.comment_id
     LEFT JOIN polls p ON p.id = c.poll_id
     ${statusClause}
     ORDER BY (a.priority_count > 0) DESC, a.open_count DESC, a.comment_id DESC
     LIMIT ? OFFSET ?`
  ).bind(pageSize, commentOffset).all<ReportCommentRow>();

  const commentRows = commentResult.results ?? [];
  const commentIds = commentRows.map((row) => Number(row.comment_id));
  const [reasonsByComment, notesByComment] = await Promise.all([
    loadReasonBreakdown(env, 'comment_reports', 'comment_id', commentIds),
    loadNewestNotes(env, 'comment_reports', 'comment_id', commentIds)
  ]);

  return noStoreJson({
    reports: rows.map((row) => {
      const pollId = Number(row.poll_id);
      return {
        pollId,
        pollTitle: row.poll_title,
        openCount: Number(row.open_count),
        totalCount: Number(row.total_count),
        priority: Number(row.priority_count) > 0,
        reasons: reasonsByPoll.get(pollId) ?? emptyBreakdown(),
        notes: notesByPoll.get(pollId) ?? []
      };
    }),
    page: currentPage,
    pageSize,
    total,
    totalPages,
    // A reported comment is shown with its text and its poll, so an admin can judge it
    // without opening the poll page.
    commentReports: commentRows.map((row) => {
      const commentId = Number(row.comment_id);
      return {
        commentId,
        publicId: row.public_id,
        comment: row.comment,
        pollId: Number(row.poll_id),
        pollTitle: row.poll_title,
        openCount: Number(row.open_count),
        totalCount: Number(row.total_count),
        priority: Number(row.priority_count) > 0,
        reasons: reasonsByComment.get(commentId) ?? emptyBreakdown(),
        notes: notesByComment.get(commentId) ?? []
      };
    }),
    commentPage: currentCommentPage,
    commentTotal,
    commentTotalPages,
    status
  });
}

// Builds the eight-label breakdown for each target, sorted by count then code.
async function loadReasonBreakdown(
  env: AdminEnv,
  table: ReportTable,
  column: ReportTargetColumn,
  ids: number[]
): Promise<Map<number, Array<{ reason: string; count: number }>>> {
  const breakdowns = new Map<number, Array<{ reason: string; count: number }>>();
  if (ids.length === 0) return breakdowns;

  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT ${column} AS target_id, reason, COUNT(*) AS count FROM ${table}
     WHERE ${column} IN (${placeholders}) GROUP BY ${column}, reason`
  ).bind(...ids).all<{ target_id: number; reason: number; count: number }>();

  const counts = new Map<number, Map<number, number>>();
  for (const row of result.results ?? []) {
    const targetId = Number(row.target_id);
    const byReason = counts.get(targetId) ?? new Map<number, number>();
    byReason.set(Number(row.reason), Number(row.count));
    counts.set(targetId, byReason);
  }

  for (const id of ids) {
    const byReason = counts.get(id);
    // The map starts in code order, and Array.prototype.sort is stable, so ties
    // keep the canonical reason order.
    const breakdown = REPORT_REASON_CODES.map((code) => ({
      reason: getPollReportReasonLabel(code),
      count: byReason?.get(code) ?? 0
    }));
    breakdown.sort((a, b) => b.count - a.count);
    breakdowns.set(id, breakdown);
  }
  return breakdowns;
}

function emptyBreakdown(): Array<{ reason: string; count: number }> {
  return REPORT_REASON_CODES.map((code) => ({ reason: getPollReportReasonLabel(code), count: 0 }));
}

// Returns up to MAX_NOTES_PER_POLL newest free-text notes for each target.
async function loadNewestNotes(
  env: AdminEnv,
  table: ReportTable,
  column: ReportTargetColumn,
  ids: number[]
): Promise<Map<number, string[]>> {
  const notes = new Map<number, string[]>();
  if (ids.length === 0) return notes;

  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT target_id, note FROM (
       SELECT ${column} AS target_id, note,
              ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY created_at DESC, id DESC) AS rn
       FROM ${table}
       WHERE ${column} IN (${placeholders}) AND reason = ? AND note IS NOT NULL AND note <> ''
     ) WHERE rn <= ?`
  ).bind(...ids, PollReportReason.Other, MAX_NOTES_PER_POLL).all<{ target_id: number; note: string }>();

  for (const row of result.results ?? []) {
    const targetId = Number(row.target_id);
    const list = notes.get(targetId) ?? [];
    list.push(row.note);
    notes.set(targetId, list);
  }
  return notes;
}

async function resolveReports(
  pollId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ message: 'invalid JSON' }, 400);
  }

  const requested = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).resolution ?? '')
    : '';
  const resolution = getReportResolutionCode(requested);
  if (resolution === null) {
    return noStoreJson({ message: 'resolution must be one of dismissed, action_taken' }, 400);
  }

  const poll = await env.DB.prepare('SELECT id FROM polls WHERE id = ?')
    .bind(pollId).first<{ id: number }>();
  if (!poll) {
    return noStoreJson({ message: `poll ${pollId} was not found` }, 404);
  }

  // Resolved timestamps are coarsened to the hour like report creation times.
  const now = Math.floor(Date.now() / 1000);
  const coarseNow = now - (now % 3600);
  const update = await env.DB.prepare(
    'UPDATE poll_reports SET resolved_at = ?, resolution = ? WHERE poll_id = ? AND resolved_at IS NULL'
  ).bind(coarseNow, resolution, pollId).run();

  const resolved = Number(update.meta.changes ?? 0);
  if (resolved === 0) {
    return noStoreJson({ message: `poll ${pollId} has no open reports` }, 409);
  }

  // Resolving reports does not change the poll status; an admin uses the poll
  // status endpoint for that.
  await logAudit(env, {
    actor,
    action: 'report.resolved',
    targetType: 'poll',
    targetId: pollId,
    details: { resolution: requested, resolved }
  });

  return noStoreJson({
    ok: true,
    pollId,
    resolution: requested,
    resolved,
    message: `Resolved ${resolved} report(s) for poll ${pollId}.`
  });
}

// Resolves every open report on one comment. Deleting the comment is the remedy, so
// this only clears the queue; the admin uses the Comments tab for the delete.
async function resolveCommentReports(
  commentId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStoreJson({ message: 'invalid JSON' }, 400);
  }

  const requested = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).resolution ?? '')
    : '';
  const resolution = getReportResolutionCode(requested);
  if (resolution === null) {
    return noStoreJson({ message: 'resolution must be one of dismissed, action_taken' }, 400);
  }

  const comment = await env.DB.prepare('SELECT id FROM comments WHERE id = ?')
    .bind(commentId).first<{ id: number }>();
  if (!comment) {
    return noStoreJson({ message: `comment ${commentId} was not found` }, 404);
  }

  // Resolved timestamps are coarsened to the hour like report creation times.
  const now = Math.floor(Date.now() / 1000);
  const coarseNow = now - (now % 3600);
  const update = await env.DB.prepare(
    'UPDATE comment_reports SET resolved_at = ?, resolution = ? WHERE comment_id = ? AND resolved_at IS NULL'
  ).bind(coarseNow, resolution, commentId).run();

  const resolved = Number(update.meta.changes ?? 0);
  if (resolved === 0) {
    return noStoreJson({ message: `comment ${commentId} has no open reports` }, 409);
  }

  await logAudit(env, {
    actor,
    action: 'comment_report.resolved',
    targetType: 'comment',
    targetId: commentId,
    details: { resolution: requested, resolved }
  });

  return noStoreJson({
    ok: true,
    commentId,
    resolution: requested,
    resolved,
    message: `Resolved ${resolved} report(s) for comment ${commentId}.`
  });
}
