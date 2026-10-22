// Admin poll-topic management: list, create, rename, reorder, enable, delete,
// and insert the suggested set. Both admin roles may use every action. Deleting a
// topic leaves its polls in place and untopicalized (the column's
// `ON DELETE SET NULL`).

import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import { noStoreJson, readJsonBody, readString } from '../../shared/http';
import {
  TOPIC_SLUG_PATTERN,
  MAX_TOPIC_NAME_LENGTH,
  SUGGESTED_TOPICS
} from '../../shared/categories';

const MAX_POSITION = 10_000;

interface TopicRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  enabled: number;
  polls: number;
}

function publicTopic(row: TopicRow): {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  enabled: boolean;
  polls: number;
} {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    position: Number(row.position),
    enabled: Number(row.enabled) === 1,
    polls: Number(row.polls ?? 0)
  };
}

function readBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

export async function handleTopicsRequest(
  request: Request,
  url: URL,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  if (url.pathname === '/api/admin/topics') {
    if (request.method === 'GET') return listTopics(env);
    if (request.method === 'POST') return createTopic(request, env, actor);
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  if (url.pathname === '/api/admin/topics/suggested') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return insertSuggestedTopics(env, actor);
  }

  const idMatch = url.pathname.match(/^\/api\/admin\/topics\/(\d+)$/);
  if (idMatch) {
    const topicId = Number(idMatch[1]);
    if (request.method === 'PUT') return updateTopic(topicId, request, env, actor);
    if (request.method === 'DELETE') return deleteTopic(topicId, env, actor);
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  return Response.json({ message: 'not found' }, { status: 404 });
}

async function listTopics(env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.description, t.position, t.enabled,
            (SELECT COUNT(*) FROM polls p WHERE p.topic_id = t.id) AS polls
     FROM topics t
     ORDER BY t.position ASC, t.id ASC`
  ).all<TopicRow>();

  return noStoreJson({ topics: (result.results ?? []).map(publicTopic) });
}

async function createTopic(request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const slug = readString(body, 'slug').trim().toLowerCase();
  if (!TOPIC_SLUG_PATTERN.test(slug)) {
    return noStoreJson({
      message: 'slug must be 2 to 40 characters from a-z, 0-9, and hyphen'
    }, 422);
  }
  const name = readString(body, 'name').trim();
  if (!name || name.length > MAX_TOPIC_NAME_LENGTH) {
    return noStoreJson({ message: `name must contain 1 to ${MAX_TOPIC_NAME_LENGTH} characters` }, 422);
  }
  const description = body.description !== undefined ? readString(body, 'description').trim() : '';
  if (description && description.length > 500) {
    return noStoreJson({ message: 'description must be at most 500 characters' }, 422);
  }

  const enabledValue = body.enabled === undefined ? true : readBoolean(body.enabled);
  if (enabledValue === null) return noStoreJson({ message: 'enabled must be true or false' }, 422);

  const existing = await env.DB.prepare('SELECT id FROM topics WHERE slug = ?')
    .bind(slug).first<{ id: number }>();
  if (existing) return noStoreJson({ message: `topic "${slug}" already exists` }, 409);

  let position: number;
  if (body.position === undefined || body.position === null) {
    const last = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS position FROM topics')
      .first<{ position: number }>();
    position = Number(last?.position ?? 0) + 1;
  } else {
    position = Number(body.position);
    if (!Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION) {
      return noStoreJson({ message: `position must be an integer from 0 to ${MAX_POSITION}` }, 422);
    }
  }

  const result = await env.DB.prepare(
    'INSERT INTO topics (slug, name, description, position, enabled) VALUES (?, ?, ?, ?, ?)'
  ).bind(slug, name, description || null, position, enabledValue ? 1 : 0).run();
  const topicId = Number(result.meta.last_row_id);

  await logAudit(env, {
    actor, action: 'topic.create', targetType: 'topic', targetId: topicId,
    details: { slug, name, description, position, enabled: enabledValue }
  });

  return noStoreJson({
    ok: true,
    topic: { id: topicId, slug, name, description, position, enabled: enabledValue, polls: 0 },
    message: `Created topic "${slug}".`
  }, 201);
}

// Renames, reorders, and enables or disables a topic. The slug is deliberately
// not editable: it is the public `topic=<slug>` identifier.
async function updateTopic(
  topicId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  if (!Number.isSafeInteger(topicId) || topicId < 1) {
    return noStoreJson({ message: 'invalid topic ID' }, 400);
  }

  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const existing = await env.DB.prepare(
    'SELECT id, slug, name, description, position, enabled FROM topics WHERE id = ?'
  ).bind(topicId).first<{ id: number; slug: string; name: string; description: string | null; position: number; enabled: number }>();
  if (!existing) return noStoreJson({ message: `topic ${topicId} was not found` }, 404);

  const updates: string[] = [];
  const binds: unknown[] = [];
  const changes: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = readString(body, 'name').trim();
    if (!name || name.length > MAX_TOPIC_NAME_LENGTH) {
      return noStoreJson({ message: `name must contain 1 to ${MAX_TOPIC_NAME_LENGTH} characters` }, 422);
    }
    updates.push('name = ?');
    binds.push(name);
    changes.name = name;
  }

  if (body.description !== undefined) {
    const description = readString(body, 'description').trim();
    if (description.length > 500) {
      return noStoreJson({ message: 'description must be at most 500 characters' }, 422);
    }
    updates.push('description = ?');
    binds.push(description || null);
    changes.description = description;
  }

  if (body.position !== undefined) {
    const position = Number(body.position);
    if (!Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION) {
      return noStoreJson({ message: `position must be an integer from 0 to ${MAX_POSITION}` }, 422);
    }
    updates.push('position = ?');
    binds.push(position);
    changes.position = position;
  }

  if (body.enabled !== undefined) {
    const enabled = readBoolean(body.enabled);
    if (enabled === null) return noStoreJson({ message: 'enabled must be true or false' }, 422);
    updates.push('enabled = ?');
    binds.push(enabled ? 1 : 0);
    changes.enabled = enabled;
  }

  if (updates.length === 0) {
    return noStoreJson({ message: 'no supported field was provided (name, position, enabled)' }, 422);
  }

  await env.DB.prepare(`UPDATE topics SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds, topicId).run();

  await logAudit(env, {
    actor, action: 'topic.update', targetType: 'topic', targetId: topicId,
    details: {
      previous: { name: existing.name, description: existing.description, position: Number(existing.position), enabled: Number(existing.enabled) === 1 },
      ...changes
    }
  });

  const updated = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.position, t.enabled,
            (SELECT COUNT(*) FROM polls p WHERE p.topic_id = t.id) AS polls
     FROM topics t WHERE t.id = ?`
  ).bind(topicId).first<TopicRow>();

  return noStoreJson({
    ok: true,
    topic: updated ? publicTopic(updated) : null,
    message: `Updated topic "${existing.slug}".`
  });
}

async function deleteTopic(topicId: number, env: AdminEnv, actor: AdminActor): Promise<Response> {
  if (!Number.isSafeInteger(topicId) || topicId < 1) {
    return noStoreJson({ message: 'invalid topic ID' }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT t.id, t.slug, t.name, t.description,
            (SELECT COUNT(*) FROM polls p WHERE p.topic_id = t.id) AS polls
     FROM topics t WHERE t.id = ?`
  ).bind(topicId).first<{ id: number; slug: string; name: string; description: string | null; polls: number }>();
  if (!existing) return noStoreJson({ message: `topic ${topicId} was not found` }, 404);

  // The polls are kept; the foreign key sets their `topic_id` to NULL.
  await env.DB.prepare('DELETE FROM topics WHERE id = ?').bind(topicId).run();

  await logAudit(env, {
    actor, action: 'topic.delete', targetType: 'topic', targetId: topicId,
    details: { slug: existing.slug, name: existing.name, description: existing.description, untopicalized: Number(existing.polls ?? 0) }
  });

  return noStoreJson({
    ok: true,
    untopicalized: Number(existing.polls ?? 0),
    message: `Deleted topic "${existing.slug}".`
  });
}

// Inserts the suggested topics, skipping any slug that already exists.
async function insertSuggestedTopics(env: AdminEnv, actor: AdminActor): Promise<Response> {
  const last = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS position FROM topics')
    .first<{ position: number }>();
  let position = Number(last?.position ?? 0);

  const statements: D1PreparedStatement[] = [];
  for (const topic of SUGGESTED_TOPICS) {
    position += 1;
    statements.push(env.DB.prepare(
      'INSERT OR IGNORE INTO topics (slug, name, description, position, enabled) VALUES (?, ?, ?, ?, 1)'
    ).bind(topic.slug, topic.names.en, '', position));
  }
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);

  await logAudit(env, {
    actor, action: 'topic.suggested', targetType: 'topic',
    details: { inserted, offered: SUGGESTED_TOPICS.length }
  });

  return noStoreJson({
    ok: true,
    inserted,
    message: inserted === 0
      ? 'The suggested topics already exist.'
      : `Inserted ${inserted} suggested topic${inserted === 1 ? '' : 's'}.`
  }, 201);
}