import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

describe('Cross-feature: auth -> activation -> data flow', () => {
  it('activating CoachByte seeds user_settings and allows plan creation', async () => {
    const { userId, client } = await createTestUser('flow-coach-seed');
    userIds.push(userId);

    // Before activation: user_settings should be empty
    const { data: beforeSettings, error: beforeErr } = await client
      .schema('coachbyte')
      .from('user_settings')
      .select('*')
      .eq('user_id', userId);
    expect(beforeErr).toBeNull();
    expect(beforeSettings).toEqual([]);

    // Activate CoachByte
    const { error: activateErr } = await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(activateErr).toBeNull();

    // After activation: user_settings should have defaults
    const { data: afterSettings, error: afterErr } = await client
      .schema('coachbyte')
      .from('user_settings')
      .select('default_rest_seconds, bar_weight_lbs')
      .eq('user_id', userId)
      .single();
    expect(afterErr).toBeNull();
    expect(afterSettings).not.toBeNull();
    expect(afterSettings!.default_rest_seconds).toBe(90);
    expect(Number(afterSettings!.bar_weight_lbs)).toBe(45);

    // ensure_daily_plan should return a plan_id
    const today = new Date().toISOString().split('T')[0];
    const { data: planResult, error: planErr } = await (client.schema('coachbyte') as any).rpc('ensure_daily_plan', {
      p_day: today,
    });
    expect(planErr).toBeNull();
    expect(planResult).not.toBeNull();
    expect(planResult).toHaveProperty('plan_id');
    expect((planResult as any).plan_id).toBeTruthy();
  });

  it('activating ChefByte seeds default location', async () => {
    const { userId, client } = await createTestUser('flow-chef-seed');
    userIds.push(userId);

    // Activate ChefByte
    const { error: activateErr } = await client.schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    expect(activateErr).toBeNull();

    // Default locations should be seeded (Fridge, Pantry, Freezer)
    const { data: locations, error: locErr } = await client
      .schema('chefbyte')
      .from('locations')
      .select('name')
      .eq('user_id', userId);
    expect(locErr).toBeNull();
    expect(locations).not.toBeNull();
    expect(locations!.length).toBeGreaterThanOrEqual(1);

    const locationNames = locations!.map((l) => l.name);
    expect(locationNames).toContain('Fridge');
    expect(locationNames).toContain('Pantry');
    expect(locationNames).toContain('Freezer');
  });

  it('deactivating CoachByte cascade-deletes all module data', async () => {
    const { userId, client } = await createTestUser('flow-coach-deact');
    userIds.push(userId);

    // Activate and create data
    const { error: activateErr } = await client.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
    expect(activateErr).toBeNull();

    // Create a daily plan
    const today = new Date().toISOString().split('T')[0];
    const { data: planResult, error: planErr } = await client
      .schema('coachbyte')
      .rpc('ensure_daily_plan', { p_day: today });
    expect(planErr).toBeNull();
    expect(planResult).toHaveProperty('plan_id');

    // Verify plan exists
    const { data: plansBefore, error: plansBeforeErr } = await client
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id')
      .eq('user_id', userId);
    expect(plansBeforeErr).toBeNull();
    expect(plansBefore!.length).toBeGreaterThanOrEqual(1);

    // Deactivate CoachByte
    const { error: deactivateErr } = await client.schema('hub').rpc('deactivate_app', { p_app_name: 'coachbyte' });
    expect(deactivateErr).toBeNull();

    // user_settings should be empty
    const { data: settingsAfter, error: settingsErr } = await client
      .schema('coachbyte')
      .from('user_settings')
      .select('*')
      .eq('user_id', userId);
    expect(settingsErr).toBeNull();
    expect(settingsAfter).toEqual([]);

    // daily_plans should be empty
    const { data: plansAfter, error: plansAfterErr } = await client
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id')
      .eq('user_id', userId);
    expect(plansAfterErr).toBeNull();
    expect(plansAfter).toEqual([]);
  });

  it('full lifecycle: activate -> use -> deactivate -> reactivate', async () => {
    const { userId, client } = await createTestUser('flow-full-cycle');
    userIds.push(userId);

    // 1. Activate ChefByte
    const { error: activateErr } = await client.schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    expect(activateErr).toBeNull();

    // 2. Insert a product
    const { data: inserted, error: insertErr } = await client
      .schema('chefbyte')
      .from('products')
      .insert({
        user_id: userId,
        name: 'Test Oats',
        servings_per_container: 10,
        calories_per_serving: 150,
        protein_per_serving: 5,
        carbs_per_serving: 27,
        fat_per_serving: 3,
      })
      .select('product_id')
      .single();
    expect(insertErr).toBeNull();
    expect(inserted).not.toBeNull();
    expect(inserted!.product_id).toBeTruthy();

    // 3. Verify product exists
    const { data: productsBefore, error: prodBeforeErr } = await client
      .schema('chefbyte')
      .from('products')
      .select('name')
      .eq('user_id', userId);
    expect(prodBeforeErr).toBeNull();
    expect(productsBefore!.length).toBe(1);
    expect(productsBefore![0].name).toBe('Test Oats');

    // 4. Deactivate ChefByte — cascade deletes all data
    const { error: deactivateErr } = await client.schema('hub').rpc('deactivate_app', { p_app_name: 'chefbyte' });
    expect(deactivateErr).toBeNull();

    // 5. Verify products empty
    const { data: productsAfter, error: prodAfterErr } = await client
      .schema('chefbyte')
      .from('products')
      .select('name')
      .eq('user_id', userId);
    expect(prodAfterErr).toBeNull();
    expect(productsAfter).toEqual([]);

    // 6. Reactivate ChefByte
    const { error: reactivateErr } = await client.schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });
    expect(reactivateErr).toBeNull();

    // 7. Verify default locations re-seeded
    const { data: locations, error: locErr } = await client
      .schema('chefbyte')
      .from('locations')
      .select('name')
      .eq('user_id', userId);
    expect(locErr).toBeNull();
    expect(locations).not.toBeNull();
    expect(locations!.length).toBeGreaterThanOrEqual(1);

    const locationNames = locations!.map((l) => l.name);
    expect(locationNames).toContain('Fridge');
  });
});
