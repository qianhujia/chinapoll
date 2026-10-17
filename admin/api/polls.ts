import { PollMode, PollStatus, PollType, VoteOption } from '../../worker/enums';
import { currentHour, writeSnapshotForPoll } from '../../worker/services/maintenance';
import { validatePollOptions } from '../../worker/services/pollType';
import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import {
  POLL_STATUS_VALUES,
  pollStatusLabel,
  pollTypeLabel,
  parsePollStatus,
  type AdminPollStatus
} from '../lib/enums';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;

interface AdminPollRow {
  id: number;
  title: string | null;
  description: string | null;
  mode: number;
  poll_type: number;
  duration_seconds: number | null;
  start_at: number | null;
  end_at: number | null;
  status: number;
  approve: number;
  neutral: number;
  oppose: number;
  views: number;
  created_at: number;
  updated_at: number;
}

interface AdminOptionCount {
  id: number;
  label: string;
  position: number;
  count: number;
}

export async function handlePollsRequest(request: Request, url: URL, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const statusMatch = url.pathname.match(/^\/api\/admin\/polls\/(\d+)\/status$/);
  if (statusMatch) {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updatePollStatus(Number(statusMatch[1]), request, env, actor);
  }

  // Option labels may only be corrected while a poll is still pending.
  const optionsMatch = url.pathname.match(/^\/api\/admin\/polls\/(\d+)\/options$/);
  if (optionsMatch) {
    if (request.method !== 'PUT') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updatePollOptions(Number(optionsMatch[1]), request, env, actor);
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
    `WITH page AS (
       SELECT id FROM polls i
       WHERE 1 = 1${statusClause}${searchClause}
       ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?
     )
     SELECT i.id, i.title, i.description, i.mode, i.poll_type, i.duration_seconds,
            i.start_at, i.end_at, i.status,
            i.created_at, i.updated_at,
            COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS approve,
            COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS neutral,
            COALESCE(SUM(CASE WHEN v.option = ? THEN 1 ELSE 0 END), 0) AS oppose,
            (SELECT COALESCE(SUM(pv.views), 0) FROM poll_views pv WHERE pv.poll_id = i.id) AS views
     FROM page
     JOIN polls i ON i.id = page.id
     LEFT JOIN votes v ON v.poll_id = i.id
     GROUP BY i.id
     ORDER BY i.created_at DESC, i.id DESC`
  ).bind(
    ...statusBind, ...(query ? [likePattern] : []),
    pageSize, offset,
    VoteOption.Approve, VoteOption.Neutral, VoteOption.Oppose
  ).all<AdminPollRow>();

  // The option counts of every choice poll on this page are read with one
  // aggregate query over `vote_selections` (paginate, then aggregate).
  const optionCounts = await loadAdminOptionCounts(env, (result.results ?? [])
    .filter((row) => Number(row.poll_type) !== PollType.Verdict)
    .map((row) => Number(row.id)));

  return Response.json({
    polls: (result.results ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      mode: row.mode === PollMode.Evergreen ? 'evergreen' : 'deadline',
      pollType: pollTypeLabel(Number(row.poll_type)),
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      status: pollStatusLabel(row.status),
      startAt: toIso(row.start_at),
      endAt: toIso(row.end_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      views: Number(row.views),
      counts: {
        approve: Number(row.approve),
        neutral: Number(row.neutral),
        oppose: Number(row.oppose)
      },
      options: optionCounts.get(Number(row.id)) ?? []
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

// Reads the options of several choice polls with one aggregate query.
async function loadAdminOptionCounts(
  env: AdminEnv,
  pollIds: number[]
): Promise<Map<number, AdminOptionCount[]>> {
  const counts = new Map<number, AdminOptionCount[]>();
  if (pollIds.length === 0) return counts;

  const placeholders = pollIds.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT o.poll_id, o.id, o.label, o.position, COUNT(vs.vote_id) AS count
     FROM poll_options o
     LEFT JOIN vote_selections vs ON vs.option_id = o.id
     WHERE o.poll_id IN (${placeholders})
     GROUP BY o.id
     ORDER BY o.poll_id ASC, o.position ASC`
  ).bind(...pollIds).all<{ poll_id: number } & AdminOptionCount>();

  for (const row of result.results ?? []) {
    const pollId = Number(row.poll_id);
    const entry = counts.get(pollId) ?? [];
    entry.push({
      id: Number(row.id),
      label: row.label,
      position: Number(row.position),
      count: Number(row.count)
    });
    counts.set(pollId, entry);
  }
  return counts;
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
    'SELECT id, title, mode, status, start_at, end_at, duration_seconds, poll_type FROM polls WHERE id = ?'
  ).bind(pollId).first<{
    id: number;
    title: string | null;
    mode: number;
    status: number;
    start_at: number | null;
    end_at: number | null;
    duration_seconds: number | null;
    poll_type: number;
  }>();

  if (!poll) {
    return Response.json({ message: `poll ${pollId} was not found` }, { status: 404 });
  }

  const storedStatus = POLL_STATUS_VALUES[nextStatus];
  if (nextStatus === 'open') {
    if (!poll.title?.trim()) {
      return Response.json({ message: `poll ${pollId} has no title and cannot be published` }, { status: 422 });
    }
    if (poll.mode !== PollMode.Deadline && poll.mode !== PollMode.Evergreen) {
      return Response.json({ message: `poll ${pollId} has an unsupported mode` }, { status: 422 });
    }
    // A choice poll without options cannot be voted on.
    if (Number(poll.poll_type) !== PollType.Verdict) {
      const optionCount = await env.DB.prepare(
        'SELECT COUNT(*) AS total FROM poll_options WHERE poll_id = ?'
      ).bind(pollId).first<{ total: number }>();
      if (Number(optionCount?.total ?? 0) === 0) {
        return Response.json({ message: `poll ${pollId} has no options and cannot be published` }, { status: 422 });
      }
    }
  }

  const update = await env.DB.prepare(
    `UPDATE polls
     SET status = ?, updated_at = unixepoch(),
         reviewed_at = CASE WHEN ? = 1 THEN unixepoch() ELSE reviewed_at END
     WHERE id = ?`
  ).bind(storedStatus, nextStatus === 'open' ? 1 : 0, pollId).run();

  if (update.meta.changes !== 1) {
    return Response.json({ message: `poll ${pollId} could not be updated` }, { status: 409 });
  }

  // The end date is computed when the poll opens: `duration_seconds` after that
  // moment, unless the poll already has one.
  if (nextStatus === 'open') {
    await env.DB.prepare(
      `UPDATE polls SET end_at = unixepoch() + duration_seconds
       WHERE id = ? AND mode = ? AND duration_seconds IS NOT NULL AND end_at IS NULL`
    ).bind(pollId, PollMode.Deadline).run();
  }

  // Stamp closed_at when a poll closes so retention does not depend on
  // updated_at, and clear it when a poll is reopened.
  if (nextStatus === 'closed') {
    await env.DB.prepare('UPDATE polls SET closed_at = COALESCE(closed_at, unixepoch()) WHERE id = ?').bind(pollId).run();
    // Capture the terminal snapshot in the closing hour so the published chain
    // ends on the poll's final counts even when the hourly run has already passed.
    await writeSnapshotForPoll(env, pollId, currentHour(), true);
  } else if (nextStatus === 'open' || nextStatus === 'pending') {
    await env.DB.prepare('UPDATE polls SET closed_at = NULL WHERE id = ?').bind(pollId).run();
  }

  await logAudit(env, {
    actor, action: 'poll.status', targetType: 'poll', targetId: pollId,
    details: {
      status: nextStatus,
      previousStatus: pollStatusLabel(poll.status)
    }
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

// Replaces the option set of a pending choice poll. Editing is restricted to
// polls that are still pending: once a poll is open the labels are part of the
// published question and of its counts. The change is written to the audit log.
async function updatePollOptions(
  pollId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  if (!Number.isSafeInteger(pollId) || pollId < 1) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  const rawOptions = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).options
    : undefined;
  const validation = validatePollOptions(rawOptions);
  if (!validation.ok) {
    return Response.json({ message: validation.message }, { status: 400 });
  }

  const poll = await env.DB.prepare(
    'SELECT id, poll_type, status FROM polls WHERE id = ?'
  ).bind(pollId).first<{ id: number; poll_type: number; status: number }>();
  if (!poll) {
    return Response.json({ message: `poll ${pollId} was not found` }, { status: 404 });
  }
  if (Number(poll.poll_type) === PollType.Verdict) {
    return Response.json({ message: `poll ${pollId} is a verdict poll and has no options` }, { status: 409 });
  }
  if (Number(poll.status) !== PollStatus.Pending) {
    return Response.json({ message: 'option labels can only be edited while a poll is pending' }, { status: 409 });
  }

  const previous = await env.DB.prepare(
    'SELECT id, position, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC'
  ).bind(pollId).all<{ id: number; position: number; label: string }>();

  // The existing option ids are reused by position so a pending poll keeps a
  // stable option identity across an edit.
  const existing = new Map<number, number>();
  for (const row of previous.results ?? []) {
    existing.set(Number(row.position), Number(row.id));
  }

  const statements: D1PreparedStatement[] = [];
  for (const option of validation.options) {
    const optionId = existing.get(option.position);
    if (optionId === undefined) {
      statements.push(env.DB.prepare(
        'INSERT INTO poll_options (poll_id, position, label) VALUES (?, ?, ?)'
      ).bind(pollId, option.position, option.label));
    } else {
      statements.push(env.DB.prepare(
        'UPDATE poll_options SET label = ? WHERE id = ?'
      ).bind(option.label, optionId));
    }
  }
  // Positions above the new set are removed; the foreign key cascade also drops
  // their selections, which cannot exist while the poll is pending.
  const keptPositions = validation.options.map((option) => option.position);
  statements.push(env.DB.prepare(
    `DELETE FROM poll_options WHERE poll_id = ?
     AND position NOT IN (${keptPositions.map(() => '?').join(', ')})`
  ).bind(pollId, ...keptPositions));
  await env.DB.batch(statements);

  await logAudit(env, {
    actor, action: 'poll.options', targetType: 'poll', targetId: pollId,
    details: {
      previous: (previous.results ?? []).map((row) => ({
        position: Number(row.position), label: row.label
      })),
      options: validation.options
    }
  });

  return Response.json({
    ok: true,
    pollId,
    options: validation.options,
    message: `Updated ${validation.options.length} option(s) for poll ${pollId}.`
  });
}
