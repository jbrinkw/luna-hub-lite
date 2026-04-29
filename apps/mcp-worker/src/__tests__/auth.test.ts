/**
 * Unit tests for authenticateApiKey (apps/mcp-worker/src/auth.ts).
 *
 * MCP-HIGH-4.1: Previously there were no unit-level tests for the
 * revoked/expired key or DB-error branches of authenticateApiKey.
 * Coverage only existed in the expensive E2E suite (mcp-worker.test.ts)
 * which requires a live wrangler process.
 *
 * These tests use a minimal fake Supabase client to exercise:
 *   (a) valid key → returns user_id
 *   (b) revoked key (revoked_at set) → returns null (the .is('revoked_at', null)
 *       guard in the query means the row won't be found; DB returns empty).
 *   (c) key not found in DB → returns null
 *   (d) DB error → returns null (not a throw)
 *
 * The fake replicates the exact query chain:
 *   supabase.schema('hub').from('api_keys').select('user_id')
 *     .eq('api_key_hash', hash).is('revoked_at', null).single()
 */

import { describe, it, expect, vi } from 'vitest';
import { authenticateApiKey } from '../auth';

/* ------------------------------------------------------------------ */
/*  Fake Supabase builder factory                                      */
/* ------------------------------------------------------------------ */

type SingleResult = { data: { user_id: string } | null; error: { message: string } | null };

/**
 * Build a minimal fake Supabase client whose chain terminates at .single()
 * with the given result. Spies on each step so we can assert the correct
 * filters were applied.
 */
function makeFake(singleResult: SingleResult) {
  const singleSpy = vi.fn(async () => singleResult);
  const isSpy = vi.fn(() => ({ single: singleSpy }));
  const eqSpy = vi.fn(() => ({ is: isSpy }));
  const selectSpy = vi.fn(() => ({ eq: eqSpy }));
  const fromSpy = vi.fn(() => ({ select: selectSpy }));
  const schemaSpy = vi.fn(() => ({ from: fromSpy }));

  const client = { schema: schemaSpy };
  return { client, schemaSpy, fromSpy, selectSpy, eqSpy, isSpy, singleSpy };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Compute the SHA-256 hex hash of a string — same as production auth.ts. */
async function sha256(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('authenticateApiKey', () => {
  it('(a) returns user_id when the key exists and is not revoked', async () => {
    const apiKey = 'sk-valid-key-12345';
    const expectedHash = await sha256(apiKey);
    const fake = makeFake({ data: { user_id: 'user-abc' }, error: null });

    const result = await authenticateApiKey(fake.client, apiKey);

    expect(result).toBe('user-abc');

    // Verify the query was built correctly.
    expect(fake.schemaSpy).toHaveBeenCalledWith('hub');
    expect(fake.fromSpy).toHaveBeenCalledWith('api_keys');
    expect(fake.selectSpy).toHaveBeenCalledWith('user_id');
    expect(fake.eqSpy).toHaveBeenCalledWith('api_key_hash', expectedHash);
    // The revoked_at guard must use .is() — not .eq() — to handle NULL correctly.
    expect(fake.isSpy).toHaveBeenCalledWith('revoked_at', null);
  });

  it('(b) returns null when the key is revoked (revoked_at is set → DB returns no row)', async () => {
    // When revoked_at IS NOT null, the .is('revoked_at', null) filter means
    // the DB returns no matching row → single() returns { data: null, error: ... }.
    // We simulate this with data: null, error: PGRST116-style.
    const fake = makeFake({ data: null, error: { message: 'no rows' } });

    const result = await authenticateApiKey(fake.client, 'sk-revoked-key');

    expect(result).toBeNull();
  });

  it('(c) returns null when the key hash is not found in DB', async () => {
    const fake = makeFake({ data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } });

    const result = await authenticateApiKey(fake.client, 'sk-nonexistent-key');

    expect(result).toBeNull();
  });

  it('(d) returns null on DB error (does not throw)', async () => {
    // A DB error (connection failure, permission denied, etc.) must return
    // null — not propagate the error — so the worker returns 401 rather than 500.
    const fake = makeFake({ data: null, error: { message: 'connection refused' } });

    const result = await authenticateApiKey(fake.client, 'sk-any-key');

    expect(result).toBeNull();
  });

  it('(e) two different keys produce different hashes and are looked up independently', async () => {
    const keyA = 'sk-key-aaa';
    const keyB = 'sk-key-bbb';
    const hashA = await sha256(keyA);
    const hashB = await sha256(keyB);

    expect(hashA).not.toBe(hashB);

    const fakeA = makeFake({ data: { user_id: 'user-a' }, error: null });
    const fakeB = makeFake({ data: { user_id: 'user-b' }, error: null });

    expect(await authenticateApiKey(fakeA.client, keyA)).toBe('user-a');
    expect(await authenticateApiKey(fakeB.client, keyB)).toBe('user-b');

    // Each was queried with its own hash, not the other's.
    expect(fakeA.eqSpy).toHaveBeenCalledWith('api_key_hash', hashA);
    expect(fakeB.eqSpy).toHaveBeenCalledWith('api_key_hash', hashB);
  });
});
