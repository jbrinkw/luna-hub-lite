import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  coachbyte,
  seedSplit,
  assertQuerySucceeds,
  todayDate,
  type PageTestContext,
  type CoachByteSeeds,
} from './helpers';

describe('CoachByte PrsPage queries', () => {
  let ctx: PageTestContext;
  let seeds: CoachByteSeeds;
  let planId: string;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-prs');
    seeds = await seedSplit(ctx);

    // Create a daily plan and complete some sets to generate PR data
    const today = todayDate();
    const planResult = await coachbyte(ctx.client).rpc('ensure_daily_plan', { p_day: today });
    assertQuerySucceeds(planResult, 'setup ensure_daily_plan');
    planId = planResult.data.plan_id;

    // Complete all 3 sets from split (2 Squat + 1 Bench)
    await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 225,
    });
    await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 225,
    });
    await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 185,
    });

    // Insert an ad-hoc set with different reps for richer PR data
    const logDateResult = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();

    const logicalDate = logDateResult.data?.logical_date;

    await coachbyte(ctx.client).from('completed_sets').insert({
      plan_id: planId,
      user_id: ctx.userId,
      exercise_id: seeds.exerciseMap['Squat'],
      actual_reps: 3,
      actual_load: 275,
      logical_date: logicalDate,
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // PrsPage: completed_sets query for PR computation
  // Source: PrsPage.tsx line 32-36
  //   .from('completed_sets')
  //   .select('exercise_id, actual_reps, actual_load, exercises(name)')
  //   .eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('completed_sets query returns exercise_id, actual_reps, actual_load, exercises(name)', async () => {
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id, actual_reps, actual_load, exercises(name)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'completed_sets for PRs');
    expect(Array.isArray(data)).toBe(true);
    // We completed 3 planned + 1 ad-hoc = 4 sets
    expect(data.length).toBe(4);

    const first = data[0];
    expect(typeof first.exercise_id).toBe('string');
    expect(typeof first.actual_reps).toBe('number');
    expect(typeof Number(first.actual_load)).toBe('number');
    expect(first.exercises).not.toBeNull();
    expect(typeof first.exercises.name).toBe('string');
    // All exercises should be either Squat or Bench Press
    expect(['Squat', 'Bench Press']).toContain(first.exercises.name);
  });

  // -------------------------------------------------------------------
  // PrsPage: verify PR data can be grouped by exercise (mirrors client-side logic)
  // Source: PrsPage.tsx line 44-84 — groups by exercise_id, finds best load per rep count
  // -------------------------------------------------------------------
  it('PR data groups correctly by exercise with rep bests', async () => {
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id, actual_reps, actual_load, exercises(name)')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'PR grouping') as any[];

    // Group by exercise (same logic as PrsPage)
    const exerciseMap = new Map<string, { name: string; repBests: Map<number, number> }>();
    for (const cs of data) {
      const id = cs.exercise_id;
      const name = cs.exercises?.name ?? 'Unknown';
      const reps = cs.actual_reps;
      const load = Number(cs.actual_load);

      if (!exerciseMap.has(id)) {
        exerciseMap.set(id, { name, repBests: new Map() });
      }
      const entry = exerciseMap.get(id)!;
      const current = entry.repBests.get(reps) ?? 0;
      if (load > current) {
        entry.repBests.set(reps, load);
      }
    }

    // Should have 2 exercises: Squat + Bench Press
    expect(exerciseMap.size).toBe(2);

    const squatId = seeds.exerciseMap['Squat'];
    const benchId = seeds.exerciseMap['Bench Press'];

    // Squat should have 2 rep records: 5x225 and 3x275
    const squatData = exerciseMap.get(squatId);
    expect(squatData).toBeDefined();
    expect(squatData!.name).toBe('Squat');
    expect(squatData!.repBests.get(5)).toBe(225);
    expect(squatData!.repBests.get(3)).toBe(275);

    // Bench should have 1 rep record: 5x185
    const benchData = exerciseMap.get(benchId);
    expect(benchData).toBeDefined();
    expect(benchData!.name).toBe('Bench Press');
    expect(benchData!.repBests.get(5)).toBe(185);
  });

  // -------------------------------------------------------------------
  // PrsPage: exercises query for tracking list
  // Source: PrsPage.tsx line 96-101
  //   .from('exercises')
  //   .select('exercise_id, name')
  //   .or(`user_id.is.null,user_id.eq.${user.id}`)
  //   .order('name')
  // -------------------------------------------------------------------
  it('exercises query returns exercise_id and name, ordered alphabetically', async () => {
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name');

    const data = assertQuerySucceeds(result, 'exercises for PR tracking');
    expect(data.length).toBeGreaterThanOrEqual(1);

    const first = data[0];
    expect(first).toHaveProperty('exercise_id');
    expect(first).toHaveProperty('name');

    // Verify alphabetical ordering
    for (let i = 1; i < data.length; i++) {
      expect(data[i].name.localeCompare(data[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------
  // PrsPage: Epley 1RM formula verification (exported from PrsPage)
  // Source: PrsPage.tsx line 15-19
  //   export function epley1RM(load: number, reps: number): number {
  //     if (reps <= 0 || load <= 0) return 0;
  //     if (reps === 1) return load;
  //     return Math.round(load * (1 + reps / 30));
  //   }
  // -------------------------------------------------------------------
  it('Epley 1RM formula computes correctly from DB data', async () => {
    // This verifies the query data is compatible with the Epley formula
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load')
      .eq('user_id', ctx.userId)
      .eq('exercise_id', seeds.exerciseMap['Squat']);

    const data = assertQuerySucceeds(result, 'squat sets for Epley') as any[];

    // Compute Epley for each set
    const e1rms = data.map((cs: any) => {
      const load = Number(cs.actual_load);
      const reps = cs.actual_reps;
      if (reps <= 0 || load <= 0) return 0;
      if (reps === 1) return load;
      return Math.round(load * (1 + reps / 30));
    });

    // 5x225: Epley = round(225 * (1 + 5/30)) = round(225 * 1.1667) = round(262.5) = 263
    // 3x275: Epley = round(275 * (1 + 3/30)) = round(275 * 1.1) = round(302.5) = 303
    const maxE1rm = Math.max(...e1rms);
    expect(maxE1rm).toBe(303); // 3x275 produces highest e1RM
  });

  // -------------------------------------------------------------------
  // PrsPage: user_settings pr_tracked_exercise_ids save/load
  // Source: PrsPage.tsx line 156-159 — saveTrackedExercises
  //   .from('user_settings').update({ pr_tracked_exercise_ids: ids }).eq('user_id', user.id)
  // Source: PrsPage.tsx line 135 — loadExercisesAndSettings
  //   .from('user_settings').select('pr_tracked_exercise_ids').eq('user_id', user.id).maybeSingle()
  // -------------------------------------------------------------------
  it('user_settings pr_tracked_exercise_ids save and load round-trip', async () => {
    // Get exercises
    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(3);
    expect(exercises!.length).toBeGreaterThanOrEqual(2);

    const trackedIds = [exercises![0].exercise_id, exercises![1].exercise_id];

    // Save (EXACT pattern from PrsPage saveTrackedExercises)
    const updateResult = await coachbyte(ctx.client)
      .from('user_settings')
      .update({ pr_tracked_exercise_ids: trackedIds })
      .eq('user_id', ctx.userId);
    expect(updateResult.error).toBeNull();

    // Load back (EXACT pattern from PrsPage loadExercisesAndSettings)
    const { data: loaded } = await coachbyte(ctx.client)
      .from('user_settings')
      .select('pr_tracked_exercise_ids')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    expect(loaded).not.toBeNull();
    expect(loaded!.pr_tracked_exercise_ids).toEqual(trackedIds);

    // Cleanup - reset to null (default)
    await coachbyte(ctx.client)
      .from('user_settings')
      .update({ pr_tracked_exercise_ids: null })
      .eq('user_id', ctx.userId);
  });

  // -------------------------------------------------------------------
  // PrsPage: completed_sets with date range filter
  // Source: PrsPage.tsx line 45-56 — computePRs with dateRange
  //   .from('completed_sets')
  //   .select('exercise_id, actual_reps, actual_load, exercises(name)')
  //   .eq('user_id', user.id)
  //   .gte('completed_at', cutoffDate.toISOString())
  //   .order('completed_at', { ascending: false })
  // -------------------------------------------------------------------
  it('completed_sets query with date range gte filter', async () => {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const dateStr = ninetyDaysAgo.toISOString();

    // EXACT query from PrsPage (with date range)
    const { data: sets } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id, actual_reps, actual_load, exercises(name)')
      .eq('user_id', ctx.userId)
      .gte('completed_at', dateStr)
      .order('completed_at', { ascending: false });

    expect(sets).not.toBeNull();
    expect(Array.isArray(sets)).toBe(true);
    // We completed 3 planned + 1 ad-hoc = 4 sets in beforeAll, all within 90 days
    expect(sets!.length).toBe(4);

    // Verify each row has the expected shape
    for (const s of sets!) {
      expect(typeof s.exercise_id).toBe('string');
      expect(typeof s.actual_reps).toBe('number');
      expect(typeof Number(s.actual_load)).toBe('number');
      expect(s.exercises).not.toBeNull();
      expect(typeof (s as any).exercises.name).toBe('string');
    }
  });
});
