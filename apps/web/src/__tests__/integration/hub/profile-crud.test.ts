import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('Profile CRUD', () => {
  it('load profile returns correct default fields', async () => {
    const { userId, client } = await createTestUser('prof-load');
    userIds.push(userId);

    const { data, error } = await client
      .schema('hub')
      .from('profiles')
      .select('display_name, timezone, day_start_hour')
      .eq('user_id', userId)
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({
      timezone: 'America/New_York',
      day_start_hour: 6,
    });
  });

  it('update display_name persists', async () => {
    const { userId, client } = await createTestUser('prof-name');
    userIds.push(userId);

    const { error: updateError } = await client
      .schema('hub')
      .from('profiles')
      .update({ display_name: 'Updated Name' })
      .eq('user_id', userId);

    expect(updateError).toBeNull();

    const { data } = await client.schema('hub').from('profiles').select('display_name').eq('user_id', userId).single();

    expect(data?.display_name).toBe('Updated Name');
  });

  it('update timezone to valid IANA name persists', async () => {
    const { userId, client } = await createTestUser('prof-tz');
    userIds.push(userId);

    const { error: updateError } = await client
      .schema('hub')
      .from('profiles')
      .update({ timezone: 'Europe/London' })
      .eq('user_id', userId);

    expect(updateError).toBeNull();

    const { data } = await client.schema('hub').from('profiles').select('timezone').eq('user_id', userId).single();

    expect(data?.timezone).toBe('Europe/London');
  });

  it('update day_start_hour to valid value persists', async () => {
    const { userId, client } = await createTestUser('prof-dsh');
    userIds.push(userId);

    const { error: updateError } = await client
      .schema('hub')
      .from('profiles')
      .update({ day_start_hour: 0 })
      .eq('user_id', userId);

    expect(updateError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('profiles')
      .select('day_start_hour')
      .eq('user_id', userId)
      .single();

    expect(data?.day_start_hour).toBe(0);
  });

  it('reload after update shows updated values', async () => {
    const { userId, client } = await createTestUser('prof-reload');
    userIds.push(userId);

    const { error: updateError } = await client
      .schema('hub')
      .from('profiles')
      .update({ display_name: 'Reloaded', timezone: 'Asia/Tokyo', day_start_hour: 22 })
      .eq('user_id', userId);

    expect(updateError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('profiles')
      .select('display_name, timezone, day_start_hour')
      .eq('user_id', userId)
      .single();

    expect(data).toMatchObject({
      display_name: 'Reloaded',
      timezone: 'Asia/Tokyo',
      day_start_hour: 22,
    });
  });

  it('update multiple fields at once persists all', async () => {
    const { userId, client } = await createTestUser('prof-multi');
    userIds.push(userId);

    const { error: updateError } = await client
      .schema('hub')
      .from('profiles')
      .update({ display_name: 'Multi', timezone: 'UTC', day_start_hour: 12 })
      .eq('user_id', userId);

    expect(updateError).toBeNull();

    const { data } = await client
      .schema('hub')
      .from('profiles')
      .select('display_name, timezone, day_start_hour')
      .eq('user_id', userId)
      .single();

    expect(data).toMatchObject({
      display_name: 'Multi',
      timezone: 'UTC',
      day_start_hour: 12,
    });
  });

  it('rejects day_start_hour = 25 (CHECK constraint: BETWEEN 0 AND 23)', async () => {
    const { userId, client } = await createTestUser('prof-dsh-high');
    userIds.push(userId);

    const { error } = await client.schema('hub').from('profiles').update({ day_start_hour: 25 }).eq('user_id', userId);

    // Postgres CHECK constraint violation
    expect(error).not.toBeNull();
    expect(error!.code).toBe('23514'); // check_violation
  });

  it('rejects day_start_hour = -1 (CHECK constraint: BETWEEN 0 AND 23)', async () => {
    const { userId, client } = await createTestUser('prof-dsh-neg');
    userIds.push(userId);

    const { error } = await client.schema('hub').from('profiles').update({ day_start_hour: -1 }).eq('user_id', userId);

    // Postgres CHECK constraint violation
    expect(error).not.toBeNull();
    expect(error!.code).toBe('23514'); // check_violation
  });

  it('accepts invalid timezone string (no DB constraint on timezone column)', async () => {
    const { userId, client } = await createTestUser('prof-tz-bad');
    userIds.push(userId);

    // The timezone column is TEXT with no CHECK constraint, so any string is accepted.
    // Validation is the application's responsibility. This documents current behavior.
    const { error: updateError } = await client
      .schema('hub')
      .from('profiles')
      .update({ timezone: 'Not/A/Timezone' })
      .eq('user_id', userId);

    expect(updateError).toBeNull();

    const { data } = await client.schema('hub').from('profiles').select('timezone').eq('user_id', userId).single();

    expect(data?.timezone).toBe('Not/A/Timezone');
  });

  it('RLS: user B cannot read user A profile', async () => {
    const { userId: userAId, client: clientA } = await createTestUser('prof-rls-a');
    userIds.push(userAId);
    const { userId: userBId, client: clientB } = await createTestUser('prof-rls-b');
    userIds.push(userBId);

    // User A has a profile (created by trigger)
    const { data: ownProfile, error: ownError } = await clientA
      .schema('hub')
      .from('profiles')
      .select('user_id')
      .eq('user_id', userAId)
      .single();
    expect(ownError).toBeNull();
    expect(ownProfile).not.toBeNull();

    // User B cannot see User A's profile
    const { data, error } = await clientB.schema('hub').from('profiles').select('user_id').eq('user_id', userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('RLS: user B cannot update user A profile', async () => {
    const { userId: userAId, client: clientA } = await createTestUser('prof-rls-upd-a');
    userIds.push(userAId);
    const { userId: userBId, client: clientB } = await createTestUser('prof-rls-upd-b');
    userIds.push(userBId);

    // User B tries to update User A's profile
    await clientB.schema('hub').from('profiles').update({ display_name: 'HACKED' }).eq('user_id', userAId);

    // Verify User A's profile is unchanged
    const { data, error } = await clientA
      .schema('hub')
      .from('profiles')
      .select('display_name')
      .eq('user_id', userAId)
      .single();
    expect(error).toBeNull();
    expect(data!.display_name).not.toBe('HACKED');
  });
});
