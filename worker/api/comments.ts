import { RATE_LIMIT_PATTERN } from './settings';

const MAX_PAGE_SIZE = 100;
const MIN_COMMENT_LENGTH = 5;
const MAX_COMMENT_LENGTH = 140;
const DEFAULT_COMMENT_RATE_LIMIT = '3/h';

function parseRateLimit(rateLimitStr: string): { count: number; windowMs: number } {
  const match = rateLimitStr.match(RATE_LIMIT_PATTERN);
  if (!match) return { count: 3, windowMs: 3_600_000 };
  const count = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    w: 7 * 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000
  };
  return { count, windowMs: unitMs[unit] || 3_600_000 };
}

async function getCommentRateLimit(db: any): Promise<{ count: number; windowMs: number }> {
  const row = await db.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).bind('comment_rate_limit').first();

  if (row?.value && typeof row.value === 'string') {
    return parseRateLimit(row.value);
  }
  return parseRateLimit(DEFAULT_COMMENT_RATE_LIMIT);
}

export async function handleCommentsRequest(request: Request, url: URL, env: any): Promise<Response> {
  if (request.method === 'POST') {
    return handleCommentSubmission(request, env);
  }

  if (request.method !== 'GET') {
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  const issueId = Number(url.pathname.split('/').pop() ?? '0');
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '30');

  if (!Number.isSafeInteger(issueId) || issueId < 1
    || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return Response.json({ message: 'invalid pagination parameters' }, { status: 400 });
  }

  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    return Response.json({ message: 'invalid pagination parameters' }, { status: 400 });
  }

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM comments WHERE issue_id = ?`
  ).bind(issueId).first();

  const commentResult = await env.DB.prepare(
    `SELECT id, comment, created_at FROM comments
     WHERE issue_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(issueId, pageSize, offset).all();

  return Response.json({
    issueId,
    page,
    pageSize,
    total: Number(countResult?.total ?? 0),
    comments: (commentResult.results ?? []).map((row: { id: number; comment: string; created_at: number }) => ({
      id: row.id,
      comment: row.comment,
      createdAt: new Date(row.created_at * 1000).toISOString()
    }))
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function handleCommentSubmission(request: Request, env: any): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null || !('issueId' in body) || !('comment' in body)) {
    return Response.json({ message: 'issueId and comment are required' }, { status: 400 });
  }

  const issueId = Number(body.issueId);
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (!Number.isSafeInteger(issueId) || issueId < 1) {
    return Response.json({ message: 'invalid issueId' }, { status: 400 });
  }
  if (comment.length < MIN_COMMENT_LENGTH || comment.length > MAX_COMMENT_LENGTH) {
    return Response.json({ message: 'comment must be between 5 and 140 characters' }, { status: 400 });
  }

  const { count: commentRateLimit, windowMs: commentWindowMs } = await getCommentRateLimit(env.DB);
  const now = Date.now();
  const bucketStart = now - (now % commentWindowMs);

  const remoteIp = request.headers.get('cf-connecting-ip') ?? '127.0.0.1';
  const ipPrefix = remoteIp.split('.').slice(0, 3).join('.');

  const rateLimitResult: any = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM comments WHERE ip_prefix = ? AND ts_bucket = ?`
  ).bind(ipPrefix, bucketStart).first();

  if ((Number(rateLimitResult?.count ?? 0)) >= commentRateLimit) {
    return Response.json({ message: 'comment rate limit reached' }, { status: 429 });
  }

  const result = await env.DB.prepare(
    'INSERT INTO comments (issue_id, comment, ip_prefix, ts_bucket) VALUES (?, ?, ?, ?)'
  ).bind(issueId, comment, ipPrefix, bucketStart).run();

  return Response.json({ ok: true, id: result.meta.last_row_id }, { status: 201 });
}
