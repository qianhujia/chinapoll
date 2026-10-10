// Comment moderation endpoints.

import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import { noStoreJson } from '../lib/http';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;

interface CommentRow {
  id: number;
  poll_id: number;
  comment: string;
  created_at: number;
  poll_title: string | null;
}

export async function handleCommentsRequest(
  request: Request,
  url: URL,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  const match = url.pathname.match(/^\/api\/admin\/comments(?:\/(\d+))?$/);
  if (!match) return noStoreJson({ message: 'not found' }, 404);

  const [, idText] = match;
  if (idText) {
    if (request.method !== 'DELETE') return noStoreJson({ message: 'method not allowed' }, 405);
    const commentId = Number(idText);
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      return noStoreJson({ message: 'invalid comment ID' }, 400);
    }
    return deleteComment(commentId, env, actor);
  }

  if (request.method !== 'GET') return noStoreJson({ message: 'method not allowed' }, 405);
  return listComments(url, env);
}

async function listComments(url: URL, env: AdminEnv): Promise<Response> {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return noStoreJson({ message: 'invalid pagination parameters' }, 400);
  }

  const pollIdText = (url.searchParams.get('pollId') ?? '').trim();
  let pollId: number | null = null;
  if (pollIdText) {
    const parsed = Number(pollIdText);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return noStoreJson({ message: 'invalid poll ID' }, 400);
    }
    pollId = parsed;
  }

  const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const likePattern = query ? `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : '';

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (pollId !== null) {
    clauses.push('c.poll_id = ?');
    binds.push(pollId);
  }
  if (query) {
    clauses.push("c.comment LIKE ? ESCAPE '\\'");
    binds.push(likePattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM comments c ${where}`
  ).bind(...binds).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `SELECT c.id, c.poll_id, c.comment, c.created_at, i.title AS poll_title
     FROM comments c
     LEFT JOIN polls i ON i.id = c.poll_id
     ${where}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ? OFFSET ?`
  ).bind(...binds, pageSize, offset).all<CommentRow>();

  return noStoreJson({
    comments: (result.results ?? []).map((row) => ({
      id: row.id,
      pollId: row.poll_id,
      pollTitle: row.poll_title,
      comment: row.comment,
      createdAt: new Date(row.created_at * 1000).toISOString()
    })),
    page: currentPage,
    pageSize,
    total,
    totalPages,
    pollId,
    query
  });
}

async function deleteComment(commentId: number, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const comment = await env.DB.prepare(
    'SELECT id, poll_id, comment FROM comments WHERE id = ?'
  ).bind(commentId).first<{ id: number; poll_id: number; comment: string }>();

  if (!comment) {
    return noStoreJson({ message: `comment ${commentId} was not found` }, 404);
  }

  await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run();

  await logAudit(env, {
    actor, action: 'comment.delete', targetType: 'comment', targetId: commentId,
    details: { pollId: comment.poll_id, comment: comment.comment.slice(0, 140) }
  });

  return noStoreJson({ ok: true, message: `Deleted comment ${commentId}.` });
}
