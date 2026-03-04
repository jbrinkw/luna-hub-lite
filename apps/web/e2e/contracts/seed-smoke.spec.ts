import { test, expect } from '@playwright/test';
import { seedFullAndLogin } from '../helpers/seed';
import { countDbRows } from '../helpers/assertions';

test.describe('Seed smoke tests', () => {
  test('global exercises exist after DB start (20 exercises with user_id IS NULL)', async ({ page }) => {
    const { cleanup, client } = await seedFullAndLogin(page, 'seed-ex');
    try {
      const count = await countDbRows(client, 'coachbyte', 'exercises', { user_id: null });
      expect(count).toBe(20);
    } finally {
      await cleanup();
    }
  });

  test('module activation seeds default locations (Fridge, Pantry, Freezer)', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'seed-loc');
    try {
      const chef = (client as any).schema('chefbyte');
      const { data: locations, error } = await chef
        .from('locations')
        .select('name')
        .eq('user_id', userId)
        .order('name');

      expect(error).toBeNull();
      expect(locations).not.toBeNull();

      const names = locations!.map((l: any) => l.name).sort();
      expect(names).toEqual(['Freezer', 'Fridge', 'Pantry']);
    } finally {
      await cleanup();
    }
  });

  test('module activation seeds default user_config for chefbyte (empty initially)', async ({ page }) => {
    // activate_app for chefbyte seeds locations but NOT user_config rows.
    // user_config is populated via UI/seed helpers. Verify the table is accessible
    // and starts empty for a fresh activation (no default rows seeded by activate_app).
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'seed-cfg');
    try {
      const count = await countDbRows(client, 'chefbyte', 'user_config', { user_id: userId });
      // activate_app does not seed user_config, so count should be 0 for a fresh user
      expect(count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('module activation seeds default rest_seconds for coachbyte', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'seed-rest');
    try {
      const coach = (client as any).schema('coachbyte');
      const { data, error } = await coach
        .from('user_settings')
        .select('default_rest_seconds, bar_weight_lbs')
        .eq('user_id', userId)
        .single();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.default_rest_seconds).toBe(90);
      expect(Number(data!.bar_weight_lbs)).toBeCloseTo(45, 0);
    } finally {
      await cleanup();
    }
  });

  test('split template_sets JSONB has required fields', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'seed-split');
    try {
      const coach = (client as any).schema('coachbyte');

      // Fetch global exercises to build a split
      const { data: exercises } = await coach.from('exercises').select('exercise_id, name').is('user_id', null);

      const squat = exercises!.find((e: any) => e.name === 'Squat');
      const bench = exercises!.find((e: any) => e.name === 'Bench Press');
      expect(squat).toBeTruthy();
      expect(bench).toBeTruthy();

      // Insert a split with template_sets
      const today = new Date();
      const weekday = today.getDay();
      const templateSets = [
        { exercise_id: squat!.exercise_id, target_reps: 5, target_load: 225, order: 1 },
        { exercise_id: bench!.exercise_id, target_reps: 8, target_load: 185, order: 2 },
      ];

      const { data: split, error: insertErr } = await coach
        .from('splits')
        .insert({
          user_id: userId,
          weekday,
          template_sets: templateSets,
          split_notes: 'Seed smoke test split',
        })
        .select('split_id, template_sets')
        .single();

      expect(insertErr).toBeNull();
      expect(split).not.toBeNull();

      // Verify template_sets JSONB has the required fields
      const sets = split!.template_sets as any[];
      expect(sets).toHaveLength(2);

      for (const s of sets) {
        expect(s).toHaveProperty('exercise_id');
        expect(s).toHaveProperty('target_reps');
        expect(s).toHaveProperty('target_load');
        expect(s).toHaveProperty('order');

        // Verify types/values are reasonable
        expect(typeof s.exercise_id).toBe('string');
        expect(typeof s.target_reps).toBe('number');
        expect(typeof s.target_load).toBe('number');
        expect(typeof s.order).toBe('number');
        expect(s.target_reps).toBeGreaterThan(0);
        expect(s.order).toBeGreaterThan(0);
      }

      // Verify ordering is correct
      expect(sets[0].order).toBe(1);
      expect(sets[1].order).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
