// Durable Object that owns PBKDF2 password hashing for both Workers.
//
// Password hashing is CPU-heavy — PBKDF2-HMAC-SHA256 at the `PBKDF2_ITERATIONS`
// count in `shared/password.ts` (100,000, because that is the most Cloudflare's
// production WebCrypto accepts for PBKDF2) — so it is deliberately kept off the
// request Worker's CPU path: the caller awaits this
// object, which performs the derivation with its own CPU budget, and the request
// Worker only pays for the round trip. Hashing is spread across a fixed number of
// instances so a single object is neither one queue nor one lockout target for
// every sign-in; the shard is a pure function of the username, so a password is
// always hashed and verified by the same instance. The object keeps no state; it
// is SQLite-backed for a predictable storage backend but never reads or writes
// storage.
//
// Besides `hash` and `verify` for admin accounts, the object answers `derive` for
// public accounts: it returns the derived password material (salt, iterations,
// verifier, and wrap key). The PBKDF2 output itself never leaves the object, so
// the vault secret the material is derived from is never exposed to the caller.

import {
  PBKDF2_ITERATIONS,
  checkPasswordHash,
  derivePasswordHash,
  derivePasswordMaterial,
  type PasswordMaterial
} from '../../shared/password';
import { fromHex, sha256Hex } from '../../shared/crypto';
import { apiError } from '../../shared/http';

export interface PasswordHasherEnv {
  PASSWORD_HASHER: DurableObjectNamespace;
}

// Hashing is spread across this many instances.
const SHARD_COUNT = 16;
const HASHER_URL = 'https://password-hasher/';

interface HasherRequest {
  op: 'hash' | 'verify' | 'derive';
  password?: string;
  stored?: string;
  saltHex?: string;
  iterations?: number;
}

export class PasswordHasher {
  async fetch(request: Request): Promise<Response> {
    let body: HasherRequest;
    try {
      body = await request.json() as HasherRequest;
    } catch {
      return apiError('INVALID_JSON', 400);
    }

    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      return apiError('PASSWORD_REQUIRED', 400);
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

    if (body.op === 'derive') {
      let saltHex: string | undefined;
      if (body.saltHex !== undefined) {
        if (typeof body.saltHex !== 'string' || fromHex(body.saltHex).length === 0) {
          return apiError('BAD_REQUEST', 400);
        }
        saltHex = body.saltHex;
      }
      let iterations: number | undefined;
      if (body.iterations !== undefined) {
        if (!Number.isSafeInteger(body.iterations) || (body.iterations as number) <= 0) {
          return apiError('BAD_REQUEST', 400);
        }
        iterations = Number(body.iterations);
      }
      return Response.json(await derivePasswordMaterial(password, saltHex, iterations));
    }

    return apiError('UNKNOWN_OPERATION', 400);
  }
}

// The shard name for a username: a stable value from `0` to `SHARD_COUNT - 1`.
// The username is hashed first so the shard reveals nothing about the name.
export async function passwordHasherShard(username: string): Promise<string> {
  const digest = await sha256Hex(username.trim().toLowerCase());
  return String(Number.parseInt(digest.slice(0, 8), 16) % SHARD_COUNT);
}

async function callHasher(
  env: PasswordHasherEnv,
  shard: string,
  body: HasherRequest
): Promise<Record<string, unknown>> {
  const stub = env.PASSWORD_HASHER.get(env.PASSWORD_HASHER.idFromName(shard));
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

// Hashes a password through the PasswordHasher Durable Object. The username
// selects the shard.
export async function hashPassword(
  env: PasswordHasherEnv,
  username: string,
  password: string
): Promise<string> {
  if (!password) throw new Error('password is required');
  const result = await callHasher(env, await passwordHasherShard(username), { op: 'hash', password });
  const hash = result.hash;
  if (typeof hash !== 'string') throw new Error('password hasher returned no hash');
  return hash;
}

// Verifies a password against a stored hash through the PasswordHasher Durable
// Object. The username selects the same shard the hash was written with. A
// malformed stored value is reported as a mismatch.
export async function verifyPassword(
  env: PasswordHasherEnv,
  username: string,
  password: string,
  stored: string
): Promise<boolean> {
  if (!password || !stored) return false;
  const result = await callHasher(
    env,
    await passwordHasherShard(username),
    { op: 'verify', password, stored }
  );
  return result.ok === true;
}

// Derives the password material of a public account through the PasswordHasher
// Durable Object. The username selects the same shard the account was created
// with. Passing the stored salt and iteration count re-derives the material for
// a sign-in check; omitting both generates a fresh salt at the current count.
export async function derivePasswordMaterialRemote(
  env: PasswordHasherEnv,
  username: string,
  password: string,
  saltHex?: string,
  iterations?: number
): Promise<PasswordMaterial> {
  if (!password) throw new Error('password is required');
  const body: HasherRequest = { op: 'derive', password };
  if (saltHex !== undefined) body.saltHex = saltHex;
  if (iterations !== undefined) body.iterations = iterations;
  const result = await callHasher(env, await passwordHasherShard(username), body);
  const salt = result.saltHex;
  const verifierHex = result.verifierHex;
  const wrapKeyHex = result.wrapKeyHex;
  const iter = result.iterations;
  if (typeof salt !== 'string' || typeof verifierHex !== 'string'
    || typeof wrapKeyHex !== 'string' || typeof iter !== 'number') {
    throw new Error('password hasher returned no material');
  }
  return { saltHex: salt, iterations: iter, verifierHex, wrapKeyHex };
}
