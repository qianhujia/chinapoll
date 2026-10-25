import { PollMode, PollStatus, PollType } from '../../worker/enums';
import { currentHour, writeSnapshotForPoll } from '../../worker/services/maintenance';
import {
  countBallots,
  getOptionsForPolls,
  type PollOption
} from '../../worker/services/options';
import { validatePollOptions } from '../../worker/services/pollType';
import { pollNumberStatement } from '../../worker/services/pollNumber';
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
// Mirrors the public proposal rule (worker/api/proposal.ts).
const MAX_TITLE_LENGTH = 200;

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
  views: number;
  created_at: number;
  updated_at: number;
  topic_id: number | null;
  topic_slug: string | null;
  topic_name: string | null;
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

  // Assigns or clears a poll's topic.
  const topicMatch = url.pathname.match(/^\/api\/admin\/polls\/(\d+)\/topic$/);
  if (topicMatch) {
    if (request.method !== 'PUT') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updatePollTopic(Number(topicMatch[1]), request, env, actor);
  }

  // Option labels may only be corrected while a poll is still pending.
  const optionsMatch = url.pathname.match(/^\/api\/admin\/polls\/(\d+)\/options$/);
  if (optionsMatch) {
    if (request.method !== 'PUT') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updatePollOptions(Number(optionsMatch[1]), request, env, actor);
  }

  // The title may be corrected at any time, including after a poll is published.
  const titleMatch = url.pathname.match(/^\/api\/admin\/polls\/(\d+)\/title$/);
  if (titleMatch) {
    if (request.method !== 'PUT') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updatePollTitle(Number(titleMatch[1]), request, env, actor);
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
  const searchClause = query ? " AND p.title LIKE ? ESCAPE '\\'" : '';
  const statusClause = statusFilter === 'all' ? '' : ' AND p.status = ?';
  const statusBind = statusFilter === 'all' ? [] : [POLL_STATUS_VALUES[statusFilter]];

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM polls p WHERE 1 = 1${statusClause}${searchClause}`
  ).bind(...statusBind, ...(query ? [likePattern] : [])).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `WITH page AS (
       SELECT id FROM polls p
       WHERE 1 = 1${statusClause}${searchClause}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?
     )
SELECT p.id, p.title, p.description, p.mode, p.poll_type, p.duration_seconds,
             p.start_at, p.end_at, p.status,
             p.created_at, p.updated_at,
             p.topic_id, t.slug AS topic_slug, t.name AS topic_name,
             (SELECT COALESCE(SUM(pv.views), 0) FROM poll_views pv WHERE pv.poll_id = p.id) AS views
      FROM page
      JOIN polls p ON p.id = page.id
      LEFT JOIN topics t ON t.id = p.topic_id
      ORDER BY p.created_at DESC, p.id DESC`
  ).bind(
    ...statusBind, ...(query ? [likePattern] : []),
    pageSize, offset
  ).all<AdminPollRow>();

  // The options and the tally of every poll on this page come from the shared
  // engine (paginate, then aggregate).
  const pageRows = (result.results ?? []).map((row) => ({
    id: Number(row.id),
    poll_type: Number(row.poll_type ?? PollType.SingleChoice)
  }));
  const optionsByPoll = await getOptionsForPolls(env, pageRows);
  const tallies = await countBallots(env, pageRows);

  return Response.json({
    polls: (result.results ?? []).map((row) => {
      const pollId = Number(row.id);
      const pollType = Number(row.poll_type ?? PollType.SingleChoice);
      const tally = tallies.get(pollId) ?? { ballots: 0, counts: new Map<number, number>() };
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        mode: row.mode === PollMode.Evergreen ? 'evergreen' : 'deadline',
        pollType: pollTypeLabel(pollType),
        durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
        status: pollStatusLabel(row.status),
        startAt: toIso(row.start_at),
        endAt: toIso(row.end_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        views: Number(row.views),
        topicId: row.topic_id === null ? null : Number(row.topic_id),
        topic: row.topic_slug
          ? { id: Number(row.topic_id), slug: row.topic_slug, name: row.topic_name }
          : null,
        ballots: tally.ballots,
        // Each option is shown with its own count.
        options: (optionsByPoll.get(pollId) ?? []).map((option: PollOption) => ({
          id: option.id,
          position: option.position,
          label: option.label,
          count: Number(tally.counts.get(option.id) ?? 0)
        }))
      };
    }),
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

// Sets or clears a poll's topic. `topicId: null` (or omitted) clears it.
async function updatePollTopic(
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
  const payload = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const raw = payload.topicId;

  let topicId: number | null;
  if (raw === null || raw === undefined || raw === '') {
    topicId = null;
  } else {
    topicId = Number(raw);
    if (!Number.isSafeInteger(topicId) || topicId < 1) {
      return Response.json({ message: 'topicId must be a positive integer or null' }, { status: 400 });
    }
  }

  const poll = await env.DB.prepare(
    `SELECT p.id, t.slug AS topic_slug
     FROM polls p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.id = ?`
  ).bind(pollId).first<{ id: number; topic_slug: string | null }>();
  if (!poll) {
    return Response.json({ message: `poll ${pollId} was not found` }, { status: 404 });
  }

  let slug: string | null = null;
  if (topicId !== null) {
    const topic = await env.DB.prepare('SELECT slug FROM topics WHERE id = ?')
      .bind(topicId).first<{ slug: string }>();
    if (!topic) {
      return Response.json({ message: `topic ${topicId} was not found` }, { status: 422 });
    }
    slug = topic.slug;
  }

  await env.DB.prepare('UPDATE polls SET topic_id = ?, updated_at = unixepoch() WHERE id = ?')
    .bind(topicId, pollId).run();

  await logAudit(env, {
    actor, action: 'poll.topic', targetType: 'poll', targetId: pollId,
    details: { previous: poll.topic_slug ?? null, topic: slug }
  });

  return Response.json({
    ok: true,
    pollId,
    topic: topicId === null || slug === null ? null : { id: topicId, slug },
    message: slug ? `Set topic to "${slug}" for poll ${pollId}.` : `Cleared the topic for poll ${pollId}.`
  });
}

// Sets a poll's title. Unlike the option labels, the title can be corrected at
// any time, including after the poll has been published, and every change is
// written to the audit log with the previous value.
async function updatePollTitle(
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
  const payload = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    return Response.json({ message: `title must be 1 to ${MAX_TITLE_LENGTH} characters` }, { status: 400 });
  }

  const poll = await env.DB.prepare('SELECT id, title FROM polls WHERE id = ?')
    .bind(pollId).first<{ id: number; title: string | null }>();
  if (!poll) {
    return Response.json({ message: `poll ${pollId} was not found` }, { status: 404 });
  }

  // An unchanged title is not written, so the audit log only records real edits.
  if ((poll.title ?? '') === title) {
    return Response.json({
      ok: true,
      pollId,
      title,
      message: `Poll ${pollId} already has this title.`
    });
  }

  await env.DB.prepare('UPDATE polls SET title = ?, updated_at = unixepoch() WHERE id = ?')
    .bind(title, pollId).run();

  await logAudit(env, {
    actor, action: 'poll.title', targetType: 'poll', targetId: pollId,
    details: { previous: poll.title ?? null, title }
  });

  return Response.json({
    ok: true,
    pollId,
    title,
    message: `Updated the title of poll ${pollId}.`
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
    // A poll without options cannot be voted on.
    const optionCount = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM poll_options WHERE poll_id = ?'
    ).bind(pollId).first<{ total: number }>();
    if (Number(optionCount?.total ?? 0) === 0) {
      return Response.json({ message: `poll ${pollId} has no options and cannot be published` }, { status: 422 });
    }
  }

  // Publishing a poll also gives it its public number, in the same transaction as
  // the status change, so a poll is never open without one. The assignment is a
  // no-op when the poll already has a number (reopening a closed poll), because a
  // number is permanent.
  const statusStatements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE polls
       SET status = ?, updated_at = unixepoch(),
           reviewed_at = CASE WHEN ? = 1 THEN unixepoch() ELSE reviewed_at END
       WHERE id = ?`
    ).bind(storedStatus, nextStatus === 'open' ? 1 : 0, pollId)
  ];
  if (nextStatus === 'open') {
    statusStatements.push(pollNumberStatement(env.DB, pollId));
  }

  const [update] = await env.DB.batch(statusStatements);
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

