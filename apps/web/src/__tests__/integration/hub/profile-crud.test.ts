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

    await client
      .schema('hub')
      .from('profiles')
      .update({ display_name: 'Updated Name' })
      .eq('user_id', userId);

    const { data } = await client
      .schema('hub')
      .from('profiles')
      .select('display_name')
      .eq('user_id', userId)
      .single();

    expect(data?.display_name).toBe('Updated Name');
  });

  it('update timezone to valid IANA name persists', async () => {
    const { userId, client } = await createTestUser('prof-tz');
    userIds.push(userId);

    await client
      .schema('hub')
      .from('profiles')
      .update({ timezone: 'Europe/London' })
      .eq('user_id', userId);

    const { data } = await client
      .schema('hub')
      .from('profiles')
      .select('timezone')
      .eq('user_id', userId)
      .single();

    expect(data?.timezone).toBe('Europe/London');
  });

  it('update day_start_hour to valid value persists', async () => {
    const { userId, client } = await createTestUser('prof-dsh');
    userIds.push(userId);

    await client
      .schema('hub')
      .from('profiles')
      .update({ day_start_hour: 0 })
      .eq('user_id', userId);

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

    await client
      .schema('hub')
      .from('profiles')
      .update({ display_name: 'Reloaded', timezone: 'Asia/Tokyo', day_start_hour: 22 })
      .eq('user_id', userId);

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

    await client
      .schema('hub')
      .from('profiles')
      .update({ display_name: 'Multi', timezone: 'UTC', day_start_hour: 12 })
      .eq('user_id', userId);

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
});
