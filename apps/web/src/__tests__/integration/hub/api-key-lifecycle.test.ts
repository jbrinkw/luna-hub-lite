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

  it('query active keys returns non-revoked keys', async () => {
    const { userId, client } = await createTestUser('key-active');
    userIds.push(userId);

    const hash = await sha256('key-1');
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

    const hash = await sha256('key-to-revoke');
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

    expect(data!.revoked_at).not.toBeNull();
  });

  it('revoked key excluded from active query', async () => {
    const { userId, client } = await createTestUser('key-excl');
    userIds.push(userId);

    const hash = await sha256('key-excluded');
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
      const hash = await sha256(`multi-key-${i}`);
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
      const hash = await sha256(`partial-key-${i}`);
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
});
