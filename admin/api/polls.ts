import { PollMode, PollStatus, VoteOption } from '../../worker/enums';
import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import { POLL_STATUS_VALUES, parsePollStatus, pollModeLabel, pollStatusLabel, type AdminPollStatus } from '../lib/enums';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;

interface AdminPollRow {
  id: number;
  title: string | null;
  description: string | null;
  mode: number;
  start_at: number | null;
  end_at: number | null;
  status: number;
  approve: number;
  neutral: number;
  oppose: number;
  created_at: number;
  updated_at: number;
}

export async function handlePollsRequest(request: Request, url: URL, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const statusMatch = url.pathname.match(/^\/api\/admin\/polls\/(\d+)\/status$/);
  if (statusMatch) {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updatePollStatus(Number(statusMatch[1]), request, env, actor);
  }

  if (url.pathname !== '/api/admin/polls') {
    return Response.json({ message: 'not found' }, { status: 404 });
  }
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }
  return listPolls(url, env);
}

async function listPolls(url: URL, env: AdminEnv): Promise<Response> {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return Response.json({ message: 'invalid pagination parameters' }, { status: 400 });
  }

  const statusParam = (url.searchParams.get('status') ?? 'all').toLowerCase();
  let statusFilter: AdminPollStatus | 'all';
  if (statusParam === 'all') {
    statusFilter = 'all';
  } else {
    const parsed = parsePollStatus(statusParam);
    if (!parsed) {
      return Response.json({ message: 'invalid status filter' }, { status: 400 });
    }
    statusFilter = parsed;
  }

  const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const likePattern = query ? `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : '';
  const searchClause = query ? " AND i.title LIKE ? ESCAPE '\\'" : '';
  const statusClause = statusFilter === 'all' ? '' : ' AND i.status = ?';
  const statusBind = statusFilter === 'all' ? [] : [POLL_STATUS_VALUES[statusFilter]];

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM polls i WHERE 1 = 1${statusClause}${searchClause}`
  ).bind(...statusBind, ...(query ? [likePattern] : [])).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `SELECT i.id, i.title, i.description, i.mode, i.start_at, i.end_at, i.status,
            i.created_at, i.updated_at,
            COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS approve,
            COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS neutral,
            COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS oppose
     FROM polls i
     LEFT JOIN votes v ON v.poll_id = i.id
     WHERE 1 = 1${statusClause}${searchClause}
     GROUP BY i.id
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ? OFFSET ?`
  ).bind(
    VoteOption.Approve, VoteOption.Neutral, VoteOption.Oppose,
    ...statusBind, ...(query ? [likePattern] : []),
    pageSize, offset
  ).all<AdminPollRow>();

  return Response.json({
    polls: (result.results ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      mode: pollModeLabel(row.mode),
      status: pollStatusLabel(row.status),
      startAt: toIso(row.start_at),
      endAt: toIso(row.end_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      counts: {
        approve: Number(row.approve),
        neutral: Number(row.neutral),
        oppose: Number(row.oppose)
      }
    })),
    page: currentPage,
    pageSize,
    total,
    totalPages,
    status: statusFilter,
    query
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function updatePollStatus(pollId: number, request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  if (!Number.isSafeInteger(pollId) || pollId < 1) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  const requested = typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).status ?? '').toLowerCase()
    : '';
  const nextStatus = parsePollStatus(requested);
  if (!nextStatus) {
    return Response.json({ message: 'status must be one of open, closed, archived, pending' }, { status: 400 });
  }

  const poll = await env.DB.prepare(
    'SELECT id, title, mode, status FROM polls WHERE id = ?'
  ).bind(pollId).first<{ id: number; title: string | null; mode: number; status: number }>();

  if (!poll) {
    return Response.json({ message: `poll ${pollId} was not found` }, { status: 404 });
  }
  if (nextStatus === 'open') {
    if (!poll.title?.trim()) {
      return Response.json({ message: `poll ${pollId} has no title and cannot be published` }, { status: 422 });
    }
    if (poll.mode !== PollMode.Deadline && poll.mode !== PollMode.Evergreen) {
      return Response.json({ message: `poll ${pollId} has an unsupported mode` }, { status: 422 });
    }
  }

  const update = await env.DB.prepare(
    `UPDATE polls
     SET status = ?, updated_at = unixepoch(),
         reviewed_at = CASE WHEN ? = ? THEN unixepoch() ELSE reviewed_at END
     WHERE id = ?`
  ).bind(POLL_STATUS_VALUES[nextStatus], POLL_STATUS_VALUES[nextStatus], PollStatus.Open, pollId).run();

  if (update.meta.changes !== 1) {
    return Response.json({ message: `poll ${pollId} could not be updated` }, { status: 409 });
  }

  await logAudit(env, {
    actor, action: 'poll.status', targetType: 'poll', targetId: pollId,
    details: { status: nextStatus, previousStatus: pollStatusLabel(poll.status) }
  });

  return Response.json({
    ok: true,
    pollId,
    status: nextStatus,
    message: `Poll ${pollId} status set to ${nextStatus}.`
  });
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}
