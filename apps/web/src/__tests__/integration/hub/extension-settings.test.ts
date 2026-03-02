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

    await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        { user_id: userId, extension_name: 'obsidian', enabled: true },
        { onConflict: 'user_id,extension_name' },
      );

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('enabled')
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian')
      .single();

    expect(data?.enabled).toBe(true);
  });

  it('save credentials stores encrypted value', async () => {
    const { userId, client } = await createTestUser('ext-creds');
    userIds.push(userId);

    await client
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

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('credentials_encrypted')
      .eq('user_id', userId)
      .eq('extension_name', 'todoist')
      .single();

    expect(data?.credentials_encrypted).toBeTruthy();
    const parsed = JSON.parse(data!.credentials_encrypted!);
    expect(parsed.api_token).toBe('tok_123');
  });

  it('load returns correct enabled state and credential status', async () => {
    const { userId, client } = await createTestUser('ext-load');
    userIds.push(userId);

    await client
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

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('extension_name, enabled, credentials_encrypted')
      .eq('user_id', userId)
      .single();

    expect(data?.enabled).toBe(true);
    expect(data?.credentials_encrypted).toBeTruthy();
  });

  it('disable extension updates row', async () => {
    const { userId, client } = await createTestUser('ext-disable');
    userIds.push(userId);

    await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        { user_id: userId, extension_name: 'obsidian', enabled: true },
        { onConflict: 'user_id,extension_name' },
      );

    await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        { user_id: userId, extension_name: 'obsidian', enabled: false },
        { onConflict: 'user_id,extension_name' },
      );

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

    await client
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

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('enabled, credentials_encrypted')
      .eq('user_id', userId)
      .eq('extension_name', 'todoist')
      .single();

    expect(data?.enabled).toBe(false);
    expect(data?.credentials_encrypted).toBeTruthy();
  });

  it('clear credentials removes credential value', async () => {
    const { userId, client } = await createTestUser('ext-clear');
    userIds.push(userId);

    // Set credentials first
    await client
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

    // Clear credentials
    await client
      .schema('hub')
      .from('extension_settings')
      .update({ credentials_encrypted: null })
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian');

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

    await clientA
      .schema('hub')
      .from('extension_settings')
      .upsert(
        { user_id: userA, extension_name: 'obsidian', enabled: true },
        { onConflict: 'user_id,extension_name' },
      );

    const { data } = await clientB
      .schema('hub')
      .from('extension_settings')
      .select('*');

    expect(data).toHaveLength(0);
  });
});
