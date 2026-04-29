import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, coachbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* Empty-fixture sibling for coach-settings.test.ts (L9 audit) */

describe('CoachByte SettingsPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-settings-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('user-owned exercises returns [] for a fresh user (only globals visible)', async () => {
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id,name,user_id')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'user exercises');
    expect(data).toEqual([]);
  });

  it('global exercises remain visible to a fresh user', async () => {
    // SettingsPage shows global + user-owned merged. If global is empty
    // here, the seed migration is broken — fail loud.
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id,name')
      .is('user_id', null)
      .order('name');

    const data = assertQuerySucceeds(result, 'global exercises');
    expect(data.length).toBeGreaterThan(0);
    expect(data.map((e: any) => e.name)).toEqual(expect.arrayContaining(['Squat', 'Bench Press']));
  });

  it('user_settings exposes default values (or no row) for a fresh user', async () => {
    // The activation trigger may auto-create a user_settings row with
    // defaults. Either way the page must render — either no-row (empty
    // case) OR a row with the default values.
    const result = await coachbyte(ctx.client)
      .from('user_settings')
      .select('user_id,default_rest_seconds,bar_weight_lbs,available_plates')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'user_settings');
    expect(data.length).toBeLessThanOrEqual(1);
    if (data.length === 1) {
      // Defaults from migration 20260303030035_coachbyte_tables.sql:
      // default_rest_seconds=90, bar_weight_lbs=45, plates=[45,35,25,10,5,2.5]
      expect(Number(data[0].default_rest_seconds)).toBe(90);
      expect(Number(data[0].bar_weight_lbs)).toBe(45);
    }
  });
});
