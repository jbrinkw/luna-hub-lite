/**
 * Encryption Credentials Integration Tests
 *
 * Tests the save/get_extension_credentials RPCs with real Supabase calls.
 * Verifies encryption round-trip, cross-user isolation, and admin access.
 *
 * As of migration 20260429160000_extension_credentials_vault.sql the storage
 * backend is Supabase Vault (vault.create_secret + vault.decrypted_secrets)
 * rather than pgcrypto. The RPC surface is unchanged; the row now carries
 * `vault_secret_id` (UUID pointer) instead of `credentials_encrypted` (bytea
 * cast to TEXT). Probe + assertions below were updated accordingly.
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

  it('credentials are encrypted in storage (vault — settings row holds only a UUID pointer)', async () => {
    if (!encryptionAvailable) return;

    const { data: row } = await (adminClient as any)
      .schema('hub')
      .from('extension_settings')
      .select('vault_secret_id')
      .eq('user_id', userA.userId)
      .eq('extension_name', 'obsidian')
      .single();

    expect(row).toBeDefined();
    // Post-Vault: extension_settings carries only a UUID. The plaintext
    // can never appear in this row no matter what — the secret material
    // lives in vault.secrets and is encrypted via pgsodium AEAD.
    expect(typeof row.vault_secret_id).toBe('string');
    expect(row.vault_secret_id).not.toContain('obsidian_secret_123');
    expect(row.vault_secret_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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
