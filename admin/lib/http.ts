// Shared request helpers for the admin Worker API handlers.

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function readString(body: Record<string, unknown> | null, key: string): string {
  if (!body) return '';
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export function noStoreJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', ...headers }
  });
}
