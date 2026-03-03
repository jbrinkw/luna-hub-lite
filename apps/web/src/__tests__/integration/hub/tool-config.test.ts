import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('Tool config', () => {
  it('toggle tool enabled -> DB updated', async () => {
    const { userId, client } = await createTestUser('tool-enable');
    userIds.push(userId);

    const { error: upsertError } = await client
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );
    expect(upsertError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('user_tool_config')
      .select('enabled')
      .eq('user_id', userId)
      .eq('tool_name', 'COACHBYTE_LOG_SET')
      .single();

    expect(data?.enabled).toBe(true);
  });

  it('toggle tool disabled -> DB updated', async () => {
    const { userId, client } = await createTestUser('tool-disable');
    userIds.push(userId);

    const { error: enableError } = await client
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );
    expect(enableError).toBeNull();

    const { error: disableError } = await client
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: false },
        { onConflict: 'user_id,tool_name' },
      );
    expect(disableError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('user_tool_config')
      .select('enabled')
      .eq('user_id', userId)
      .eq('tool_name', 'COACHBYTE_LOG_SET')
      .single();

    expect(data?.enabled).toBe(false);
  });

  it('load config returns correct state for all tools', async () => {
    const { userId, client } = await createTestUser('tool-load');
    userIds.push(userId);

    const { error: upsertError } = await client
      .schema('hub')
      .from('user_tool_config')
      .upsert([
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: true },
        { user_id: userId, tool_name: 'CHEFBYTE_SCAN_BARCODE', enabled: false },
      ], { onConflict: 'user_id,tool_name' });
    expect(upsertError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('user_tool_config')
      .select('tool_name, enabled')
      .eq('user_id', userId);

    expect(data).toHaveLength(2);
    const map = new Map(data!.map((r) => [r.tool_name, r.enabled]));
    expect(map.get('COACHBYTE_LOG_SET')).toBe(true);
    expect(map.get('CHEFBYTE_SCAN_BARCODE')).toBe(false);
  });

  it('querying a tool with no config row returns empty (no row = no explicit config)', async () => {
    const { userId, client } = await createTestUser('tool-default');
    userIds.push(userId);

    // No rows have been inserted for this user — query should return empty array.
    // This documents that "no row" means "no explicit config" (defaults are app-side).
    const { data, error } = await client
      .schema('hub')
      .from('user_tool_config')
      .select('tool_name, enabled')
      .eq('user_id', userId)
      .eq('tool_name', 'NEVER_CONFIGURED_TOOL');

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('RLS: user B cannot see user A tool config', async () => {
    const { userId: userA, client: clientA } = await createTestUser('tool-rls-a');
    const { userId: userB, client: clientB } = await createTestUser('tool-rls-b');
    userIds.push(userA, userB);

    const { error: upsertError } = await clientA
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userA, tool_name: 'SECRET_TOOL', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );
    expect(upsertError).toBeNull();

    const { data } = await clientB
      .schema('hub')
      .from('user_tool_config')
      .select('*')
      .eq('tool_name', 'SECRET_TOOL');

    expect(data).toHaveLength(0);
  });

  it('RLS: user B cannot UPDATE user A tool config', async () => {
    const { userId: userA, client: clientA } = await createTestUser('tool-rls-upd-a');
    const { userId: userB, client: clientB } = await createTestUser('tool-rls-upd-b');
    userIds.push(userA, userB);

    // User A creates a tool config with enabled: true
    const { error: upsertError } = await clientA
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userA, tool_name: 'COACHBYTE_get_today_plan', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );
    expect(upsertError).toBeNull();

    // User B attempts to update User A's tool config
    const { data: updateData } = await clientB
      .schema('hub')
      .from('user_tool_config')
      .update({ enabled: false })
      .eq('user_id', userA)
      .eq('tool_name', 'COACHBYTE_get_today_plan')
      .select();

    // RLS blocks the update — no rows matched for User B
    expect(updateData).toHaveLength(0);

    // Verify User A's config is still enabled: true
    const { data } = await clientA
      .schema('hub')
      .from('user_tool_config')
      .select('enabled')
      .eq('user_id', userA)
      .eq('tool_name', 'COACHBYTE_get_today_plan')
      .single();

    expect(data?.enabled).toBe(true);
  });
});
