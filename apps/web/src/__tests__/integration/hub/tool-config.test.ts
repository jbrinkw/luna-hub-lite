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

    await client
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );

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

    await client
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );

    await client
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: false },
        { onConflict: 'user_id,tool_name' },
      );

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

    await client
      .schema('hub')
      .from('user_tool_config')
      .upsert([
        { user_id: userId, tool_name: 'COACHBYTE_LOG_SET', enabled: true },
        { user_id: userId, tool_name: 'CHEFBYTE_SCAN_BARCODE', enabled: false },
      ], { onConflict: 'user_id,tool_name' });

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

  it('RLS: user B cannot see user A tool config', async () => {
    const { userId: userA, client: clientA } = await createTestUser('tool-rls-a');
    const { userId: userB, client: clientB } = await createTestUser('tool-rls-b');
    userIds.push(userA, userB);

    await clientA
      .schema('hub')
      .from('user_tool_config')
      .upsert(
        { user_id: userA, tool_name: 'SECRET_TOOL', enabled: true },
        { onConflict: 'user_id,tool_name' },
      );

    const { data } = await clientB
      .schema('hub')
      .from('user_tool_config')
      .select('*')
      .eq('tool_name', 'SECRET_TOOL');

    expect(data).toHaveLength(0);
  });
});
