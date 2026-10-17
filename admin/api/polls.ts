import { PollMode, PollStatus, PollType } from '../../worker/enums';
import { currentHour, writeSnapshotForPoll } from '../../worker/services/maintenance';
import {
  countBallots,
  getOptionsForPolls,
  legacyVerdictCounts,
  type PollOption
} from '../../worker/services/options';
import {
  REQUIRED_VERDICT_PRESET_KEYS,
  validatePollOptions,
  validatePresetKeys,
  type PresetKey
} from '../../worker/services/pollType';
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
  views: number;
  created_at: number;
  updated_at: number;
}

interface AdminOptionCount {
  id: number;
  label: string | null;
  presetKey: string | null;
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
            (SELECT COALESCE(SUM(pv.views), 0) FROM poll_views pv WHERE pv.poll_id = i.id) AS views
     FROM page
     JOIN polls i ON i.id = page.id
     ORDER BY i.created_at DESC, i.id DESC`
  ).bind(
    ...statusBind, ...(query ? [likePattern] : []),
    pageSize, offset
  ).all<AdminPollRow>();

  // The options and the tally of every poll on this page come from the shared
  // engine (paginate, then aggregate), so a verdict poll exposes its preset rows
  // with their counts exactly like a choice poll exposes its labels.
  const pageRows = (result.results ?? []).map((row) => ({
    id: Number(row.id),
    poll_type: Number(row.poll_type ?? PollType.Verdict)
  }));
  const optionsByPoll = await getOptionsForPolls(env, pageRows);
  const tallies = await countBallots(env, pageRows);

  return Response.json({
    polls: (result.results ?? []).map((row) => {
      const pollId = Number(row.id);
      const pollType = Number(row.poll_type ?? PollType.Verdict);
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
        ballots: tally.ballots,
        counts: legacyVerdictCounts(optionsByPoll.get(pollId) ?? [], tally),
        // The labels are shown with their counts; a preset verdict row carries
        // its preset key instead of a label, so the dashboard translates it.
        options: (optionsByPoll.get(pollId) ?? []).map((option: PollOption) => ({
          id: option.id,
          position: option.position,
          label: option.label,
          presetKey: option.presetKey,
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

// Updates the option set of a pending poll that has no ballots yet. A choice
// poll's labels are replaced by position; a verdict poll only allows its
// optional `neutral` preset row to be removed or restored, because `approve` and
// `oppose` are part of the question itself. The change is written to the audit
// log.
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
    'SELECT id, poll_type, status FROM polls WHERE id = ?'
  ).bind(pollId).first<{ id: number; poll_type: number; status: number }>();
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

  const previousResult = await env.DB.prepare(
    'SELECT id, position, label, preset_key FROM poll_options WHERE poll_id = ? ORDER BY position ASC'
  ).bind(pollId).all<{ id: number; position: number; label: string | null; preset_key: string | null }>();
  const previous = previousResult.results ?? [];

  // A verdict poll: only the optional neutral preset row may change.
  if (Number(poll.poll_type) === PollType.Verdict) {
    if (payload.options !== undefined) {
      return Response.json({
        message: `poll ${pollId} is a verdict poll; only its neutral preset row can be changed`
      }, { status: 409 });
    }
    const presetValidation = validatePresetKeys(payload.presetKeys);
    if (!presetValidation.ok) {
      return Response.json({ message: presetValidation.message }, { status: 400 });
    }

    for (const key of REQUIRED_VERDICT_PRESET_KEYS) {
      if (!previous.some((row) => row.preset_key === key)) {
        return Response.json({ message: `poll ${pollId} is missing its ${key} preset row` }, { status: 409 });
      }
    }

    const desired = new Set<PresetKey>(presetValidation.presetKeys);
    const neutral = previous.find((row) => row.preset_key === 'neutral');
    const presetStatements: D1PreparedStatement[] = [];
    if (desired.has('neutral') && !neutral) {
      presetStatements.push(env.DB.prepare(
        "INSERT INTO poll_options (poll_id, position, label, preset_key) VALUES (?, ?, NULL, 'neutral')"
      ).bind(pollId, previous.length + 1));
    } else if (!desired.has('neutral') && neutral) {
      presetStatements.push(env.DB.prepare('DELETE FROM poll_options WHERE id = ?').bind(Number(neutral.id)));
    }
    if (presetStatements.length > 0) await env.DB.batch(presetStatements);

    await logAudit(env, {
      actor, action: 'poll.options', targetType: 'poll', targetId: pollId,
      details: { previous: previous.map(readableOption), presetKeys: presetValidation.presetKeys }
    });

    return Response.json({
      ok: true,
      pollId,
      presetKeys: presetValidation.presetKeys,
      message: `Updated the preset rows of poll ${pollId}.`
    });
  }

  // A choice poll: the labels are replaced by position.
  if (payload.presetKeys !== undefined) {
    return Response.json({ message: 'a choice poll does not accept preset keys' }, { status: 400 });
  }
  const validation = validatePollOptions(payload.options);
  if (!validation.ok) {
    return Response.json({ message: validation.message }, { status: 400 });
  }
  if (previous.some((row) => row.preset_key !== null)) {
    return Response.json({ message: `poll ${pollId} carries preset rows that cannot be edited` }, { status: 409 });
  }

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
        'INSERT INTO poll_options (poll_id, position, label, preset_key) VALUES (?, ?, ?, NULL)'
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
      previous: previous.map(readableOption),
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

// The audit-friendly view of a stored option row.
function readableOption(row: { position: number; label: string | null; preset_key: string | null }): {
  position: number;
  label?: string | null;
  presetKey?: string | null;
} {
  return row.preset_key === null
    ? { position: Number(row.position), label: row.label }
    : { position: Number(row.position), presetKey: row.preset_key };
}
