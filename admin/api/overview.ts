import { PollStatus } from '../../worker/enums';
import type { AdminEnv } from '../auth';

interface CountRow {
  total: number;
}

export async function handleOverviewRequest(request: Request, env: AdminEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  const [pending, open, closed, archived, votes, comments, identities, settings, adminUsers, auditEntries] = await Promise.all([
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Pending),
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Open),
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Closed),
    count(env, 'SELECT COUNT(*) AS total FROM polls WHERE status = ?', PollStatus.Archived),
    count(env, 'SELECT COUNT(*) AS total FROM votes'),
    count(env, 'SELECT COUNT(*) AS total FROM comments'),
    count(env, 'SELECT COUNT(*) AS total FROM identities'),
    count(env, 'SELECT COUNT(*) AS total FROM settings'),
    count(env, 'SELECT COUNT(*) AS total FROM admin_users'),
    count(env, 'SELECT COUNT(*) AS total FROM admin_audit_log')
  ]);

  const recentPending = await env.DB.prepare(
    `SELECT id, title, mode, created_at
     FROM polls
     WHERE status = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 5`
  ).bind(PollStatus.Pending).all<{ id: number; title: string | null; mode: number; created_at: number }>();

  return Response.json({
    overview: {
      pending,
      open,
      closed,
      archived,
      votes,
      comments,
      identities,
      settings,
      adminUsers,
      auditEntries,
      recentPending: (recentPending.results ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        mode: row.mode,
        createdAt: new Date(row.created_at * 1000).toISOString()
      }))
    }
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function count(env: AdminEnv, sql: string, ...binds: unknown[]): Promise<number> {
  const statement = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
  const row = await statement.first<CountRow>();
  return Number(row?.total ?? 0);
}
