import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('Extension settings', () => {
  it('enable extension creates row', async () => {
    const { userId, client } = await createTestUser('ext-enable');
    userIds.push(userId);

    const { error: upsertError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert({ user_id: userId, extension_name: 'obsidian', enabled: true }, { onConflict: 'user_id,extension_name' });

    expect(upsertError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('enabled')
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian')
      .single();

    expect(data?.enabled).toBe(true);
  });

  // Note: credentials_encrypted stores plaintext JSON. The column is TEXT with no
  // encryption trigger, pgcrypto, or Supabase Vault integration. The name is aspirational.
  // Encryption via Supabase Vault is deferred to post-MVP.
  it('save credentials stores value (plaintext — encryption deferred to post-MVP)', async () => {
    const { userId, client } = await createTestUser('ext-creds');
    userIds.push(userId);

    const { error: upsertError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        {
          user_id: userId,
          extension_name: 'todoist',
          enabled: true,
          credentials_encrypted: JSON.stringify({ api_token: 'tok_123' }),
        },
        { onConflict: 'user_id,extension_name' },
      );

    expect(upsertError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('credentials_encrypted')
      .eq('user_id', userId)
      .eq('extension_name', 'todoist')
      .single();

    // Value is stored as-is (plaintext JSON) — no encryption transformation
    expect(data?.credentials_encrypted).toBe(JSON.stringify({ api_token: 'tok_123' }));
    const parsed = JSON.parse(data!.credentials_encrypted!);
    expect(parsed.api_token).toBe('tok_123');
  });

  it('load returns correct enabled state and credential status', async () => {
    const { userId, client } = await createTestUser('ext-load');
    userIds.push(userId);

    const { error: upsertError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        {
          user_id: userId,
          extension_name: 'homeassistant',
          enabled: true,
          credentials_encrypted: JSON.stringify({ url: 'http://ha.local', token: 'tok' }),
        },
        { onConflict: 'user_id,extension_name' },
      );

    expect(upsertError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('extension_name, enabled, credentials_encrypted')
      .eq('user_id', userId)
      .single();

    expect(data?.enabled).toBe(true);
    expect(typeof data?.credentials_encrypted).toBe('string');
    expect(data!.credentials_encrypted!.length).toBeGreaterThan(0);
    // Verify actual credential content, not just truthiness
    const parsed = JSON.parse(data!.credentials_encrypted!);
    expect(parsed).toEqual({ url: 'http://ha.local', token: 'tok' });
  });

  it('disable extension updates row', async () => {
    const { userId, client } = await createTestUser('ext-disable');
    userIds.push(userId);

    const { error: enableError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert({ user_id: userId, extension_name: 'obsidian', enabled: true }, { onConflict: 'user_id,extension_name' });

    expect(enableError).toBeNull();

    const { error: disableError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        { user_id: userId, extension_name: 'obsidian', enabled: false },
        { onConflict: 'user_id,extension_name' },
      );

    expect(disableError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('enabled')
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian')
      .single();

    expect(data?.enabled).toBe(false);
  });

  it('save credentials for disabled extension still stores', async () => {
    const { userId, client } = await createTestUser('ext-disabled-creds');
    userIds.push(userId);

    const { error: upsertError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        {
          user_id: userId,
          extension_name: 'todoist',
          enabled: false,
          credentials_encrypted: JSON.stringify({ api_token: 'pre_enable' }),
        },
        { onConflict: 'user_id,extension_name' },
      );

    expect(upsertError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('enabled, credentials_encrypted')
      .eq('user_id', userId)
      .eq('extension_name', 'todoist')
      .single();

    expect(data?.enabled).toBe(false);
    // Verify actual content, not just truthiness
    const parsed = JSON.parse(data!.credentials_encrypted!);
    expect(parsed.api_token).toBe('pre_enable');
  });

  it('clear credentials removes credential value', async () => {
    const { userId, client } = await createTestUser('ext-clear');
    userIds.push(userId);

    // Set credentials first
    const { error: upsertError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        {
          user_id: userId,
          extension_name: 'obsidian',
          enabled: true,
          credentials_encrypted: JSON.stringify({ vault_path: '/my/vault' }),
        },
        { onConflict: 'user_id,extension_name' },
      );

    expect(upsertError).toBeNull();

    // Clear credentials
    const { error: clearError } = await client
      .schema('hub')
      .from('extension_settings')
      .update({ credentials_encrypted: null })
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian');

    expect(clearError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('credentials_encrypted')
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian')
      .single();

    expect(data?.credentials_encrypted).toBeNull();
  });

  it('RLS: user B cannot see user A extension settings', async () => {
    const { userId: userA, client: clientA } = await createTestUser('ext-rls-a');
    const { userId: userB, client: clientB } = await createTestUser('ext-rls-b');
    userIds.push(userA, userB);

    const { error: upsertError } = await clientA
      .schema('hub')
      .from('extension_settings')
      .upsert({ user_id: userA, extension_name: 'obsidian', enabled: true }, { onConflict: 'user_id,extension_name' });

    expect(upsertError).toBeNull();

    const { data } = await clientB.schema('hub').from('extension_settings').select('*');

    expect(data).toHaveLength(0);
  });

  it('RLS: user B cannot UPDATE user A extension settings', async () => {
    const { userId: userA, client: clientA } = await createTestUser('ext-rls-upd-a');
    const { userId: userB, client: clientB } = await createTestUser('ext-rls-upd-b');
    userIds.push(userA, userB);

    // User A saves extension settings with enabled: true and credentials
    const { error: upsertError } = await clientA
      .schema('hub')
      .from('extension_settings')
      .upsert(
        {
          user_id: userA,
          extension_name: 'obsidian',
          enabled: true,
          credentials_encrypted: JSON.stringify({ vault_path: '/my/vault' }),
        },
        { onConflict: 'user_id,extension_name' },
      );
    expect(upsertError).toBeNull();

    // User B attempts to update User A's extension settings
    const { data: updateData } = await clientB
      .schema('hub')
      .from('extension_settings')
      .update({ enabled: false })
      .eq('user_id', userA)
      .eq('extension_name', 'obsidian')
      .select();

    // RLS blocks the update — no rows matched for User B
    expect(updateData).toHaveLength(0);

    // Verify User A's settings are still enabled: true with credentials intact
    const { data } = await clientA
      .schema('hub')
      .from('extension_settings')
      .select('enabled, credentials_encrypted')
      .eq('user_id', userA)
      .eq('extension_name', 'obsidian')
      .single();

    expect(data?.enabled).toBe(true);
    const parsed = JSON.parse(data!.credentials_encrypted!);
    expect(parsed.vault_path).toBe('/my/vault');
  });
});
