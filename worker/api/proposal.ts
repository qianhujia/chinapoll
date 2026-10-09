import { getIssueModeCode, IssueMode, IssueStatus, toUnixSeconds } from '../enums';

interface ProposalEnv {
  DB: D1Database;
  SERVER_SECRET?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

export async function handleProposalRequest(request: Request, env: ProposalEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'POST only' }, { status: 405 });
  }

  const body = await readJson(request);
  if (!body) {
    return Response.json({ ok: false, message: 'invalid JSON' }, { status: 400 });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const mode = getIssueModeCode(body.mode);
  const startAt = typeof body.startAt === 'string' ? body.startAt : '';
  const endAt = typeof body.endAt === 'string' ? body.endAt : '';
  const startTimestamp = Date.parse(startAt);
  const endTimestamp = Date.parse(endAt);
  if (body.description !== undefined && typeof body.description !== 'string') {
    return Response.json({ ok: false, message: 'invalid proposal description' }, { status: 400 });
  }
  if (body.email !== undefined && typeof body.email !== 'string') {
    return Response.json({ ok: false, message: 'invalid email' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!title || title.length > MAX_TITLE_LENGTH || description.length > MAX_DESCRIPTION_LENGTH || !mode
    || (mode === IssueMode.Deadline && (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)
      || startTimestamp <= Date.now() || endTimestamp <= startTimestamp))
    || (email && (email.length > 254 || !EMAIL_PATTERN.test(email)))) {
    return Response.json({ ok: false, message: 'invalid proposal title, schedule, or email' }, { status: 400 });
  }

  let pollerId: string | null = null;
  if (email) {
    const emailHmac = await createEmailHmac(email, env.SERVER_SECRET);
    if (!emailHmac) {
      return Response.json({ ok: false, message: 'proposal identity secret is not configured' }, { status: 503 });
    }

    const existingIdentity = await env.DB.prepare(
      'SELECT poller_id FROM identities WHERE email_hmac = ?'
    ).bind(emailHmac).first<{ poller_id: string }>();

    if (existingIdentity) {
      pollerId = existingIdentity.poller_id;
    } else {
      pollerId = await createPollerIdentity(env.DB, emailHmac);
    }
  }

  const result = await env.DB.prepare(
    `INSERT INTO issues (title, description, mode, start_at, end_at, status, poller_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    title,
    description || null,
    mode,
    mode === IssueMode.Deadline ? toUnixSeconds(startAt) : null,
    mode === IssueMode.Deadline ? toUnixSeconds(endAt) : null,
    IssueStatus.Pending,
    pollerId
  ).run();

  const issueId = Number(result.meta.last_row_id);
  return Response.json({
    ok: true,
    message: 'proposal submitted for review',
    issueId,
    submitter: pollerId ?? '(anonymous)'
  }, { status: 201 });
}

export async function handleProposalClaimRequest(request: Request, env: ProposalEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, message: 'POST only' }, { status: 405 });
  }

  const body = await readJson(request);
  if (!body) {
    return Response.json({ ok: false, message: 'invalid JSON' }, { status: 400 });
  }

  const issueIdText = String(body.issueId ?? '').trim();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[1-9]\d*$/.test(issueIdText) || !EMAIL_PATTERN.test(email)) {
    return Response.json({ ok: false, message: 'invalid issue ID or email' }, { status: 400 });
  }
  const issueId = Number(issueIdText);
  if (!Number.isSafeInteger(issueId)) {
    return Response.json({ ok: false, message: 'invalid issue ID or email' }, { status: 400 });
  }

  const emailHmac = await createEmailHmac(email, env.SERVER_SECRET);
  if (!emailHmac) {
    return Response.json({ ok: false, message: 'proposal identity secret is not configured' }, { status: 503 });
  }

  const result = await env.DB.prepare(
    `SELECT issue.id, issue.poller_id
     FROM issues AS issue
     JOIN identities AS identity ON identity.poller_id = issue.poller_id
     WHERE issue.id = ? AND identity.email_hmac = ?`
  ).bind(issueId, emailHmac).first<{ id: number; poller_id: string }>();

  if (!result) {
    return Response.json({ ok: false, message: 'issue and email do not match' }, { status: 404 });
  }

  return Response.json({
    ok: true,
    issueId: result.id,
    submitter: result.poller_id
  });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function createEmailHmac(email: string, secretHex?: string): Promise<string | null> {
  if (!secretHex || !/^[0-9a-f]{64}$/i.test(secretHex)) return null;

  const secretBytes = new Uint8Array(secretHex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createPollerIdentity(db: D1Database, emailHmac: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const random = crypto.getRandomValues(new Uint8Array(6));
    const pollerId = `@poller_${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    await db.prepare(
      'INSERT INTO identities (poller_id, email_hmac) VALUES (?, ?) ON CONFLICT DO NOTHING'
    ).bind(pollerId, emailHmac).run();

    const identity = await db.prepare(
      'SELECT poller_id FROM identities WHERE email_hmac = ?'
    ).bind(emailHmac).first<{ poller_id: string }>();
    if (identity) return identity.poller_id;
  }

  throw new Error('Unable to create proposal identity after repeated random ID collisions.');
}
