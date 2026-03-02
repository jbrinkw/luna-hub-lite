import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';
import { adminClient } from '../../setup.integration';

describe('Integration test environment', () => {
  let userId: string | undefined;

  afterEach(async () => {
    if (userId) {
      await cleanupUser(userId);
      userId = undefined;
    }
  });

  it('connects to local Supabase at localhost:54321', async () => {
    // Verify admin client can reach the API
    const { data, error } = await adminClient.auth.admin.listUsers({
      perPage: 1,
    });
    expect(error).toBeNull();
    expect(data).toBeDefined();
  });

  it('createTestUser returns signed-in client + userId', async () => {
    const user = await createTestUser();
    userId = user.userId;

    expect(user.userId).toBeDefined();
    expect(user.email).toMatch(/@test\.com$/);

    // Verify the client is authenticated
    const { data: session } = await user.client.auth.getSession();
    expect(session.session).not.toBeNull();
    expect(session.session?.user.id).toBe(user.userId);
  });

  it('cleanupUser deletes user via admin API (FK cascade)', async () => {
    const user = await createTestUser();

    // Verify profile was auto-created by handle_new_user trigger
    const { data: profile } = await adminClient
      .schema('hub')
      .from('profiles')
      .select('user_id')
      .eq('user_id', user.userId)
      .single();
    expect(profile).not.toBeNull();

    // Cleanup and verify user is gone
    await cleanupUser(user.userId);

    const { data: deletedUser } =
      await adminClient.auth.admin.getUserById(user.userId);
    expect(deletedUser.user).toBeNull();
  });
});
