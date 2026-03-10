import { describe, it, expect, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@luna-hub/db-types';
import { createTestUser, cleanupUser } from '../../test-helpers';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../setup.integration';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T extends { error: any }>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await fn();
    if (!result.error) return result;
    const msg = result.error?.message ?? '';
    if (!msg.includes('rate limit') && !msg.includes('Rate limit')) return result;
    if (attempt === 4) return result;
    await sleep(1000 * Math.pow(2, attempt));
  }
  throw new Error('Unreachable');
}

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('AccountPage queries', () => {
  // ---------------------------------------------------------------
  // AccountPage: profile load
  // Source: AccountPage.tsx
  //   .from('profiles').select('display_name, timezone, day_start_hour').eq('user_id', userId).single()
  // ---------------------------------------------------------------
  it('loads profile with display_name, timezone, day_start_hour', async () => {
    const { userId, client } = await createTestUser('acct-load');
    userIds.push(userId);

    const { data, error } = await client
      .schema('hub')
      .from('profiles')
      .select('display_name, timezone, day_start_hour')
      .eq('user_id', userId)
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    // display_name may be null for a new profile; timezone and day_start_hour always have defaults
    expect(data!.display_name === null || typeof data!.display_name === 'string').toBe(true);
    expect(typeof data!.timezone).toBe('string');
    expect(typeof data!.day_start_hour).toBe('number');
  });

  // ---------------------------------------------------------------
  // AccountPage: profile update
  // Source: AccountPage.tsx
  //   .from('profiles').update({ display_name, timezone, day_start_hour }).eq('user_id', userId)
  // ---------------------------------------------------------------
  it('updates profile display_name, timezone, day_start_hour', async () => {
    const { userId, client } = await createTestUser('acct-update');
    userIds.push(userId);

    const { error: updateError } = await client
      .schema('hub')
      .from('profiles')
      .update({
        display_name: 'Test User Updated',
        timezone: 'America/New_York',
        day_start_hour: 6,
      })
      .eq('user_id', userId);
    expect(updateError).toBeNull();

    // Verify
    const { data } = await client
      .schema('hub')
      .from('profiles')
      .select('display_name, timezone, day_start_hour')
      .eq('user_id', userId)
      .single();
    expect(data!.display_name).toBe('Test User Updated');
    expect(data!.timezone).toBe('America/New_York');
    expect(data!.day_start_hour).toBe(6);
  });

  // ---------------------------------------------------------------
  // AccountPage: password change
  // Source: AccountPage.tsx
  //   supabase.auth.updateUser({ password: newPassword })
  // ---------------------------------------------------------------
  it('changes password via auth.updateUser', async () => {
    const { userId, email, client } = await createTestUser('acct-pw');
    userIds.push(userId);

    const newPassword = 'new-password-456';
    const { error } = await client.auth.updateUser({ password: newPassword });
    expect(error).toBeNull();

    // Verify: sign in with new password
    const freshClient = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await withRetry(() =>
      freshClient.auth.signInWithPassword({ email, password: newPassword }),
    );
    expect(signInErr).toBeNull();

    // Restore original password for cleanup
    const { error: restoreErr } = await freshClient.auth.updateUser({ password: 'test-password-123' });
    expect(restoreErr).toBeNull();
  });
});
