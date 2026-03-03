import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

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

    const { error: activateError } = await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(activateError).toBeNull();

    const { data, error: readError } = await client
      .schema('hub')
      .from('app_activations')
      .select('app_name, user_id')
      .eq('user_id', userId);
    expect(readError).toBeNull();

    expect(data).toHaveLength(1);
    expect(data![0].app_name).toBe('coachbyte');
  });

  it('deactivate CoachByte removes app_activations row', async () => {
    const { userId, client } = await createTestUser('act-delete');
    userIds.push(userId);

    const { error: activateError } = await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(activateError).toBeNull();
    const { error: deactivateError } = await client.schema('hub').rpc('deactivate_app', { p_app_name: 'coachbyte' });
    expect(deactivateError).toBeNull();

    const { data, error: readError } = await client
      .schema('hub')
      .from('app_activations')
      .select('*')
      .eq('user_id', userId);
    expect(readError).toBeNull();

    expect(data).toHaveLength(0);
  });

  it('hub profile remains intact after deactivation', async () => {
    const { userId, client } = await createTestUser('act-profile');
    userIds.push(userId);

    const { error: activateError } = await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(activateError).toBeNull();
    const { error: deactivateError } = await client.schema('hub').rpc('deactivate_app', { p_app_name: 'coachbyte' });
    expect(deactivateError).toBeNull();

    const { data: profile, error: readError } = await client
      .schema('hub')
      .from('profiles')
      .select('user_id, timezone')
      .eq('user_id', userId)
      .single();
    expect(readError).toBeNull();

    expect(profile).not.toBeNull();
    expect(profile!.user_id).toBe(userId);
  });

  it('activate + deactivate + reactivate cycle works cleanly', async () => {
    const { userId, client } = await createTestUser('act-cycle');
    userIds.push(userId);

    const { error: activateError } = await client.schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    expect(activateError).toBeNull();
    const { error: deactivateError } = await client.schema('hub').rpc('deactivate_app', { p_app_name: 'chefbyte' });
    expect(deactivateError).toBeNull();
    const { error: reactivateError } = await client.schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    expect(reactivateError).toBeNull();

    const { data, error: readError } = await client
      .schema('hub')
      .from('app_activations')
      .select('app_name')
      .eq('user_id', userId);
    expect(readError).toBeNull();

    expect(data).toHaveLength(1);
    expect(data![0].app_name).toBe('chefbyte');
  });

  it('double activation is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const { userId, client } = await createTestUser('act-idempotent');
    userIds.push(userId);

    const { error: firstError } = await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(firstError).toBeNull();

    // Second activation of same app — should succeed silently (no error, no duplicate)
    const { error: secondError } = await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(secondError).toBeNull();

    // Verify still exactly one row (not duplicated)
    const { data, error: readError } = await client
      .schema('hub')
      .from('app_activations')
      .select('app_name')
      .eq('user_id', userId);
    expect(readError).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].app_name).toBe('coachbyte');
  });

  it('activate_app accepts arbitrary app name (no CHECK constraint on app_name)', async () => {
    const { userId, client } = await createTestUser('act-invalid');
    userIds.push(userId);

    // The function uses INSERT with ON CONFLICT — there's no CHECK constraint on app_name,
    // so any text value is accepted. This documents current behavior.
    const { error } = await client.schema('hub').rpc('activate_app', { p_app_name: 'nonexistent_app' });
    expect(error).toBeNull();

    const { data, error: readError } = await client
      .schema('hub')
      .from('app_activations')
      .select('app_name')
      .eq('user_id', userId);
    expect(readError).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].app_name).toBe('nonexistent_app');
  });

  it('RLS: user B cannot see user A activations', async () => {
    const { userId: userAId, client: clientA } = await createTestUser('act-rls-a');
    userIds.push(userAId);
    const { userId: userBId, client: clientB } = await createTestUser('act-rls-b');
    userIds.push(userBId);

    const { error: activateError } = await clientA
      .schema('hub')
      .rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(activateError).toBeNull();

    const { data, error } = await clientB
      .schema('hub')
      .from('app_activations')
      .select('*');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});
