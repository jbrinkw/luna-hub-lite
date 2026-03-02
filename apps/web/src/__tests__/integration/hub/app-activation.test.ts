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

describe('App activation lifecycle', () => {
  it('activate CoachByte creates app_activations row', async () => {
    const { userId, client } = await createTestUser('act-create');
    userIds.push(userId);

    await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });

    const { data } = await adminClient
      .schema('hub')
      .from('app_activations')
      .select('app_name, user_id')
      .eq('user_id', userId);

    expect(data).toHaveLength(1);
    expect(data![0].app_name).toBe('coachbyte');
  });

  it('deactivate CoachByte removes app_activations row', async () => {
    const { userId, client } = await createTestUser('act-delete');
    userIds.push(userId);

    await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    await client.schema('hub').rpc('deactivate_app', { p_app_name: 'coachbyte' });

    const { data } = await adminClient
      .schema('hub')
      .from('app_activations')
      .select('*')
      .eq('user_id', userId);

    expect(data).toHaveLength(0);
  });

  it('hub profile remains intact after deactivation', async () => {
    const { userId, client } = await createTestUser('act-profile');
    userIds.push(userId);

    await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    await client.schema('hub').rpc('deactivate_app', { p_app_name: 'coachbyte' });

    const { data: profile } = await adminClient
      .schema('hub')
      .from('profiles')
      .select('user_id, timezone')
      .eq('user_id', userId)
      .single();

    expect(profile).not.toBeNull();
    expect(profile!.user_id).toBe(userId);
  });

  it('activate + deactivate + reactivate cycle works cleanly', async () => {
    const { userId, client } = await createTestUser('act-cycle');
    userIds.push(userId);

    await client.schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    await client.schema('hub').rpc('deactivate_app', { p_app_name: 'chefbyte' });
    await client.schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });

    const { data } = await adminClient
      .schema('hub')
      .from('app_activations')
      .select('app_name')
      .eq('user_id', userId);

    expect(data).toHaveLength(1);
    expect(data![0].app_name).toBe('chefbyte');
  });
});
