// Admin poll-category management: list, create, rename, reorder, enable, delete,
// and insert the suggested set. Both admin roles may use every action. Deleting a
// category leaves its polls in place and uncategorised (the column's
// `ON DELETE SET NULL`).

import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import { noStoreJson, readJsonBody, readString } from '../../shared/http';
import {
  CATEGORY_SLUG_PATTERN,
  MAX_CATEGORY_NAME_LENGTH,
  SUGGESTED_CATEGORIES
} from '../../shared/categories';

const MAX_POSITION = 10_000;

interface CategoryRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  enabled: number;
  polls: number;
}

function publicCategory(row: CategoryRow): {
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

export async function handleCategoriesRequest(
  request: Request,
  url: URL,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  if (url.pathname === '/api/admin/categories') {
    if (request.method === 'GET') return listCategories(env);
    if (request.method === 'POST') return createCategory(request, env, actor);
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  if (url.pathname === '/api/admin/categories/suggested') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return insertSuggestedCategories(env, actor);
  }

  const idMatch = url.pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
  if (idMatch) {
    const categoryId = Number(idMatch[1]);
    if (request.method === 'PUT') return updateCategory(categoryId, request, env, actor);
    if (request.method === 'DELETE') return deleteCategory(categoryId, env, actor);
    return Response.json({ message: 'method not allowed' }, { status: 405 });
  }

  return Response.json({ message: 'not found' }, { status: 404 });
}

async function listCategories(env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT c.id, c.slug, c.name, c.position, c.enabled,
            (SELECT COUNT(*) FROM polls p WHERE p.category_id = c.id) AS polls
     FROM categories c
     ORDER BY c.position ASC, c.id ASC`
  ).all<CategoryRow>();

  return noStoreJson({ categories: (result.results ?? []).map(publicCategory) });
}

async function createCategory(request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const slug = readString(body, 'slug').trim().toLowerCase();
  if (!CATEGORY_SLUG_PATTERN.test(slug)) {
    return noStoreJson({
      message: 'slug must be 2 to 40 characters from a-z, 0-9, and hyphen'
    }, 422);
  }
  const name = readString(body, 'name').trim();
  if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) {
    return noStoreJson({ message: `name must contain 1 to ${MAX_CATEGORY_NAME_LENGTH} characters` }, 422);
  }
  const description = body.description !== undefined ? readString(body, 'description').trim() : '';
  if (description && description.length > 500) {
    return noStoreJson({ message: 'description must be at most 500 characters' }, 422);
  }

  const enabledValue = body.enabled === undefined ? true : readBoolean(body.enabled);
  if (enabledValue === null) return noStoreJson({ message: 'enabled must be true or false' }, 422);

  const existing = await env.DB.prepare('SELECT id FROM categories WHERE slug = ?')
    .bind(slug).first<{ id: number }>();
  if (existing) return noStoreJson({ message: `category "${slug}" already exists` }, 409);

  let position: number;
  if (body.position === undefined || body.position === null) {
    const last = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS position FROM categories')
      .first<{ position: number }>();
    position = Number(last?.position ?? 0) + 1;
  } else {
    position = Number(body.position);
    if (!Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION) {
      return noStoreJson({ message: `position must be an integer from 0 to ${MAX_POSITION}` }, 422);
    }
  }

  const result = await env.DB.prepare(
    'INSERT INTO categories (slug, name, description, position, enabled) VALUES (?, ?, ?, ?, ?)'
  ).bind(slug, name, description || null, position, enabledValue ? 1 : 0).run();
  const categoryId = Number(result.meta.last_row_id);

  await logAudit(env, {
    actor, action: 'category.create', targetType: 'category', targetId: categoryId,
    details: { slug, name, description, position, enabled: enabledValue }
  });

  return noStoreJson({
    ok: true,
    category: { id: categoryId, slug, name, description, position, enabled: enabledValue, polls: 0 },
    message: `Created category "${slug}".`
  }, 201);
}

// Renames, reorders, and enables or disables a category. The slug is deliberately
// not editable: it is the public `category=<slug>` identifier.
async function updateCategory(
  categoryId: number,
  request: Request,
  env: AdminEnv,
  actor: AdminActor
): Promise<Response> {
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) {
    return noStoreJson({ message: 'invalid category ID' }, 400);
  }

  const body = await readJsonBody(request);
  if (!body) return noStoreJson({ message: 'invalid JSON' }, 400);

  const existing = await env.DB.prepare(
    'SELECT id, slug, name, description, position, enabled FROM categories WHERE id = ?'
  ).bind(categoryId).first<{ id: number; slug: string; name: string; description: string | null; position: number; enabled: number }>();
  if (!existing) return noStoreJson({ message: `category ${categoryId} was not found` }, 404);

  const updates: string[] = [];
  const binds: unknown[] = [];
  const changes: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = readString(body, 'name').trim();
    if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) {
      return noStoreJson({ message: `name must contain 1 to ${MAX_CATEGORY_NAME_LENGTH} characters` }, 422);
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

  await env.DB.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds, categoryId).run();

  await logAudit(env, {
    actor, action: 'category.update', targetType: 'category', targetId: categoryId,
    details: {
      previous: { name: existing.name, description: existing.description, position: Number(existing.position), enabled: Number(existing.enabled) === 1 },
      ...changes
    }
  });

  const updated = await env.DB.prepare(
    `SELECT c.id, c.slug, c.name, c.position, c.enabled,
            (SELECT COUNT(*) FROM polls p WHERE p.category_id = c.id) AS polls
     FROM categories c WHERE c.id = ?`
  ).bind(categoryId).first<CategoryRow>();

  return noStoreJson({
    ok: true,
    category: updated ? publicCategory(updated) : null,
    message: `Updated category "${existing.slug}".`
  });
}

async function deleteCategory(categoryId: number, env: AdminEnv, actor: AdminActor): Promise<Response> {
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) {
    return noStoreJson({ message: 'invalid category ID' }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT c.id, c.slug, c.name, c.description,
            (SELECT COUNT(*) FROM polls p WHERE p.category_id = c.id) AS polls
     FROM categories c WHERE c.id = ?`
  ).bind(categoryId).first<{ id: number; slug: string; name: string; description: string | null; polls: number }>();
  if (!existing) return noStoreJson({ message: `category ${categoryId} was not found` }, 404);

  // The polls are kept; the foreign key sets their `category_id` to NULL.
  await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(categoryId).run();

  await logAudit(env, {
    actor, action: 'category.delete', targetType: 'category', targetId: categoryId,
    details: { slug: existing.slug, name: existing.name, description: existing.description, uncategorised: Number(existing.polls ?? 0) }
  });

  return noStoreJson({
    ok: true,
    uncategorised: Number(existing.polls ?? 0),
    message: `Deleted category "${existing.slug}".`
  });
}

// Inserts the suggested categories, skipping any slug that already exists.
async function insertSuggestedCategories(env: AdminEnv, actor: AdminActor): Promise<Response> {
  const last = await env.DB.prepare('SELECT COALESCE(MAX(position), 0) AS position FROM categories')
    .first<{ position: number }>();
  let position = Number(last?.position ?? 0);

  const statements: D1PreparedStatement[] = [];
  for (const category of SUGGESTED_CATEGORIES) {
    position += 1;
    statements.push(env.DB.prepare(
      'INSERT OR IGNORE INTO categories (slug, name, description, position, enabled) VALUES (?, ?, ?, ?, 1)'
    ).bind(category.slug, category.names.en, '', position));
  }
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);

  await logAudit(env, {
    actor, action: 'category.suggested', targetType: 'category',
    details: { inserted, offered: SUGGESTED_CATEGORIES.length }
  });

  return noStoreJson({
    ok: true,
    inserted,
    message: inserted === 0
      ? 'The suggested categories already exist.'
      : `Inserted ${inserted} suggested categor${inserted === 1 ? 'y' : 'ies'}.`
  }, 201);
}

