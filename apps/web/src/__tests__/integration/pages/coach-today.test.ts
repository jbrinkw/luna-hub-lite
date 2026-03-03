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

    expect(data).toHaveProperty('plan_id');
    expect(data).toHaveProperty('status');
    expect(['created', 'existing']).toContain(data.status);
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
    expect(data.length).toBeGreaterThanOrEqual(1);

    const first = data[0];
    expect(first).toHaveProperty('planned_set_id');
    expect(first).toHaveProperty('exercise_id');
    expect(first).toHaveProperty('target_reps');
    expect(first).toHaveProperty('target_load');
    expect(first).toHaveProperty('target_load_percentage');
    expect(first).toHaveProperty('rest_seconds');
    expect(first).toHaveProperty('order');
    expect(first).toHaveProperty('exercises');
    expect(first.exercises).toHaveProperty('name');
    expect(typeof first.exercises.name).toBe('string');
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
    // rest_seconds can be a number or null (null when last set)
    expect(data[0]).toHaveProperty('rest_seconds');
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
    expect(cs).toHaveProperty('completed_set_id');
    expect(cs).toHaveProperty('planned_set_id');
    expect(cs.actual_reps).toBe(5);
    expect(Number(cs.actual_load)).toBe(225);
    expect(cs).toHaveProperty('completed_at');
    expect(cs.exercises).toHaveProperty('name');
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
    expect(data).toHaveProperty('summary');
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
    expect(planData).toHaveProperty('logical_date');

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
});
