// Read-only access to the admin audit log. Entries never contain client IPs.

import type { AdminActor, AdminEnv } from '../auth';
import { noStoreJson } from '../lib/http';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 100;

interface AuditRow {
  id: number;
  actor_id: number | null;
  actor_username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  created_at: number;
}

export async function handleAuditRequest(
  request: Request,
  url: URL,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  if (url.pathname !== '/api/admin/audit') {
    return noStoreJson({ message: 'not found' }, 404);
  }
  // Only super admins may read the audit log.
  if (actor.role !== 'super_admin') {
    return noStoreJson({ message: 'super admin role required' }, 403);
  }
  if (request.method !== 'GET') {
    return noStoreJson({ message: 'method not allowed' }, 405);
  }

  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  if (!Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return noStoreJson({ message: 'invalid pagination parameters' }, 400);
  }

  const actionFilter = (url.searchParams.get('action') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const likePattern = query ? `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : '';

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (actionFilter) {
    clauses.push('action = ?');
    binds.push(actionFilter);
  }
  if (query) {
    clauses.push("(actor_username LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')");
    binds.push(likePattern, likePattern, likePattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM admin_audit_log ${where}`
  ).bind(...binds).first<{ total: number }>();

  const total = Number(countResult?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const result = await env.DB.prepare(
    `SELECT id, actor_id, actor_username, action, target_type, target_id, details, created_at
     FROM admin_audit_log
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).bind(...binds, pageSize, offset).all<AuditRow>();

  const actionsResult = await env.DB.prepare(
    'SELECT DISTINCT action FROM admin_audit_log ORDER BY action ASC'
  ).all<{ action: string }>();

  return noStoreJson({
    entries: (result.results ?? []).map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorUsername: row.actor_username,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: parseDetails(row.details),
      createdAt: new Date(row.created_at * 1000).toISOString()
    })),
    actions: (actionsResult.results ?? []).map((row) => row.action),
    page: currentPage,
    pageSize,
    total,
    totalPages,
    action: actionFilter,
    query
  });
}

function parseDetails(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
