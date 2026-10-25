import { describe, expect, it } from 'vitest';
import { unwrapHex, wrapHex } from '../shared/crypto';
import {
  derivePasswordMaterial,
  formatUserPasswordHash,
  parseUserPasswordHash
} from '../shared/password';
import { authorMark, newAuthorKeyHex, recoveryWrapKeyHex, sessionWrapKeyHex } from '../worker/services/author';

const WRAP_KEY = '1f2e3d4c5b6a798807162534435261708f9e0d1c2b3a495867758493a2b1c0d1';
const AUTHOR_KEY = 'ab'.repeat(32);

describe('wrapHex and unwrapHex', () => {
  it('round-trips a hex secret', async () => {
    const stored = await wrapHex(WRAP_KEY, AUTHOR_KEY);
    expect(stored).toMatch(/^[0-9a-f]{24}:[0-9a-f]+$/);
    expect(await unwrapHex(WRAP_KEY, stored)).toBe(AUTHOR_KEY);
  });

  it('returns null when the wrap key is wrong', async () => {
    const stored = await wrapHex(WRAP_KEY, AUTHOR_KEY);
    const other = 'f'.repeat(64);
    expect(await unwrapHex(other, stored)).toBeNull();
  });

  it('returns null when the ciphertext is tampered with', async () => {
    const stored = await wrapHex(WRAP_KEY, AUTHOR_KEY);
    const [iv, ciphertext] = stored.split(':');
    const flipped = ciphertext[0] === 'a' ? 'b' : 'a';
    expect(await unwrapHex(WRAP_KEY, `${iv}:${flipped}${ciphertext.slice(1)}`)).toBeNull();
  });

  it('returns null for malformed input', async () => {
    expect(await unwrapHex(WRAP_KEY, 'not-a-wrapped-value')).toBeNull();
    expect(await unwrapHex(WRAP_KEY, 'zz:zz')).toBeNull();
  });
});

describe('derivePasswordMaterial', () => {
  it('is deterministic for a fixed salt and splits the verifier from the wrap key', async () => {
    const salt = '00'.repeat(16);
    const first = await derivePasswordMaterial('correct horse battery staple', salt, 10_000);
    const second = await derivePasswordMaterial('correct horse battery staple', salt, 10_000);
    expect(first).toEqual(second);
    expect(first.saltHex).toBe(salt);
    expect(first.verifierHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.wrapKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.verifierHex).not.toBe(first.wrapKeyHex);
  });
});

describe('parseUserPasswordHash', () => {
  it('rejects the admin format', () => {
    expect(parseUserPasswordHash('pbkdf2$100000$00$' + 'ab'.repeat(32))).toBeNull();
  });

  it('accepts the public format', async () => {
    const material = await derivePasswordMaterial('correct horse battery staple', '00'.repeat(16), 10_000);
    const parsed = parseUserPasswordHash(formatUserPasswordHash(material));
    expect(parsed).toEqual({
      iterations: 10_000,
      saltHex: material.saltHex,
      verifierHex: material.verifierHex
    });
  });

  it('rejects a low iteration count or a bad salt', () => {
    expect(parseUserPasswordHash('pbkdf2w$9999$00$' + 'ab'.repeat(32))).toBeNull();
    expect(parseUserPasswordHash('pbkdf2w$100000$$' + 'ab'.repeat(32))).toBeNull();
  });
});

describe('author keys', () => {
  it('generates 32 random bytes as 64 lowercase hex characters', () => {
    expect(newAuthorKeyHex()).toMatch(/^[0-9a-f]{64}$/);
    expect(newAuthorKeyHex()).not.toBe(newAuthorKeyHex());
  });

  it('marks an author key as 64 lowercase hex characters', async () => {
    expect(await authorMark(AUTHOR_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives two keys different marks', async () => {
    const first = await authorMark(AUTHOR_KEY);
    const second = await authorMark('cd'.repeat(32));
    expect(first).not.toBe(second);
  });

  it('derives distinct recovery and session wrap keys', async () => {
    const recovery = await recoveryWrapKeyHex('ABCDEFGH');
    const session = await sessionWrapKeyHex('ab'.repeat(32));
    expect(recovery).toMatch(/^[0-9a-f]{64}$/);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(recovery).not.toBe(session);
  });
});
