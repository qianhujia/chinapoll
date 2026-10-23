// Admin settings API: list, update (single and bulk), initialize.

import { DEFAULT_PUBLIC_SETTINGS } from '../../worker/api/settings';
import { runPublisher, testGitHubConnection } from '../../worker/services/publisher';
import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import {
  SETTING_KEYS,
  SETTING_CATEGORIES_LIST,
  isSettingKey,
  validateSettingValue,
  maskSettingValue,
  getSettingCategory,
  getSettingLabel,
  getSettingDescription,
  getSettingType,
  getSettingEnumOptions,
  getSettingDefaultApi,
  isSettingPublicApi,
  isSettingSecretApi,
  auditDetailsForSetting,
  type SettingKey,
} from '../lib/settings';
import {
  getSettingsByCategory,
  getSettingSchema,
  SETTING_CATEGORIES,
} from '../../shared/settings';

interface SettingRow {
  key: string;
  value: string | null;
  updated_at: number | null;
}

interface SettingDetail {
  key: SettingKey;
  label: string;
  description?: string;
  type: string;
  category: string;
  value: string | null;
  maskedValue: string | null;
  isSet: boolean;
  isSecret: boolean;
  isPublic: boolean;
  defaultValue: string | number | boolean;
  enumOptions?: { value: string; label: string }[];
  min?: number;
  max?: number;
  updatedAt: string | null;
}

interface CategoryDetail {
  category: string;
  label: string;
  description: string;
  settings: SettingDetail[];
}

export async function handleSettingsRequest(request: Request, url: URL, env: AdminEnv, actor: AdminActor): Promise<Response> {
  if (url.pathname === '/api/admin/settings/initialize') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return initializeSettings(env, actor);
  }

  if (url.pathname === '/api/admin/settings') {
    if (request.method !== 'GET') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return listSettings(env);
  }

  if (url.pathname === '/api/admin/settings/bulk') {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return bulkUpdateSettings(request, env, actor);
  }

  // The publish actions are explicit paths and must be matched before the
  // generic per-setting key route below.
  if (url.pathname === '/api/admin/settings/publish/test') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return testPublish(env, actor);
  }

  if (url.pathname === '/api/admin/settings/publish/run') {
    if (request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return publishNow(env, actor);
  }

  const keyMatch = url.pathname.match(/^\/api\/admin\/settings\/([^/]+)$/);
  if (keyMatch) {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return Response.json({ message: 'method not allowed' }, { status: 405 });
    }
    return updateSetting(decodeURIComponent(keyMatch[1]), request, env, actor);
  }

  return Response.json({ message: 'not found' }, { status: 404 });
}

async function listSettings(env: AdminEnv): Promise<Response> {
  const result = await env.DB.prepare(
    'SELECT key, value, updated_at FROM settings'
  ).all<SettingRow>();

  const stored = new Map<string, SettingRow>();
  for (const row of result.results ?? []) {
    stored.set(row.key, row);
  }

  // Build categorized settings using shared schema
  const categories: CategoryDetail[] = SETTING_CATEGORIES_LIST.map((category) => ({
    category,
    label: SETTING_CATEGORIES[category].label,
    description: SETTING_CATEGORIES[category].description,
    settings: [],
  }));

  const categoryMap = new Map(categories.map((c) => [c.category, c]));

  const settings = SETTING_KEYS.map((key) => {
    const row = stored.get(key);
    const schema = getSettingSchema(key);
    const detail: SettingDetail = {
      key,
      label: getSettingLabel(key),
      description: getSettingDescription(key),
      type: getSettingType(key) ?? 'string',
      category: getSettingCategory(key) ?? 'advanced',
      value: row?.value ?? null,
      maskedValue: maskSettingValue(key, row?.value ?? null),
      isSet: row !== undefined,
      isSecret: isSettingSecretApi(key),
      isPublic: isSettingPublicApi(key),
      defaultValue: getSettingDefaultApi(key) ?? '',
      enumOptions: getSettingEnumOptions(key),
      min: schema?.min,
      max: schema?.max,
      updatedAt: row?.updated_at ? new Date(row.updated_at * 1000).toISOString() : null,
    };

    const cat = categoryMap.get(detail.category);
    if (cat) cat.settings.push(detail);

    return detail;
  });

  return Response.json({
    categories,
    settings,
  }, {
    headers: { 'cache-control': 'no-store' }
  });
}

