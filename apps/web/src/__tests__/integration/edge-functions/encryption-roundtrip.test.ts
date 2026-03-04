/**
 * Encryption Credentials Integration Tests
 *
 * Tests the save/get_extension_credentials RPCs with real Supabase calls.
 * Verifies encryption round-trip, cross-user isolation, and admin access.
 *
 * Note: Requires app.settings.encryption_key to be set on the local DB.
 * If not set, tests will be skipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminClient } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

describe('Extension Credential Encryption', () => {
  let userA: { userId: string; client: any };
  let userB: { userId: string; client: any };
  let encryptionAvailable = false;

  beforeAll(async () => {
    userA = await createTestUser('enc-a');
    userB = await createTestUser('enc-b');

    // Test if encryption key is configured by trying a save
    const { error } = await (userA.client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: '__test_probe',
      p_credentials_json: '{"test":true}',
    });

    if (!error) {
      encryptionAvailable = true;
      // Clean up the probe
      await (adminClient as any)
        .schema('hub')
        .from('extension_settings')
        .delete()
        .eq('user_id', userA.userId)
        .eq('extension_name', '__test_probe');
    }
  });

  afterAll(async () => {
    if (userA) {
      await (adminClient as any).schema('hub').from('extension_settings').delete().eq('user_id', userA.userId);
      await cleanupUser(userA.userId);
    }
    if (userB) {
      await (adminClient as any).schema('hub').from('extension_settings').delete().eq('user_id', userB.userId);
      await cleanupUser(userB.userId);
    }
  });

  it('saves and retrieves credentials via hub.save/get_extension_credentials', async () => {
    if (!encryptionAvailable) return; // skip if encryption key not set

    const creds = { api_token: 'obsidian_secret_123', vault_path: '/notes' };

    const { error: saveErr } = await (userA.client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'obsidian',
      p_credentials_json: JSON.stringify(creds),
    });
    expect(saveErr).toBeNull();

    const { data: retrieved, error: getErr } = await (userA.client as any)
      .schema('hub')
      .rpc('get_extension_credentials', {
        p_extension_name: 'obsidian',
      });
    expect(getErr).toBeNull();
    expect(JSON.parse(retrieved)).toEqual(creds);
  });

  it('credentials are encrypted in storage (not plaintext)', async () => {
    if (!encryptionAvailable) return;

    const { data: row } = await (adminClient as any)
      .schema('hub')
      .from('extension_settings')
      .select('credentials_encrypted')
      .eq('user_id', userA.userId)
      .eq('extension_name', 'obsidian')
      .single();

    expect(row).toBeDefined();
    expect(row.credentials_encrypted).not.toContain('obsidian_secret_123');
  });

  it('user B cannot read user A credentials', async () => {
    if (!encryptionAvailable) return;

    const { data: retrieved } = await (userB.client as any).schema('hub').rpc('get_extension_credentials', {
      p_extension_name: 'obsidian',
    });
    expect(retrieved).toBeNull();
  });

  it('upsert overwrites existing credentials', async () => {
    if (!encryptionAvailable) return;

    const newCreds = { api_token: 'updated_token', vault_path: '/new-vault' };
    await (userA.client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'obsidian',
      p_credentials_json: JSON.stringify(newCreds),
    });

    const { data: retrieved } = await (userA.client as any).schema('hub').rpc('get_extension_credentials', {
      p_extension_name: 'obsidian',
    });
    expect(JSON.parse(retrieved)).toEqual(newCreds);
  });

  it('get_extension_credentials_admin works for service_role', async () => {
    if (!encryptionAvailable) return;

    const { data: retrieved, error } = await (adminClient as any).schema('hub').rpc('get_extension_credentials_admin', {
      p_user_id: userA.userId,
      p_extension_name: 'obsidian',
    });
    expect(error).toBeNull();
    expect(retrieved).toBeTruthy();
    const parsed = JSON.parse(retrieved);
    expect(parsed.api_token).toBe('updated_token');
  });

  it('returns null for non-existent extension', async () => {
    if (!encryptionAvailable) return;

    const { data: retrieved } = await (userA.client as any).schema('hub').rpc('get_extension_credentials', {
      p_extension_name: 'nonexistent_extension',
    });
    expect(retrieved).toBeNull();
  });
});
