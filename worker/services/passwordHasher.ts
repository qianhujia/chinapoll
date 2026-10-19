// Durable Object that owns PBKDF2 password hashing for both Workers.
//
// Password hashing is CPU-heavy (600,000 PBKDF2 iterations), so it is
// deliberately kept off the request Worker's CPU path: the caller awaits this
// object, which performs the derivation with its own CPU budget, and the request
// Worker only pays for the round trip. Every hash is routed through one
// well-known instance, which also serialises hashing and so acts as a natural
// throttle against credential brute force, and keeps the stored format in one
// place. The object keeps no state; it is SQLite-backed for a predictable
// storage backend but never reads or writes storage.

import { PBKDF2_ITERATIONS, checkPasswordHash, derivePasswordHash } from '../../shared/password';

export interface PasswordHasherEnv {
  PASSWORD_HASHER: DurableObjectNamespace;
}

// The single instance that handles every hash.
const INSTANCE_NAME = 'password-hasher';
const HASHER_URL = 'https://password-hasher/';

interface HasherRequest {
  op: 'hash' | 'verify';
  password?: string;
  stored?: string;
  iterations?: number;
}

export class PasswordHasher {
  async fetch(request: Request): Promise<Response> {
    let body: HasherRequest;
    try {
      body = await request.json() as HasherRequest;
    } catch {
      return Response.json({ message: 'invalid JSON' }, { status: 400 });
    }

    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      return Response.json({ message: 'password is required' }, { status: 400 });
    }

    if (body.op === 'hash') {
      const iterations = Number.isSafeInteger(body.iterations) && (body.iterations as number) > 0
        ? Number(body.iterations)
        : PBKDF2_ITERATIONS;
      return Response.json({ hash: await derivePasswordHash(password, iterations) });
    }

    if (body.op === 'verify') {
      const stored = typeof body.stored === 'string' ? body.stored : '';
      return Response.json({ ok: await checkPasswordHash(password, stored) });
    }

    return Response.json({ message: 'unknown operation' }, { status: 400 });
  }
}

async function callHasher(env: PasswordHasherEnv, body: HasherRequest): Promise<Record<string, unknown>> {
  const stub = env.PASSWORD_HASHER.get(env.PASSWORD_HASHER.idFromName(INSTANCE_NAME));
  const response = await stub.fetch(HASHER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`password hasher failed with status ${response.status}`);
  }
  return await response.json() as Record<string, unknown>;
}

// Hashes a password through the PasswordHasher Durable Object.
export async function hashPassword(env: PasswordHasherEnv, password: string): Promise<string> {
  if (!password) throw new Error('password is required');
  const result = await callHasher(env, { op: 'hash', password });
  const hash = result.hash;
  if (typeof hash !== 'string') throw new Error('password hasher returned no hash');
  return hash;
}

// Verifies a password against a stored hash through the PasswordHasher Durable
// Object. A malformed stored value is reported as a mismatch.
export async function verifyPassword(
  env: PasswordHasherEnv,
  password: string,
  stored: string
): Promise<boolean> {
  if (!password || !stored) return false;
  const result = await callHasher(env, { op: 'verify', password, stored });
  return result.ok === true;
}