async function bulkUpdateSettings(request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  const updates = body as Record<string, string>;
  if (!updates || Object.keys(updates).length === 0) {
    return Response.json({ message: 'no settings provided' }, { status: 400 });
  }

  const results: Array<{ key: string; ok: boolean; message?: string; error?: string }> = [];

  for (const [key, rawValue] of Object.entries(updates)) {
    if (!isSettingKey(key)) {
      results.push({ key, ok: false, error: `unknown setting key "${key}"` });
      continue;
    }

    // If value is empty, use the default value (auto-initialize missing settings)
    let valueToValidate = String(rawValue);
    if (valueToValidate === '') {
      const defaultVal = getSettingDefaultApi(key);
      valueToValidate = defaultVal !== undefined ? String(defaultVal) : '';
    }

    const validation = validateSettingValue(key, valueToValidate);
    if (!validation.ok) {
      results.push({ key, ok: false, error: validation.error });
      continue;
    }

    try {
      await upsertSetting(env, key, validation.value);
      await logAudit(env, {
        actor, action: 'setting.update', targetType: 'setting', targetId: key,
        details: auditDetailsForSetting(key, validation.value)
      });
      results.push({ key, ok: true, message: `Set ${key}.` });
    } catch (error) {
      results.push({ key, ok: false, error: error instanceof Error ? error.message : 'Failed to update setting.' });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({
    ok: failed === 0,
    results,
    message: failed === 0 ? 'All settings saved.' : `${failed} setting(s) failed to save.`,
  }, { status: failed === 0 ? 200 : 422 });
}

async function updateSetting(key: string, request: Request, env: AdminEnv, actor: AdminActor): Promise<Response> {
  if (!isSettingKey(key)) {
    return Response.json({ message: `unknown setting key "${key}"` }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'invalid JSON' }, { status: 400 });
  }

  const rawValue = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).value
    : undefined;
  if (rawValue === undefined || rawValue === null) {
    return Response.json({ message: 'a "value" field is required' }, { status: 400 });
  }

  // If value is empty, use the default value (auto-initialize missing settings)
  let valueToValidate = String(rawValue);
  if (valueToValidate === '') {
    const defaultVal = getSettingDefaultApi(key);
    valueToValidate = defaultVal !== undefined ? String(defaultVal) : '';
  }

  const validation = validateSettingValue(key, valueToValidate);
  if (!validation.ok) {
    return Response.json({ message: validation.error }, { status: 422 });
  }

  await upsertSetting(env, key, validation.value);

  await logAudit(env, {
    actor, action: 'setting.update', targetType: 'setting', targetId: key,
    details: auditDetailsForSetting(key, validation.value)
  });

  return Response.json({
    ok: true,
    key,
    value: maskSettingValue(key, validation.value),
    message: `Set ${key}.`
  });
}

async function initializeSettings(env: AdminEnv, actor: AdminActor): Promise<Response> {
  const insert = env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const statements = SETTING_KEYS.map((key) => insert.bind(key, String(getSettingDefaultApi(key) ?? '')));
  const results = await env.DB.batch(statements);
  const inserted = results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);

  await logAudit(env, { actor, action: 'setting.initialize', details: { inserted } });

  return Response.json({
    ok: true,
    inserted,
    message: `Initialized ${inserted} missing setting(s).`
  });
}

export async function upsertSetting(env: AdminEnv, key: SettingKey, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).bind(key, value).run();
}

// Publish functions
async function testPublish(env: AdminEnv, actor: AdminActor): Promise<Response> {
  const result = await testGitHubConnection(env);
  await logAudit(env, {
    actor,
    action: 'setting.publish_test',
    targetType: 'setting',
    targetId: 'publish_repository',
    details: { ok: result.ok, write: result.write, status: result.status }
  });
  return Response.json({
    ok: result.ok,
    write: result.write,
    status: result.status,
    message: result.message
  }, { headers: { 'cache-control': 'no-store' } });
}

async function publishNow(env: AdminEnv, actor: AdminActor): Promise<Response> {
  const result = await runPublisher(env);
  await logAudit(env, {
    actor,
    action: 'setting.publish_run',
    targetType: 'setting',
    targetId: 'publish_repository',
    details: { skipped: result.skipped, pollsUpdated: result.pollsUpdated, ok: result.ok }
  });
  const message = result.skipped
    ? `Publish skipped: ${result.reason ?? 'not configured'}.`
    : result.ok
      ? `Published ${result.pollsUpdated} poll file(s).`
      : `Publish failed: ${result.error ?? 'unknown error'}`;
  return Response.json({
    ok: result.ok,
    skipped: result.skipped,
    pollsUpdated: result.pollsUpdated,
    commitSha: result.commitSha,
    error: result.error ?? null,
    message
  }, { status: result.ok ? 200 : 502, headers: { 'cache-control': 'no-store' } });
}