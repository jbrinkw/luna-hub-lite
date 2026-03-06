import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';
import { adminClient } from '../../setup.integration';

/**
 * Integration tests for ActivationGuard query pattern.
 *
 * Source: apps/web/src/components/ActivationGuard.tsx
 *         apps/web/src/shared/AppProvider.tsx
 *
 * ActivationGuard reads `activations` from AppProvider context. AppProvider
 * loads activations via:
 *   supabase.schema('hub').from('app_activations').select('app_name').eq('user_id', user.id)
 *
 * These tests verify that query pattern against a real Supabase instance:
 *   - No activation rows → empty result (guard would redirect)
 *   - With activation row → app_name returned (guard would allow)
 *   - Correct query shape matches what AppProvider expects
 */

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    // Clean up activation rows (cascade from user delete)
    await cleanupUser(id);
  }
  userIds = [];
});

describe('ActivationGuard query pattern', () => {
  it('inactive app query returns no activation row', async () => {
    // A freshly created user has no app_activations → guard redirects
    const { userId, client } = await createTestUser('guard-inactive');
    userIds.push(userId);

    const { data, error } = await client.schema('hub').from('app_activations').select('app_name').eq('user_id', userId);

    expect(error).toBeNull();
    expect(data).toEqual([]);

    // Building the activation map (same logic as AppProvider)
    const map: Record<string, boolean> = {};
    (data || []).forEach((row: any) => {
      map[row.app_name] = true;
    });

    // Guard checks: !activations['chefbyte'] → redirect
    expect(map['chefbyte']).toBeUndefined();
    expect(map['coachbyte']).toBeUndefined();
  });

  it('active app query returns activation row', async () => {
    const { userId, client } = await createTestUser('guard-active');
    userIds.push(userId);

    // Insert an activation row via admin (simulates user activating an app)
    const { error: insertError } = await adminClient
      .schema('hub')
      .from('app_activations')
      .insert({ user_id: userId, app_name: 'chefbyte' });
    expect(insertError).toBeNull();

    // Query activations as the user (same query AppProvider uses)
    const { data, error } = await client.schema('hub').from('app_activations').select('app_name').eq('user_id', userId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].app_name).toBe('chefbyte');

    // Build activation map (AppProvider logic)
    const map: Record<string, boolean> = {};
    (data || []).forEach((row: any) => {
      map[row.app_name] = true;
    });

    // Guard checks: activations['chefbyte'] → allow
    expect(map['chefbyte']).toBe(true);
    // Other apps still inactive
    expect(map['coachbyte']).toBeUndefined();
  });

  it('activation check uses correct query pattern', async () => {
    const { userId, client } = await createTestUser('guard-pattern');
    userIds.push(userId);

    // Activate both apps
    const { error: insertError } = await adminClient
      .schema('hub')
      .from('app_activations')
      .insert([
        { user_id: userId, app_name: 'chefbyte' },
        { user_id: userId, app_name: 'coachbyte' },
      ]);
    expect(insertError).toBeNull();

    // Exact query from AppProvider:
    //   supabase.schema('hub').from('app_activations').select('app_name').eq('user_id', user.id)
    const { data, error } = await client.schema('hub').from('app_activations').select('app_name').eq('user_id', userId);

    expect(error).toBeNull();
    expect(data).toHaveLength(2);

    const appNames = data!.map((row: any) => row.app_name).sort();
    expect(appNames).toEqual(['chefbyte', 'coachbyte']);

    // Build map and verify both are truthy
    const map: Record<string, boolean> = {};
    (data || []).forEach((row: any) => {
      map[row.app_name] = true;
    });
    expect(map['chefbyte']).toBe(true);
    expect(map['coachbyte']).toBe(true);
  });
});
