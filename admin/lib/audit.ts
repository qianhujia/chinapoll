// Audit logging for admin actions. Entries deliberately exclude client IP
// addresses and any secret material.

import type { AdminActor, AdminEnv } from '../auth';

export interface AuditEntry {
  action: string;
  actor?: AdminActor | null;
  actorUsername?: string | null;
  targetType?: string;
  targetId?: string | number;
  details?: Record<string, unknown>;
}

export async function logAudit(env: AdminEnv, entry: AuditEntry): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_audit_log (actor_id, actor_username, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      entry.actor?.id ?? null,
      entry.actor?.username ?? entry.actorUsername ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId === undefined ? null : String(entry.targetId),
      entry.details ? JSON.stringify(entry.details) : null
    ).run();
  } catch (error) {
    // A failed audit write must not break the underlying admin operation.
    console.error('Failed to write admin audit log entry:', error instanceof Error ? error.message : error);
  }
}
