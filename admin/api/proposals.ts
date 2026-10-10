import { PollMode, PollStatus } from '../../worker/enums';
import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import { POLL_STATUS_VALUES, parsePollStatus, pollModeLabel, pollStatusLabel, type AdminPollStatus } from '../lib/enums';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;

interface ProposalRow {
  id: number;
  title: string | null;
  description: string | null;
  mode: number;
  start_at: number | null;
  end_at: number | null;
  status: number;
  poller_id: string | null;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

export async function handleProposalsRequest(request: Request, url: URL, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const match = url.pathname.match(/^\/api\/admin\/proposals(?:\/(\d+)(?:\/(approve|reject))?)?$/);
  if (!match) {
    return Response.json({ message: 'not found' }, { status: 404 });
  }

  const [, idText, action] = match;

  if (!idText) {
    if (request.method !== 'GET') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return listProposals(url, env);
  }

  const pollId = Number(idText);
  if (!Number.isSafeInteger(pollId) || pollId < 1) {
    return Response.json({ message: 'invalid poll ID' }, { status: 400 });
  }

  if (action === 'approve' || action === 'reject') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return reviewProposal(pollId, action, env, actor);
  }

  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }
  return getProposal(pollId, env);
}

async function listProposals(url: URL, env: AdminEnv): Promise<Response> {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return Response.json({ message: 'invalid pagination parameters' }, { status: 400 });
  }

  const statusParam = (url.searchParams.get('status') ?? 'pending').toLowerCase();
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
  const searchClause = query ? " AND title LIKE ? ESCAPE '\\'" : '';
  const statusClause = statusFilter === 'all' ? '' : ' AND status = ?';
  const statusBind = statusFilter === 'all' ? [] : [POLL_STATUS_VALUES[statusFilter]];

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM polls WHERE 1 = 1${statusClause}${searchClause}`
  ).bind(...statusBind, ...(query ? [likePattern] : [])).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `SELECT id, title, description, mode, start_at, end_at, status, poller_id,
            created_at, updated_at, reviewed_at
     FROM polls
     WHERE 1 = 1${statusClause}${searchClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).bind(...statusBind, ...(query ? [likePattern] : []), pageSize, offset)
    .all<ProposalRow>();

  return Response.json({
    proposals: (result.results ?? []).map(serializeProposal),
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

async function getProposal(pollId: number, env: AdminEnv): Promise<Response> {
  const proposal = await env.DB.prepare(
    `SELECT id, title, description, mode, start_at, end_at, status, poller_id,
            created_at, updated_at, reviewed_at
     FROM polls WHERE id = ?`
  ).bind(pollId).first<ProposalRow>();

  if (!proposal) {
    return Response.json({ message: 'poll not found' }, { status: 404 });
  }

  const votes = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM votes WHERE poll_id = ?'
  ).bind(pollId).first<{ total: number }>();

  return Response.json({
    proposal: serializeProposal(proposal),
    votes: Number(votes?.total ?? 0)
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function reviewProposal(pollId: number, action: 'approve' | 'reject', env: AdminEnv, actor: AdminActor): Promise<Response> {
  const proposal = await env.DB.prepare(
    'SELECT id, title, mode, status FROM polls WHERE id = ?'
  ).bind(pollId).first<{ id: number; title: string | null; mode: number; status: number }>();

  if (!proposal) {
    return Response.json({ message: `poll ${pollId} was not found` }, { status: 404 });
  }
  if (proposal.status !== PollStatus.Pending) {
    return Response.json({ message: `poll ${pollId} is not pending review` }, { status: 409 });
  }

  if (action === 'approve') {
    if (!proposal.title?.trim()) {
      return Response.json({ message: `poll ${pollId} has no title` }, { status: 422 });
    }
    if (proposal.mode !== PollMode.Deadline && proposal.mode !== PollMode.Evergreen) {
      return Response.json({ message: `poll ${pollId} has an unsupported mode` }, { status: 422 });
    }
  }

  const nextStatus = action === 'approve' ? PollStatus.Open : PollStatus.Archived;
  const update = await env.DB.prepare(
    `UPDATE polls
     SET status = ?, reviewed_at = unixepoch(), updated_at = unixepoch()
     WHERE id = ? AND status = ?`
  ).bind(nextStatus, pollId, PollStatus.Pending).run();

  if (update.meta.changes !== 1) {
    return Response.json({ message: `poll ${pollId} changed before review completed` }, { status: 409 });
  }

  await logAudit(env, {
    actor,
    action: action === 'approve' ? 'proposal.approve' : 'proposal.reject',
    targetType: 'poll',
    targetId: pollId
  });

  return Response.json({
    ok: true,
    pollId,
    action,
    status: pollStatusLabel(nextStatus),
    message: action === 'approve'
      ? `Approved submission; poll ${pollId} is now open.`
      : `Rejected submission; poll ${pollId} was archived.`
  });
}

function serializeProposal(row: ProposalRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    mode: pollModeLabel(row.mode),
    status: pollStatusLabel(row.status),
    submitter: row.poller_id,
    startAt: toIso(row.start_at),
    endAt: toIso(row.end_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    reviewedAt: toIso(row.reviewed_at)
  };
}

function toIso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}
