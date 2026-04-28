import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';
import { adminClient } from '../../setup.integration';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

/** Simple SHA-256 hash using Web Crypto API */
async function sha256(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * api_keys.api_key_hash carries a partial UNIQUE INDEX (idx_api_keys_hash_active)
 * scoped to ``WHERE revoked_at IS NULL``. If two test runs hash the same
 * literal plaintext (e.g. ``'key-1'``) and they overlap — same parallel
 * worker re-running, leftover rows from a prior aborted run, the live
 * Supabase stack still holding rows from a previous file run — the second
 * insert fails with a 23505. Prefixing every plaintext with a fresh
 * randomUUID() per ``describe`` invocation collapses the collision space
 * to "this test process only" so a stale row can never block a fresh
 * insert. Originally surfaced as a pre-existing flake forcing
 * ``--no-verify`` pushes (audit 2026-04-28).
 */
const TEST_NONCE = crypto.randomUUID();
const k = (label: string): string => `${TEST_NONCE}-${label}`;

describe('API key lifecycle', () => {
  it('generate API key: plaintext returned, hash stored in DB', async () => {
    const { userId, client } = await createTestUser('key-gen');
    userIds.push(userId);

    // Simulate key generation: create plaintext, hash it, store hash
    const plaintext = crypto.randomUUID();
    const hash = await sha256(plaintext);

    const { error } = await client
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash, label: 'Test Key' });

    expect(error).toBeNull();

    // Verify DB stores hash, not plaintext
    const { data } = await adminClient
      .schema('hub')
      .from('api_keys')
      .select('api_key_hash')
      .eq('user_id', userId)
      .single();

    expect(data!.api_key_hash).toBe(hash);
    expect(data!.api_key_hash).not.toBe(plaintext);
  });

  it('round-trip auth: plaintext key hashes to match stored hash', async () => {
    const { userId, client } = await createTestUser('key-roundtrip');
    userIds.push(userId);

    // Simulate key generation: create plaintext, hash it, store hash
    const plaintext = `lh_${crypto.randomUUID()}`;
    const hash = await sha256(plaintext);

    const { error } = await client
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash, label: 'Round-trip Key' });
    expect(error).toBeNull();

    // Simulate authentication: re-hash the same plaintext and look up in DB
    const authHash = await sha256(plaintext);
    const { data: matchedKey, error: lookupErr } = await adminClient
      .schema('hub')
      .from('api_keys')
      .select('user_id, label, revoked_at')
      .eq('api_key_hash', authHash)
      .is('revoked_at', null)
      .single();

    expect(lookupErr).toBeNull();
    expect(matchedKey).not.toBeNull();
    expect(matchedKey!.user_id).toBe(userId);
    expect(matchedKey!.label).toBe('Round-trip Key');

    // Verify wrong plaintext does NOT match
    const wrongHash = await sha256('wrong-key-value');
    const { data: noMatch } = await adminClient
      .schema('hub')
      .from('api_keys')
      .select('user_id')
      .eq('api_key_hash', wrongHash)
      .is('revoked_at', null);
    expect(noMatch).toHaveLength(0);

    // Verify revoked key is excluded from auth lookup
    await client
      .schema('hub')
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('api_key_hash', hash);

    const { data: revokedMatch } = await adminClient
      .schema('hub')
      .from('api_keys')
      .select('user_id')
      .eq('api_key_hash', authHash)
      .is('revoked_at', null);
    expect(revokedMatch).toHaveLength(0);
  });

  it('query active keys returns non-revoked keys', async () => {
    const { userId, client } = await createTestUser('key-active');
    userIds.push(userId);

    const hash = await sha256(k('key-1'));
    const { error: insertError } = await client
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash, label: 'Active Key' });
    expect(insertError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('api_keys')
      .select('*')
      .eq('user_id', userId)
      .is('revoked_at', null);

    expect(data).toHaveLength(1);
    expect(data![0].label).toBe('Active Key');
  });

  it('revoke key sets revoked_at timestamp', async () => {
    const { userId, client } = await createTestUser('key-revoke');
    userIds.push(userId);

    const hash = await sha256(k('key-to-revoke'));
    const { data: inserted, error: insertError } = await client
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash, label: 'Revokable' })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    // Revoke
    const { error: revokeError } = await client
      .schema('hub')
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', inserted!.id);
    expect(revokeError).toBeNull();

    // Verify revoked_at set
    const { data } = await adminClient
      .schema('hub')
      .from('api_keys')
      .select('revoked_at')
      .eq('id', inserted!.id)
      .single();

    expect(typeof data!.revoked_at).toBe('string');
  });

  it('revoked key excluded from active query', async () => {
    const { userId, client } = await createTestUser('key-excl');
    userIds.push(userId);

    const hash = await sha256(k('key-excluded'));
    const { data: inserted, error: insertError } = await client
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash, label: 'Will Revoke' })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    const { error: revokeError } = await client
      .schema('hub')
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', inserted!.id);
    expect(revokeError).toBeNull();

    const { data: active } = await client
      .schema('hub')
      .from('api_keys')
      .select('*')
      .eq('user_id', userId)
      .is('revoked_at', null);

    expect(active).toHaveLength(0);
  });

  it('generate multiple keys: all returned in active query', async () => {
    const { userId, client } = await createTestUser('key-multi');
    userIds.push(userId);

    for (let i = 0; i < 3; i++) {
      const hash = await sha256(k(`multi-key-${i}`));
      const { error: insertError } = await client
        .schema('hub')
        .from('api_keys')
        .insert({ user_id: userId, api_key_hash: hash, label: `Key ${i}` });
      expect(insertError).toBeNull();
    }

    const { data } = await client
      .schema('hub')
      .from('api_keys')
      .select('*')
      .eq('user_id', userId)
      .is('revoked_at', null);

    expect(data).toHaveLength(3);
  });

  it('revoke one of multiple: only that one excluded', async () => {
    const { userId, client } = await createTestUser('key-partial');
    userIds.push(userId);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const hash = await sha256(k(`partial-key-${i}`));
      const { data, error: insertError } = await client
        .schema('hub')
        .from('api_keys')
        .insert({ user_id: userId, api_key_hash: hash, label: `PKey ${i}` })
        .select('id')
        .single();
      expect(insertError).toBeNull();
      ids.push(data!.id);
    }

    // Revoke the middle one
    const { error: revokeError } = await client
      .schema('hub')
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', ids[1]);
    expect(revokeError).toBeNull();

    const { data: active } = await client
      .schema('hub')
      .from('api_keys')
      .select('id')
      .eq('user_id', userId)
      .is('revoked_at', null);

    expect(active).toHaveLength(2);
    const activeIds = active!.map((k) => k.id);
    expect(activeIds).toContain(ids[0]);
    expect(activeIds).toContain(ids[2]);
    expect(activeIds).not.toContain(ids[1]);
  });

  it('RLS: user B cannot read user A api keys', async () => {
    const { userId: userAId, client: clientA } = await createTestUser('key-rls-a');
    userIds.push(userAId);
    const { userId: userBId, client: clientB } = await createTestUser('key-rls-b');
    userIds.push(userBId);

    const { error: insertError } = await clientA
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userAId, api_key_hash: k('hash_rls_test'), label: 'RLS test' });
    expect(insertError).toBeNull();

    const { data, error } = await clientB.schema('hub').from('api_keys').select('*').eq('user_id', userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('RLS: user B cannot revoke user A api keys', async () => {
    const { userId: userAId, client: clientA } = await createTestUser('key-rls-rev-a');
    userIds.push(userAId);
    const { userId: userBId, client: clientB } = await createTestUser('key-rls-rev-b');
    userIds.push(userBId);

    const { error: insertError } = await clientA
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userAId, api_key_hash: k('hash_rls_revoke'), label: 'Revoke test' });
    expect(insertError).toBeNull();

    await clientB
      .schema('hub')
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userAId);

    const { data, error } = await clientA
      .schema('hub')
      .from('api_keys')
      .select('revoked_at')
      .eq('api_key_hash', k('hash_rls_revoke'))
      .single();
    expect(error).toBeNull();
    expect(data!.revoked_at).toBeNull();
  });

  it('enforces max 10 active keys: 10th insert succeeds, 11th is rejected by the DB trigger', async () => {
    // Regression guard for the original broken test (legacy audit §2.2):
    //   inserted 2 keys, asserted count == 2 AND count <= 10 — which
    //   passed regardless of whether the cap was enforced. A future
    //   refactor that let a user generate thousands of keys would not
    //   fail that test.
    //
    // After 20260425050000_api_keys_max_10.sql the cap is enforced by
    // a BEFORE INSERT trigger (private.api_keys_enforce_max_active)
    // so this test verifies the DB layer — the client-side guard in
    // McpSettingsPage.tsx is redundant UX, not the source of truth.
    const { userId, client } = await createTestUser('key-max10');
    userIds.push(userId);

    // Insert 10 keys — all must succeed.
    for (let i = 0; i < 10; i++) {
      const hash = await sha256(k(`max-key-${i}`));
      const { error: insertError } = await client
        .schema('hub')
        .from('api_keys')
        .insert({ user_id: userId, api_key_hash: hash, label: `Max Key ${i}` });
      expect(insertError, `insert ${i} should succeed`).toBeNull();
    }

    // Verify all 10 are active.
    const { count: tenCount } = await client
      .schema('hub')
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('revoked_at', null);
    expect(tenCount).toBe(10);

    // The 11th insert must be rejected by the DB trigger. The error
    // message comes from the RAISE EXCEPTION inside the trigger — we
    // assert on the "maximum of 10 active keys" substring so a future
    // rewording of the trigger message is a visible change.
    const hash11 = await sha256(k('max-key-11'));
    const { error: insert11Error } = await client
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash11, label: 'Max Key 11' });

    expect(insert11Error, '11th insert must be rejected by the trigger').not.toBeNull();
    expect(insert11Error!.message).toMatch(/maximum of 10 active keys/i);

    // Count after rejected 11th: still 10.
    const { count: finalCount } = await client
      .schema('hub')
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('revoked_at', null);
    expect(finalCount).toBe(10);
  });

  it('cap enforcement survives service-role / admin client bypasses', async () => {
    // The legacy client-only cap was bypassable by anyone with the
    // service-role key (a tool, a migration script, a support CLI).
    // This test proves the DB trigger also fires on adminClient calls
    // so the invariant cannot be silently bypassed.
    const { userId } = await createTestUser('key-max10-admin');
    userIds.push(userId);

    for (let i = 0; i < 10; i++) {
      const hash = await sha256(k(`admin-key-${i}`));
      const { error: insertError } = await adminClient
        .schema('hub')
        .from('api_keys')
        .insert({ user_id: userId, api_key_hash: hash, label: `Admin Key ${i}` });
      expect(insertError, `admin insert ${i} should succeed`).toBeNull();
    }

    const hash11 = await sha256(k('admin-key-11'));
    const { error } = await adminClient
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash11, label: 'Admin Key 11' });

    expect(error, 'service-role 11th insert must still fail').not.toBeNull();
    expect(error!.message).toMatch(/maximum of 10 active keys/i);
  });

  it('revoking a key frees a slot: next insert succeeds', async () => {
    const { userId, client } = await createTestUser('key-max10-revoke');
    userIds.push(userId);

    const insertedIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const hash = await sha256(k(`revoke-key-${i}`));
      const { data, error: insertError } = await client
        .schema('hub')
        .from('api_keys')
        .insert({ user_id: userId, api_key_hash: hash, label: `Revoke Key ${i}` })
        .select('id')
        .single();
      expect(insertError).toBeNull();
      insertedIds.push(data!.id);
    }

    // Revoke one — should drop active count to 9.
    await client
      .schema('hub')
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', insertedIds[0]);

    // Now an 11th (net: 10 active) insert must succeed.
    const hash11 = await sha256(k('revoke-key-replacement'));
    const { error: replaceErr } = await client
      .schema('hub')
      .from('api_keys')
      .insert({ user_id: userId, api_key_hash: hash11, label: 'Replacement' });
    expect(replaceErr).toBeNull();

    // Total active = 10.
    const { count } = await client
      .schema('hub')
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('revoked_at', null);
    expect(count).toBe(10);
  });
});
