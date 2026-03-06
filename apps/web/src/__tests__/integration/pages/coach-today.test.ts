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

describe('CoachByte TodayPage queries', () => {
  let ctx: PageTestContext;
  let seeds: CoachByteSeeds;
  let planId: string;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-today');
    seeds = await seedSplit(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // TodayPage: ensure_daily_plan RPC
  // Source: TodayPage.tsx line 52-53
  //   const { data: planResult, error: planErr } = await coachbyte
  //     .rpc('ensure_daily_plan', { p_day: today });
  // -------------------------------------------------------------------
  it('ensure_daily_plan RPC returns plan_id and status', async () => {
    const today = todayDate();
    const result = await coachbyte(ctx.client).rpc('ensure_daily_plan', { p_day: today });
    const data = assertQuerySucceeds(result, 'ensure_daily_plan');

    expect(typeof data.plan_id).toBe('string');
    expect(data.plan_id.length).toBeGreaterThan(0);
    expect(data.status).toBe('created'); // First call always creates
    planId = data.plan_id;
  });

  // -------------------------------------------------------------------
  // TodayPage: planned_sets query with exercises join
  // Source: TodayPage.tsx line 65-70
  //   .from('planned_sets')
  //   .select('planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, "order", exercises(name)')
  //   .eq('plan_id', result.plan_id)
  //   .order('"order"')
  // -------------------------------------------------------------------
  it('planned_sets query with exercises join returns correct columns', async () => {
    const result = await coachbyte(ctx.client)
      .from('planned_sets')
      .select(
        'planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, "order", exercises(name)',
      )
      .eq('plan_id', planId)
      .order('"order"');

    const data = assertQuerySucceeds(result, 'planned_sets');
    expect(Array.isArray(data)).toBe(true);
    // seedSplit creates 3 template sets (2 Squat + 1 Bench)
    expect(data.length).toBe(3);

    const first = data[0];
    expect(typeof first.planned_set_id).toBe('string');
    expect(typeof first.exercise_id).toBe('string');
    expect(first.target_reps).toBe(5);
    expect(Number(first.target_load)).toBe(225);
    // target_load_percentage can be null
    expect(first.order).toBe(1);
    expect(first.exercises).not.toBeNull();
    expect(typeof first.exercises.name).toBe('string');
    expect(first.exercises.name).toBe('Squat');
  });

  // -------------------------------------------------------------------
  // TodayPage: completed_sets query with exercises join
  // Source: TodayPage.tsx line 73-78
  //   .from('completed_sets')
  //   .select('completed_set_id, planned_set_id, actual_reps, actual_load, completed_at, exercises(name)')
  //   .eq('plan_id', result.plan_id)
  //   .order('completed_at')
  // -------------------------------------------------------------------
  it('completed_sets query with exercises join succeeds (initially empty)', async () => {
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id, planned_set_id, actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', planId)
      .order('completed_at');

    const data = assertQuerySucceeds(result, 'completed_sets');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TodayPage: complete_next_set RPC
  // Source: TodayPage.tsx line 180-181
  //   .rpc('complete_next_set', { p_plan_id: planId, p_reps: reps, p_load: load })
  // -------------------------------------------------------------------
  it('complete_next_set RPC completes a set and returns rest_seconds', async () => {
    const result = await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 225,
    });

    const data = assertQuerySucceeds(result, 'complete_next_set');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    // rest_seconds is null because seedSplit template_sets don't include rest_seconds
    expect(data[0].rest_seconds).toBeNull();
  });

  // -------------------------------------------------------------------
  // TodayPage: completed_sets after completing a set (verify row appeared)
  // -------------------------------------------------------------------
  it('completed_sets query returns the newly completed set with exercise join', async () => {
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id, planned_set_id, actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', planId)
      .order('completed_at');

    const data = assertQuerySucceeds(result, 'completed_sets after complete');
    expect(data.length).toBeGreaterThanOrEqual(1);

    const cs = data[0];
    expect(typeof cs.completed_set_id).toBe('string');
    expect(typeof cs.planned_set_id).toBe('string');
    expect(cs.actual_reps).toBe(5);
    expect(Number(cs.actual_load)).toBe(225);
    expect(typeof cs.completed_at).toBe('string');
    expect(cs.exercises).not.toBeNull();
    expect(cs.exercises.name).toBe('Squat');
  });

  // -------------------------------------------------------------------
  // TodayPage: daily_plans summary query
  // Source: TodayPage.tsx line 109-114
  //   .from('daily_plans')
  //   .select('summary')
  //   .eq('plan_id', result.plan_id)
  //   .single()
  // -------------------------------------------------------------------
  it('daily_plans summary query returns summary field', async () => {
    const result = await coachbyte(ctx.client).from('daily_plans').select('summary').eq('plan_id', planId).single();

    const data = assertQuerySucceeds(result, 'daily_plans summary');
    // Summary is null initially (before any update)
    expect(data.summary).toBeNull();
  });

  // -------------------------------------------------------------------
  // TodayPage: exercises query for ad-hoc form
  // Source: TodayPage.tsx line 124-131
  //   .from('exercises')
  //   .select('exercise_id, name')
  //   .or(`user_id.is.null,user_id.eq.${user.id}`)
  //   .order('name')
  // -------------------------------------------------------------------
  it('exercises query returns global and user exercises', async () => {
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name');

    const data = assertQuerySucceeds(result, 'exercises');
    expect(data.length).toBeGreaterThanOrEqual(1);

    const first = data[0];
    expect(first).toHaveProperty('exercise_id');
    expect(first).toHaveProperty('name');
    expect(typeof first.name).toBe('string');
  });

  // -------------------------------------------------------------------
  // TodayPage: timers query
  // Source: TodayPage.tsx line 137-142
  //   .from('timers')
  //   .select('state, end_time, duration_seconds, elapsed_before_pause')
  //   .eq('user_id', user.id)
  //   .single()
  // -------------------------------------------------------------------
  it('timers query succeeds (no timer initially, PGRST116 expected)', async () => {
    const result = await coachbyte(ctx.client)
      .from('timers')
      .select('state, end_time, duration_seconds, elapsed_before_pause')
      .eq('user_id', ctx.userId)
      .single();

    // No timer row exists yet — Supabase returns PGRST116 for .single() with 0 rows
    // The page handles data === null gracefully (sets DEFAULT_TIMER)
    expect(result.data).toBeNull();
  });

  // -------------------------------------------------------------------
  // TodayPage: timer upsert
  // Source: TodayPage.tsx line 201-210
  //   .from('timers').upsert({ user_id, state: 'running', ... }, { onConflict: 'user_id' })
  // -------------------------------------------------------------------
  it('timer upsert creates a running timer', async () => {
    const endTime = new Date(Date.now() + 90_000).toISOString();
    const upsertResult = await coachbyte(ctx.client).from('timers').upsert(
      {
        user_id: ctx.userId,
        state: 'running',
        end_time: endTime,
        duration_seconds: 90,
        elapsed_before_pause: 0,
      },
      { onConflict: 'user_id' },
    );
    expect(upsertResult.error).toBeNull();

    // Verify timer is now readable
    const result = await coachbyte(ctx.client)
      .from('timers')
      .select('state, end_time, duration_seconds, elapsed_before_pause')
      .eq('user_id', ctx.userId)
      .single();

    const data = assertQuerySucceeds(result, 'timer read after upsert');
    expect(data.state).toBe('running');
    expect(data.duration_seconds).toBe(90);
    expect(data.elapsed_before_pause).toBe(0);
  });

  // -------------------------------------------------------------------
  // TodayPage: timer update (pause)
  // Source: TodayPage.tsx line 218-222
  //   .from('timers')
  //   .update({ state: 'paused', paused_at: ..., elapsed_before_pause: ... })
  //   .eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('timer update for pause works', async () => {
    const pauseResult = await coachbyte(ctx.client)
      .from('timers')
      .update({ state: 'paused', paused_at: new Date().toISOString(), elapsed_before_pause: 10 })
      .eq('user_id', ctx.userId);
    expect(pauseResult.error).toBeNull();

    const result = await coachbyte(ctx.client)
      .from('timers')
      .select('state, elapsed_before_pause')
      .eq('user_id', ctx.userId)
      .single();

    const data = assertQuerySucceeds(result, 'timer after pause');
    expect(data.state).toBe('paused');
    expect(data.elapsed_before_pause).toBe(10);
  });

  // -------------------------------------------------------------------
  // TodayPage: timer delete (reset)
  // Source: TodayPage.tsx line 239
  //   .from('timers').delete().eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('timer delete resets timer', async () => {
    const deleteResult = await coachbyte(ctx.client).from('timers').delete().eq('user_id', ctx.userId);
    expect(deleteResult.error).toBeNull();

    const result = await coachbyte(ctx.client).from('timers').select('state').eq('user_id', ctx.userId).single();

    // No row should exist
    expect(result.data).toBeNull();
  });

  // -------------------------------------------------------------------
  // TodayPage: daily_plans summary update
  // Source: TodayPage.tsx line 269-273
  //   .from('daily_plans')
  //   .update({ summary: value })
  //   .eq('plan_id', planId)
  // -------------------------------------------------------------------
  it('daily_plans summary update persists', async () => {
    const updateResult = await coachbyte(ctx.client)
      .from('daily_plans')
      .update({ summary: 'Great workout today' })
      .eq('plan_id', planId);
    expect(updateResult.error).toBeNull();

    const result = await coachbyte(ctx.client).from('daily_plans').select('summary').eq('plan_id', planId).single();

    const data = assertQuerySucceeds(result, 'summary after update');
    expect(data.summary).toBe('Great workout today');
  });

  // -------------------------------------------------------------------
  // TodayPage: ad-hoc set — daily_plans logical_date query + completed_sets insert
  // Source: TodayPage.tsx line 246-260
  //   .from('daily_plans').select('logical_date').eq('plan_id', planId).single()
  //   .from('completed_sets').insert({ plan_id, user_id, exercise_id, actual_reps, actual_load, logical_date })
  // -------------------------------------------------------------------
  it('ad-hoc set insert via logical_date lookup works', async () => {
    // Get logical_date from plan
    const planResult = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();

    const planData = assertQuerySucceeds(planResult, 'logical_date lookup');
    expect(typeof planData.logical_date).toBe('string');
    expect(planData.logical_date).toBe(todayDate());

    // Pick an exercise from seeds
    const exerciseId = Object.values(seeds.exerciseMap)[0];

    // Insert ad-hoc completed set
    const insertResult = await coachbyte(ctx.client).from('completed_sets').insert({
      plan_id: planId,
      user_id: ctx.userId,
      exercise_id: exerciseId,
      actual_reps: 10,
      actual_load: 100,
      logical_date: planData.logical_date,
    });
    expect(insertResult.error).toBeNull();

    // Verify it appears in completed_sets
    const verifyResult = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id, actual_reps, actual_load')
      .eq('plan_id', planId)
      .eq('actual_reps', 10);

    const verifyData = assertQuerySucceeds(verifyResult, 'ad-hoc set verify');
    expect(verifyData.length).toBe(1);
    expect(Number(verifyData[0].actual_load)).toBe(100);
  });

  // -------------------------------------------------------------------
  // TodayPage: planned_sets update (edit reps/load)
  // Source: TodayPage.tsx line 296-308 — updatePlannedSet
  //   .from('planned_sets')
  //   .update({ [field]: value })
  //   .eq('planned_set_id', plannedSetId)
  // -------------------------------------------------------------------
  it('planned_sets update modifies target_reps and target_load', async () => {
    // Get a planned set
    const { data: sets } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('planned_set_id, target_reps, target_load')
      .eq('plan_id', planId)
      .order('"order"')
      .limit(1);
    expect(sets!.length).toBeGreaterThan(0);
    const setId = sets![0].planned_set_id;

    // Update (EXACT pattern from TodayPage updatePlannedSet)
    const updateResult = await coachbyte(ctx.client)
      .from('planned_sets')
      .update({ target_reps: 8, target_load: 200 })
      .eq('planned_set_id', setId);
    expect(updateResult.error).toBeNull();

    // Verify
    const { data: after } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('target_reps, target_load')
      .eq('planned_set_id', setId)
      .single();
    expect(after!.target_reps).toBe(8);
    expect(Number(after!.target_load)).toBe(200);

    // Restore original values
    await coachbyte(ctx.client)
      .from('planned_sets')
      .update({ target_reps: sets![0].target_reps, target_load: sets![0].target_load })
      .eq('planned_set_id', setId);
  });

  // -------------------------------------------------------------------
  // TodayPage: planned_sets insert (add set to plan)
  // Source: TodayPage.tsx line 319-338 — addPlannedSet
  //   .from('planned_sets')
  //   .insert({ plan_id, user_id, exercise_id, target_reps, target_load, rest_seconds, order })
  // -------------------------------------------------------------------
  it('planned_sets insert adds a new set to the plan', async () => {
    // Get exercise for new set
    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(1);
    expect(exercises!.length).toBeGreaterThan(0);

    // Get current max order
    const { data: existing } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('"order"')
      .eq('plan_id', planId)
      .order('"order"', { ascending: false })
      .limit(1);
    const nextOrder = (existing?.[0]?.order ?? 0) + 1;

    // Insert (EXACT pattern from TodayPage addPlannedSet)
    const insertResult = await coachbyte(ctx.client)
      .from('planned_sets')
      .insert({
        plan_id: planId,
        user_id: ctx.userId,
        exercise_id: exercises![0].exercise_id,
        target_reps: 10,
        target_load: 135,
        rest_seconds: 90,
        order: nextOrder,
      })
      .select('planned_set_id')
      .single();
    expect(insertResult.error).toBeNull();
    expect(insertResult.data).not.toBeNull();

    // Cleanup
    await coachbyte(ctx.client).from('planned_sets').delete().eq('planned_set_id', insertResult.data!.planned_set_id);
  });

  // -------------------------------------------------------------------
  // TodayPage: planned_sets delete
  // Source: TodayPage.tsx line 310-317 — deletePlannedSet
  //   .from('planned_sets').delete().eq('planned_set_id', plannedSetId)
  // -------------------------------------------------------------------
  it('planned_sets delete removes a set from the plan', async () => {
    // Get exercise for temp set
    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(1);

    // Insert a temporary set
    const insertResult = await coachbyte(ctx.client)
      .from('planned_sets')
      .insert({
        plan_id: planId,
        user_id: ctx.userId,
        exercise_id: (exercises as any[])[0].exercise_id,
        target_reps: 5,
        target_load: 100,
        rest_seconds: 60,
        order: 99,
      })
      .select('planned_set_id')
      .single();
    expect(insertResult.error).toBeNull();
    const tempSet = insertResult.data as any;
    expect(tempSet).not.toBeNull();

    // Delete (EXACT pattern from TodayPage deletePlannedSet)
    const deleteResult = await coachbyte(ctx.client)
      .from('planned_sets')
      .delete()
      .eq('planned_set_id', tempSet.planned_set_id);
    expect(deleteResult.error).toBeNull();

    // Verify deleted
    const { data: after } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('planned_set_id')
      .eq('planned_set_id', tempSet.planned_set_id);
    expect((after as any[])!.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TodayPage: completed_sets delete
  // Source: TodayPage.tsx line 485-502 — deleteCompletedSet
  //   .from('completed_sets').delete().eq('completed_set_id', completedSetId)
  // -------------------------------------------------------------------
  it('completed_sets delete removes a completed set', async () => {
    // Get an exercise
    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(1);

    // Insert a completed set directly (ad-hoc style)
    const { data: inserted, error: insertErr } = await coachbyte(ctx.client)
      .from('completed_sets')
      .insert({
        plan_id: planId,
        user_id: ctx.userId,
        exercise_id: (exercises as any[])[0].exercise_id,
        actual_reps: 5,
        actual_load: 225,
      })
      .select('completed_set_id')
      .single();
    expect(insertErr).toBeNull();
    expect(inserted).not.toBeNull();
    const completedSetId = (inserted as any).completed_set_id;

    // Delete (EXACT pattern from TodayPage deleteCompletedSet)
    const deleteResult = await coachbyte(ctx.client)
      .from('completed_sets')
      .delete()
      .eq('completed_set_id', completedSetId);
    expect(deleteResult.error).toBeNull();

    // Verify deleted
    const { data: after } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id')
      .eq('completed_set_id', completedSetId);
    expect((after as any[])!.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TodayPage: daily_plans delete (reset plan)
  // Source: TodayPage.tsx line 504-522 — resetPlan
  //   .from('daily_plans').delete().eq('plan_id', planId)
  // -------------------------------------------------------------------
  it('daily_plans delete resets entire plan (cascade)', async () => {
    // Create a separate plan for a different date
    const testDate = '2026-01-15'; // far-past date, won't conflict
    const { data: newPlan } = await (coachbyte(ctx.client) as any).rpc('ensure_daily_plan', {
      p_day: testDate,
    });
    expect(newPlan).not.toBeNull();

    // Insert a planned set for this plan
    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(1);

    await coachbyte(ctx.client).from('planned_sets').insert({
      plan_id: newPlan.plan_id,
      user_id: ctx.userId,
      exercise_id: exercises![0].exercise_id,
      target_reps: 5,
      target_load: 100,
      order: 1,
    });

    // Delete plan (EXACT pattern from TodayPage resetPlan)
    const deleteResult = await coachbyte(ctx.client).from('daily_plans').delete().eq('plan_id', newPlan.plan_id);
    expect(deleteResult.error).toBeNull();

    // Verify plan deleted
    const { data: after } = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id')
      .eq('plan_id', newPlan.plan_id);
    expect(after!.length).toBe(0);

    // Verify planned sets cascade-deleted
    const { data: setsAfter } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('planned_set_id')
      .eq('plan_id', newPlan.plan_id);
    expect(setsAfter!.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TodayPage: complete_next_set with zero actual_load (bodyweight exercise)
  // -------------------------------------------------------------------
  it('complete_next_set with zero actual_load (bodyweight exercise)', async () => {
    // Create a fresh plan for a different date
    const testDate = '2026-01-20';
    const { data: freshPlan } = await (coachbyte(ctx.client) as any).rpc('ensure_daily_plan', {
      p_day: testDate,
    });
    expect(freshPlan).not.toBeNull();

    // Add a planned set so complete_next_set has something to complete
    const exerciseId = Object.values(seeds.exerciseMap)[0]; // Squat
    await coachbyte(ctx.client).from('planned_sets').insert({
      plan_id: freshPlan.plan_id,
      user_id: ctx.userId,
      exercise_id: exerciseId,
      target_reps: 10,
      target_load: 0,
      order: 1,
    });

    const result = await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: freshPlan.plan_id,
      p_reps: 10,
      p_load: 0,
    });

    const data = assertQuerySucceeds(result, 'complete_next_set bodyweight');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);

    // Verify the completed set stored actual_load = 0
    const { data: completed } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_load, actual_reps')
      .eq('plan_id', freshPlan.plan_id);
    expect(completed).not.toBeNull();
    expect(completed!.length).toBeGreaterThanOrEqual(1);
    expect(Number(completed![0].actual_load)).toBe(0);
    expect(completed![0].actual_reps).toBe(10);

    // Cleanup
    await coachbyte(ctx.client).from('daily_plans').delete().eq('plan_id', freshPlan.plan_id);
  });

  // -------------------------------------------------------------------
  // TodayPage: PR detection — complete_next_set + client-side PR check
  // Source: TodayPage.tsx line 226-248 — handleCompleteSet PR check
  //   Queries completed_sets for same exercise, computes Epley e1RM
  //   If new e1RM > prev best and prev_best > 0 → "NEW PR!" toast
  // -------------------------------------------------------------------
  it('complete_next_set returns data enabling PR detection when new record set', async () => {
    // Use the existing planId (has Squat sets already completed at 225 lb)
    // Complete the 2nd Squat set at heavier weight (300 lb)
    const result = await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 300,
    });

    const data = assertQuerySucceeds(result, 'complete_next_set heavier');
    expect(Array.isArray(data)).toBe(true);

    // Simulate client-side PR detection (same logic as TodayPage)
    const exerciseId = Object.values(seeds.exerciseMap)[0]; // Squat
    const { data: prevSets } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load')
      .eq('exercise_id', exerciseId)
      .eq('user_id', ctx.userId);

    expect(prevSets).not.toBeNull();
    expect(prevSets!.length).toBeGreaterThanOrEqual(2);

    // Compute Epley e1RMs
    const epley = (load: number, reps: number) => {
      if (reps <= 0 || load <= 0) return 0;
      if (reps === 1) return load;
      return Math.round(load * (1 + reps / 30));
    };

    const newE1RM = epley(300, 5); // 300 * (1 + 5/30) = 350
    const prevBests = prevSets!
      .filter((ps: any) => !(ps.actual_reps === 5 && Number(ps.actual_load) === 300))
      .map((ps: any) => epley(Number(ps.actual_load), ps.actual_reps));
    const prevBest = Math.max(0, ...prevBests);

    // 5x300 e1RM = 350, 5x225 e1RM = 263 → NEW PR detected
    expect(newE1RM).toBe(350);
    expect(prevBest).toBeLessThan(newE1RM);
    expect(prevBest).toBeGreaterThan(0); // This triggers "NEW PR!" branch
  });

  // -------------------------------------------------------------------
  // TodayPage: First ever completed set returns 'First record!' PR indicator
  // Source: TodayPage.tsx line 246-248
  //   } else if (newE1RM > 0 && prevBestWithout === 0) {
  //     setPrToast(`First record! ...`)
  // -------------------------------------------------------------------
  it('first ever completed set for exercise triggers first-record branch', async () => {
    // Insert a custom exercise so there are zero completed_sets for it
    const insertExResult = await coachbyte(ctx.client)
      .from('exercises')
      .insert({ user_id: ctx.userId, name: 'Zercher Squat' })
      .select('exercise_id')
      .single();
    expect(insertExResult.error).toBeNull();
    const customExId = insertExResult.data!.exercise_id;

    // Insert a completed set for this brand-new exercise
    const { data: planData } = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();

    await coachbyte(ctx.client).from('completed_sets').insert({
      plan_id: planId,
      user_id: ctx.userId,
      exercise_id: customExId,
      actual_reps: 5,
      actual_load: 135,
      logical_date: planData!.logical_date,
    });

    // Simulate PR detection query (same as TodayPage handleCompleteSet)
    const { data: prevSets } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load')
      .eq('exercise_id', customExId)
      .eq('user_id', ctx.userId);

    expect(prevSets).not.toBeNull();
    // Only 1 set (the one we just inserted)
    expect(prevSets!.length).toBe(1);

    const epley = (load: number, reps: number) => {
      if (reps <= 0 || load <= 0) return 0;
      if (reps === 1) return load;
      return Math.round(load * (1 + reps / 30));
    };

    // Simulate prevBestWithout: exclude the current set
    let prevBestWithout = 0;
    for (const ps of prevSets as any[]) {
      const r = ps.actual_reps;
      const l = Number(ps.actual_load);
      if (r === 5 && l === 135) continue; // skip current set
      const e = epley(l, r);
      if (e > prevBestWithout) prevBestWithout = e;
    }

    const newE1RM = epley(135, 5);
    expect(newE1RM).toBeGreaterThan(0);
    expect(prevBestWithout).toBe(0); // This triggers "First record!" branch

    // Cleanup
    await coachbyte(ctx.client).from('completed_sets').delete().eq('exercise_id', customExId);
    await coachbyte(ctx.client).from('exercises').delete().eq('exercise_id', customExId);
  });

  // -------------------------------------------------------------------
  // TodayPage: delete completed set by completed_set_id
  // Source: TodayPage.tsx line 435 — deleteCompletedSet
  //   .from('completed_sets').delete().eq('completed_set_id', completedSetId)
  // -------------------------------------------------------------------
  it('delete completed set by completed_set_id removes exactly that set', async () => {
    // Insert a temporary completed set
    const exerciseId = Object.values(seeds.exerciseMap)[0];
    const { data: planData } = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();

    const { data: inserted } = await coachbyte(ctx.client)
      .from('completed_sets')
      .insert({
        plan_id: planId,
        user_id: ctx.userId,
        exercise_id: exerciseId,
        actual_reps: 3,
        actual_load: 315,
        logical_date: planData!.logical_date,
      })
      .select('completed_set_id')
      .single();
    expect(inserted).not.toBeNull();
    const csId = inserted!.completed_set_id;

    // Count before delete
    const { data: before } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id')
      .eq('plan_id', planId);
    const countBefore = before!.length;

    // Delete by completed_set_id (EXACT pattern from TodayPage)
    const deleteResult = await coachbyte(ctx.client).from('completed_sets').delete().eq('completed_set_id', csId);
    expect(deleteResult.error).toBeNull();

    // Verify exactly one set removed
    const { data: after } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id')
      .eq('plan_id', planId);
    expect(after!.length).toBe(countBefore - 1);

    // Verify the specific set is gone
    const { data: check } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id')
      .eq('completed_set_id', csId);
    expect(check!.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TodayPage: PR detection query (completed_sets for same exercise)
  // Source: TodayPage.tsx line 257-261 — handleCompleteSet PR check
  //   .from('completed_sets')
  //   .select('actual_reps, actual_load')
  //   .eq('exercise_id', completedExerciseId)
  //   .eq('user_id', user.id)
  // -------------------------------------------------------------------
  it('PR detection: queries previous completed_sets for same exercise', async () => {
    // Get an exercise
    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(1);
    const exerciseId = (exercises as any[])[0].exercise_id;

    // Insert a completed set directly for PR detection
    const { data: inserted, error: insertErr } = await coachbyte(ctx.client)
      .from('completed_sets')
      .insert({
        plan_id: planId,
        user_id: ctx.userId,
        exercise_id: exerciseId,
        actual_reps: 5,
        actual_load: 300,
      })
      .select('completed_set_id')
      .single();
    expect(insertErr).toBeNull();

    // PR detection query (EXACT pattern from TodayPage handleCompleteSet)
    const { data: allSetsForExercise } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load')
      .eq('exercise_id', exerciseId)
      .eq('user_id', ctx.userId);

    expect(allSetsForExercise).not.toBeNull();
    expect((allSetsForExercise as any[])!.length).toBeGreaterThan(0);

    // Each should have reps and load for Epley calculation
    for (const s of allSetsForExercise as any[]) {
      expect(typeof s.actual_reps).toBe('number');
      expect(typeof Number(s.actual_load)).toBe('number');
    }

    // Cleanup
    await coachbyte(ctx.client)
      .from('completed_sets')
      .delete()
      .eq('completed_set_id', (inserted as any).completed_set_id);
  });
});
