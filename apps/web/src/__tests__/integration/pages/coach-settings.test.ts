import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, coachbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

describe('CoachByte SettingsPage queries', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-settings');
    // activate_app('coachbyte') already happened in createPageTestContext,
    // which seeds user_settings row
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // SettingsPage: user_settings query
  // Source: SettingsPage.tsx line 36-41
  //   .from('user_settings')
  //   .select('default_rest_seconds, bar_weight_lbs, available_plates')
  //   .eq('user_id', user.id)
  //   .single()
  // -------------------------------------------------------------------
  it('user_settings query returns default values after activation', async () => {
    const result = await coachbyte(ctx.client)
      .from('user_settings')
      .select('default_rest_seconds, bar_weight_lbs, available_plates')
      .eq('user_id', ctx.userId)
      .single();

    const data = assertQuerySucceeds(result, 'user_settings');
    expect(data).toHaveProperty('default_rest_seconds');
    expect(data).toHaveProperty('bar_weight_lbs');
    expect(data).toHaveProperty('available_plates');

    // Verify defaults from schema
    expect(data.default_rest_seconds).toBe(90);
    expect(Number(data.bar_weight_lbs)).toBe(45);
    expect(Array.isArray(data.available_plates)).toBe(true);
    expect(data.available_plates).toEqual([45, 35, 25, 10, 5, 2.5]);
  });

  // -------------------------------------------------------------------
  // SettingsPage: user_settings update
  // Source: SettingsPage.tsx line 73-81
  //   .from('user_settings')
  //   .update({ default_rest_seconds, bar_weight_lbs, available_plates })
  //   .eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('user_settings update persists changed values', async () => {
    const updatedPlates = [45, 25, 10, 5];

    const updateResult = await coachbyte(ctx.client)
      .from('user_settings')
      .update({
        default_rest_seconds: 120,
        bar_weight_lbs: 35,
        available_plates: updatedPlates as any,
      })
      .eq('user_id', ctx.userId);
    expect(updateResult.error).toBeNull();

    // Verify the update
    const result = await coachbyte(ctx.client)
      .from('user_settings')
      .select('default_rest_seconds, bar_weight_lbs, available_plates')
      .eq('user_id', ctx.userId)
      .single();

    const data = assertQuerySucceeds(result, 'user_settings after update');
    expect(data.default_rest_seconds).toBe(120);
    expect(Number(data.bar_weight_lbs)).toBe(35);
    expect(data.available_plates).toEqual([45, 25, 10, 5]);
  });

  // -------------------------------------------------------------------
  // SettingsPage: exercises query (with user_id for custom badge)
  // Source: SettingsPage.tsx line 56-61
  //   .from('exercises')
  //   .select('exercise_id, name, user_id')
  //   .or(`user_id.is.null,user_id.eq.${user.id}`)
  //   .order('name')
  // -------------------------------------------------------------------
  it('exercises query returns exercise_id, name, user_id (global exercises)', async () => {
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name, user_id')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name');

    const data = assertQuerySucceeds(result, 'exercises with user_id');
    expect(data.length).toBeGreaterThanOrEqual(20); // 20 global seeds

    const first = data[0];
    expect(first).toHaveProperty('exercise_id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('user_id');
    // Global exercises have null user_id
    expect(first.user_id).toBeNull();

    // Verify alphabetical ordering
    for (let i = 1; i < data.length; i++) {
      expect(data[i].name.localeCompare(data[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------
  // SettingsPage: custom exercise insert
  // Source: SettingsPage.tsx line 97-99
  //   .from('exercises')
  //   .insert({ user_id: user.id, name: newExerciseName.trim() })
  // -------------------------------------------------------------------
  it('custom exercise insert creates a user-owned exercise', async () => {
    const insertResult = await coachbyte(ctx.client)
      .from('exercises')
      .insert({ user_id: ctx.userId, name: 'Bulgarian Split Squat' });
    expect(insertResult.error).toBeNull();

    // Verify it appears in the exercises list
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name, user_id')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name');

    const data = assertQuerySucceeds(result, 'exercises after custom insert');
    const custom = data.find((e: any) => e.name === 'Bulgarian Split Squat');
    expect(custom).toBeDefined();
    expect(custom!.user_id).toBe(ctx.userId);
  });

  // -------------------------------------------------------------------
  // SettingsPage: custom exercise delete
  // Source: SettingsPage.tsx line 107-110
  //   .from('exercises')
  //   .delete()
  //   .eq('exercise_id', exerciseId)
  // -------------------------------------------------------------------
  it('custom exercise delete removes user-owned exercise', async () => {
    // First find the custom exercise we just created
    const findResult = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .eq('user_id', ctx.userId)
      .eq('name', 'Bulgarian Split Squat')
      .single();

    const exerciseId = assertQuerySucceeds(findResult, 'find custom exercise').exercise_id;

    // Delete it
    const deleteResult = await coachbyte(ctx.client).from('exercises').delete().eq('exercise_id', exerciseId);
    expect(deleteResult.error).toBeNull();

    // Verify it's gone
    const verifyResult = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .eq('user_id', ctx.userId)
      .eq('name', 'Bulgarian Split Squat');

    const verifyData = assertQuerySucceeds(verifyResult, 'verify delete');
    expect(verifyData.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // SettingsPage: cannot delete global exercises (RLS enforcement)
  // -------------------------------------------------------------------
  it('cannot delete global exercises (RLS blocks it)', async () => {
    // Fetch a global exercise
    const globalResult = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name')
      .is('user_id', null)
      .limit(1)
      .single();

    const globalEx = assertQuerySucceeds(globalResult, 'global exercise lookup');

    // Attempt to delete it — should be silently ignored by RLS (no matching row)
    const deleteResult = await coachbyte(ctx.client).from('exercises').delete().eq('exercise_id', globalEx.exercise_id);

    // No error raised, but the exercise should still exist
    expect(deleteResult.error).toBeNull();

    const verifyResult = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .eq('exercise_id', globalEx.exercise_id)
      .single();

    const verifyData = assertQuerySucceeds(verifyResult, 'verify global still exists');
    expect(verifyData.exercise_id).toBe(globalEx.exercise_id);
  });

  // -------------------------------------------------------------------
  // SettingsPage: insert and reload exercises list (full cycle)
  // This mirrors the addCustomExercise → loadExercises pattern in the page
  // -------------------------------------------------------------------
  it('add + reload exercises list shows new custom exercise', async () => {
    // Insert
    const insertResult = await coachbyte(ctx.client)
      .from('exercises')
      .insert({ user_id: ctx.userId, name: 'Hip Thrust' });
    expect(insertResult.error).toBeNull();

    // Reload (same query as loadExercises)
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name, user_id')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name');

    const data = assertQuerySucceeds(result, 'reload after add');
    const hipThrust = data.find((e: any) => e.name === 'Hip Thrust');
    expect(hipThrust).toBeDefined();
    expect(hipThrust!.user_id).toBe(ctx.userId);

    // Cleanup: delete for test isolation
    await coachbyte(ctx.client).from('exercises').delete().eq('exercise_id', hipThrust!.exercise_id);
  });
});