// Replaces the option set of a pending poll that has no ballots yet. Editing is
// restricted to polls that are still pending and that nobody has voted on: once a
// poll is open, or has ballots, its options are part of the published question and
// of its counts. The change is written to the audit log.
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
  const payload = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};

  const poll = await env.DB.prepare(
    'SELECT id, status FROM polls WHERE id = ?'
  ).bind(pollId).first<{ id: number; status: number }>();
  if (!poll) {
    return Response.json({ message: `poll ${pollId} was not found` }, { status: 404 });
  }
  if (Number(poll.status) !== PollStatus.Pending) {
    return Response.json({ message: 'option labels can only be edited while a poll is pending' }, { status: 409 });
  }

  // An option set can only be corrected before anyone has voted, so the counts
  // published for the poll can never disagree with its current options.
  const ballots = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?'
  ).bind(pollId).first<{ total: number }>();
  if (Number(ballots?.total ?? 0) > 0) {
    return Response.json({ message: `poll ${pollId} already has ballots and its options are frozen` }, { status: 409 });
  }

  const validation = validatePollOptions(payload.options);
  if (!validation.ok) {
    return Response.json({ message: validation.message }, { status: 400 });
  }

  const previousResult = await env.DB.prepare(
    'SELECT id, position, label FROM poll_options WHERE poll_id = ? ORDER BY position ASC'
  ).bind(pollId).all<{ id: number; position: number; label: string }>();
  const previous = previousResult.results ?? [];

  // The existing option ids are reused by position so a pending poll keeps a
  // stable option identity across an edit.
  const existing = new Map<number, number>();
  for (const row of previous) {
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
      previous: previous.map((row) => ({ position: Number(row.position), label: row.label })),
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
