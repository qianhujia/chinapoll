import { DEFAULT_PUBLIC_SETTINGS } from '../../worker/api/settings';
import type { AdminActor, AdminEnv } from '../auth';
import { logAudit } from '../lib/audit';
import {
  SECRET_SETTING_KEYS,
  SETTING_KEYS,
  isSettingKey,
  maskSettingValue,
  validateSettingValue,
  type SettingKey
} from '../lib/settings';

interface SettingRow {
  key: string;
  value: string | null;
  updated_at: number | null;
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

  return Response.json({
    settings: SETTING_KEYS.map((key) => {
      const row = stored.get(key);
      return {
        key,
        value: maskSettingValue(key, row?.value ?? null),
        isSet: row !== undefined,
        isSecret: SECRET_SETTING_KEYS.includes(key),
        defaultValue: SECRET_SETTING_KEYS.includes(key) ? '••••••••' : String(DEFAULT_PUBLIC_SETTINGS[key]),
        updatedAt: row?.updated_at ? new Date(row.updated_at * 1000).toISOString() : null
      };
    })
  }, {
    headers: { 'cache-control': 'no-store' }
  });
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

  const validation = validateSettingValue(key, String(rawValue));
  if (!validation.ok) {
    return Response.json({ message: validation.error }, { status: 422 });
  }

  await upsertSetting(env, key, validation.value);

  await logAudit(env, {
    actor, action: 'setting.update', targetType: 'setting', targetId: key,
    // Secret values are never written to the audit log.
    details: SECRET_SETTING_KEYS.includes(key as SettingKey) ? { secret: true } : { value: validation.value }
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
  const statements = SETTING_KEYS.map((key) => insert.bind(key, String(DEFAULT_PUBLIC_SETTINGS[key])));
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
