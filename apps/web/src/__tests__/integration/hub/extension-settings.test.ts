/**
 * Integration coverage for `hub.extension_settings` post-Vault migration.
 *
 * As of 20260429160000_extension_credentials_vault.sql:
 *   * The `credentials_encrypted` column was DROPPED. The new column is
 *     `vault_secret_id UUID` and points at a row in vault.secrets.
 *   * Direct table writes can still set `enabled`, but credentials may
 *     ONLY be saved via the SECURITY DEFINER RPC
 *     `hub.save_extension_credentials(p_extension_name, p_credentials_json)`,
 *     which calls `vault.create_secret` / `vault.update_secret`.
 *   * Decrypted reads go through `hub.get_extension_credentials(name)` —
 *     never via direct selection (the secret is never exposed in
 *     `hub.extension_settings`).
 *   * `hub.has_extension_credentials(name)` is the RLS-safe boolean check
 *     for the UI's "Credentials configured" badge.
 *   * `hub.clear_extension_credentials(name)` nulls the pointer AND deletes
 *     the underlying vault.secrets row.
 *
 * These tests pin: enable/disable, credential save+read roundtrip via vault,
 * has_extension_credentials behavior, clear_extension_credentials behavior,
 * post-migration verification that the legacy plaintext column is gone, and
 * RLS isolation across users.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('Extension settings (Vault-backed)', () => {
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

  it('save_extension_credentials stores secret in vault and returns it via get_extension_credentials', async () => {
    const { userId, client } = await createTestUser('ext-creds-vault');
    userIds.push(userId);

    const credentialsJson = JSON.stringify({ api_token: 'tok_123' });
    const { error: saveErr } = await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'todoist',
      p_credentials_json: credentialsJson,
    });
    expect(saveErr).toBeNull();

    // Decrypt round-trip via vault.decrypted_secrets behind the RPC
    const { data: retrieved, error: getErr } = await (client as any).schema('hub').rpc('get_extension_credentials', {
      p_extension_name: 'todoist',
    });
    expect(getErr).toBeNull();
    expect(retrieved).toBe(credentialsJson);

    const parsed = JSON.parse(retrieved as string);
    expect(parsed.api_token).toBe('tok_123');
  });

  it('extension_settings row holds vault_secret_id, NOT plaintext credentials', async () => {
    const { userId, client } = await createTestUser('ext-no-plaintext');
    userIds.push(userId);

    await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'homeassistant',
      p_credentials_json: JSON.stringify({ url: 'http://ha.local', token: 'tok' }),
    });

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('extension_name, enabled, vault_secret_id')
      .eq('user_id', userId)
      .single();

    // Post-Vault contract: vault_secret_id is a UUID; the legacy
    // credentials_encrypted column has been dropped from the schema.
    expect(typeof data?.vault_secret_id).toBe('string');
    // crude UUID shape check (8-4-4-4-12 hex)
    expect(data?.vault_secret_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // The plaintext column is GONE — selecting it should error rather than
    // returning the secret. This pins the post-migration contract.
    const { error: legacyError } = await client
      .schema('hub')
      .from('extension_settings')
      .select('credentials_encrypted')
      .eq('user_id', userId)
      .single();
    expect(legacyError).not.toBeNull();
  });

  it('has_extension_credentials returns true after save, false before', async () => {
    const { userId, client } = await createTestUser('ext-has-creds');
    userIds.push(userId);

    // Before save → false
    const { data: beforeSave } = await (client as any)
      .schema('hub')
      .rpc('has_extension_credentials', { p_extension_name: 'obsidian' });
    expect(beforeSave).toBe(false);

    await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'obsidian',
      p_credentials_json: JSON.stringify({ vault_path: '/my/vault' }),
    });

    const { data: afterSave } = await (client as any)
      .schema('hub')
      .rpc('has_extension_credentials', { p_extension_name: 'obsidian' });
    expect(afterSave).toBe(true);
  });

  it('save_extension_credentials creates a row even when extension was never enabled', async () => {
    const { userId, client } = await createTestUser('ext-disabled-creds');
    userIds.push(userId);

    // Save without ever upserting an `enabled=true` row first. The RPC
    // should INSERT with enabled=false (the column default in the table)
    // so credential pre-population still works.
    await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'todoist',
      p_credentials_json: JSON.stringify({ api_token: 'pre_enable' }),
    });

    const { data } = await client
      .schema('hub')
      .from('extension_settings')
      .select('enabled, vault_secret_id')
      .eq('user_id', userId)
      .eq('extension_name', 'todoist')
      .single();

    expect(data?.enabled).toBe(false);
    expect(data?.vault_secret_id).not.toBeNull();

    const { data: retrieved } = await (client as any)
      .schema('hub')
      .rpc('get_extension_credentials', { p_extension_name: 'todoist' });
    expect(JSON.parse(retrieved as string).api_token).toBe('pre_enable');
  });

  it('disable extension via plain upsert leaves credentials intact (clear is opt-in)', async () => {
    const { userId, client } = await createTestUser('ext-disable');
    userIds.push(userId);

    await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'obsidian',
      p_credentials_json: JSON.stringify({ vault_path: '/my/vault' }),
    });
    await client
      .schema('hub')
      .from('extension_settings')
      .upsert({ user_id: userId, extension_name: 'obsidian', enabled: true }, { onConflict: 'user_id,extension_name' });

    // Plain upsert toggling enabled=false: enabled flips, credentials stay
    // (the SPA layers the explicit clear_extension_credentials call on top).
    const { error: disableError } = await client
      .schema('hub')
      .from('extension_settings')
      .upsert(
        { user_id: userId, extension_name: 'obsidian', enabled: false },
        { onConflict: 'user_id,extension_name' },
      );
    expect(disableError).toBeNull();

    const { data: stillHasCreds } = await (client as any)
      .schema('hub')
      .rpc('has_extension_credentials', { p_extension_name: 'obsidian' });
    expect(stillHasCreds).toBe(true);
  });

  it('clear_extension_credentials nulls vault_secret_id and removes the secret', async () => {
    const { userId, client } = await createTestUser('ext-clear');
    userIds.push(userId);

    await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'obsidian',
      p_credentials_json: JSON.stringify({ vault_path: '/my/vault' }),
    });

    // Sanity: row exists with a vault_secret_id pointer
    const { data: beforeClear } = await client
      .schema('hub')
      .from('extension_settings')
      .select('vault_secret_id')
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian')
      .single();
    expect(beforeClear?.vault_secret_id).not.toBeNull();

    const { error: clearErr } = await (client as any)
      .schema('hub')
      .rpc('clear_extension_credentials', { p_extension_name: 'obsidian' });
    expect(clearErr).toBeNull();

    const { data: afterClear } = await client
      .schema('hub')
      .from('extension_settings')
      .select('vault_secret_id')
      .eq('user_id', userId)
      .eq('extension_name', 'obsidian')
      .single();
    expect(afterClear?.vault_secret_id).toBeNull();

    const { data: hasAfterClear } = await (client as any)
      .schema('hub')
      .rpc('has_extension_credentials', { p_extension_name: 'obsidian' });
    expect(hasAfterClear).toBe(false);

    // get_extension_credentials returns NULL after clear (no pointer)
    const { data: retrieved } = await (client as any)
      .schema('hub')
      .rpc('get_extension_credentials', { p_extension_name: 'obsidian' });
    expect(retrieved).toBeNull();
  });

  it('save → save (rotate): same vault_secret_id, new payload retrievable', async () => {
    const { userId, client } = await createTestUser('ext-rotate');
    userIds.push(userId);

    await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'todoist',
      p_credentials_json: JSON.stringify({ api_token: 'old' }),
    });
    const { data: row1 } = await client
      .schema('hub')
      .from('extension_settings')
      .select('vault_secret_id')
      .eq('user_id', userId)
      .eq('extension_name', 'todoist')
      .single();
    const idBefore = row1?.vault_secret_id;

    await (client as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'todoist',
      p_credentials_json: JSON.stringify({ api_token: 'new' }),
    });
    const { data: row2 } = await client
      .schema('hub')
      .from('extension_settings')
      .select('vault_secret_id')
      .eq('user_id', userId)
      .eq('extension_name', 'todoist')
      .single();
    expect(row2?.vault_secret_id).toBe(idBefore);

    const { data: retrieved } = await (client as any)
      .schema('hub')
      .rpc('get_extension_credentials', { p_extension_name: 'todoist' });
    expect(JSON.parse(retrieved as string).api_token).toBe('new');
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

  it("RLS: user B's get_extension_credentials cannot read user A's secret", async () => {
    const { userId: userA, client: clientA } = await createTestUser('ext-rls-a-creds');
    const { userId: userB, client: clientB } = await createTestUser('ext-rls-b-reader');
    userIds.push(userA, userB);

    // User A stores credentials
    await (clientA as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'obsidian',
      p_credentials_json: JSON.stringify({ vault_path: '/my/vault' }),
    });

    // User B calls the same RPC (which uses auth.uid() internally)
    // — must return NULL, not user A's secret.
    const { data: retrieved } = await (clientB as any)
      .schema('hub')
      .rpc('get_extension_credentials', { p_extension_name: 'obsidian' });
    expect(retrieved).toBeNull();

    // User A still gets their own back (sanity)
    const { data: ownRetrieved } = await (clientA as any)
      .schema('hub')
      .rpc('get_extension_credentials', { p_extension_name: 'obsidian' });
    expect(JSON.parse(ownRetrieved as string).vault_path).toBe('/my/vault');
  });

  it('RLS: user B cannot UPDATE user A extension settings', async () => {
    const { userId: userA, client: clientA } = await createTestUser('ext-rls-upd-a');
    const { userId: userB, client: clientB } = await createTestUser('ext-rls-upd-b');
    userIds.push(userA, userB);

    await (clientA as any).schema('hub').rpc('save_extension_credentials', {
      p_extension_name: 'obsidian',
      p_credentials_json: JSON.stringify({ vault_path: '/my/vault' }),
    });
    await clientA
      .schema('hub')
      .from('extension_settings')
      .upsert({ user_id: userA, extension_name: 'obsidian', enabled: true }, { onConflict: 'user_id,extension_name' });

    const { data: updateData } = await clientB
      .schema('hub')
      .from('extension_settings')
      .update({ enabled: false })
      .eq('user_id', userA)
      .eq('extension_name', 'obsidian')
      .select();

    expect(updateData).toHaveLength(0);

    // User A's settings are still enabled with credentials intact
    const { data: rowA } = await clientA
      .schema('hub')
      .from('extension_settings')
      .select('enabled, vault_secret_id')
      .eq('user_id', userA)
      .eq('extension_name', 'obsidian')
      .single();
    expect(rowA?.enabled).toBe(true);
    expect(rowA?.vault_secret_id).not.toBeNull();

    const { data: retrieved } = await (clientA as any)
      .schema('hub')
      .rpc('get_extension_credentials', { p_extension_name: 'obsidian' });
    expect(JSON.parse(retrieved as string).vault_path).toBe('/my/vault');
  });
});
