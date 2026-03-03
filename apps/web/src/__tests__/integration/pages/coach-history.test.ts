import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  coachbyte,
  seedSplit,
  assertQuerySucceeds,
  todayDate,
  type PageTestContext,
} from './helpers';

describe('CoachByte HistoryPage queries', () => {
  let ctx: PageTestContext;
  let planId: string;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-history');
    await seedSplit(ctx);

    // Create a daily plan so there's history data
    const today = todayDate();
    const planResult = await coachbyte(ctx.client).rpc('ensure_daily_plan', { p_day: today });
    assertQuerySucceeds(planResult, 'setup ensure_daily_plan');
    planId = planResult.data.plan_id;

    // Complete a set so plan has completed_sets
    const completeResult = await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 225,
    });
    assertQuerySucceeds(completeResult, 'setup complete_next_set');

    // Update summary for richer data
    await coachbyte(ctx.client).from('daily_plans').update({ summary: 'Test history day' }).eq('plan_id', planId);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // HistoryPage: daily_plans query with pagination
  // Source: HistoryPage.tsx line 40-46
  //   .from('daily_plans')
  //   .select('plan_id, plan_date, summary')
  //   .eq('user_id', user.id)
  //   .order('plan_date', { ascending: false })
  //   .limit(PAGE_SIZE + 1)
  // -------------------------------------------------------------------
  it('daily_plans query returns plan_id, plan_date, summary', async () => {
    const PAGE_SIZE = 20;
    const result = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id, plan_date, summary')
      .eq('user_id', ctx.userId)
      .order('plan_date', { ascending: false })
      .limit(PAGE_SIZE + 1);

    const data = assertQuerySucceeds(result, 'daily_plans history');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);

    const first = data[0];
    expect(first).toHaveProperty('plan_id');
    expect(first).toHaveProperty('plan_date');
    expect(first).toHaveProperty('summary');
    expect(first.plan_id).toBe(planId);
    expect(first.summary).toBe('Test history day');
  });

  // -------------------------------------------------------------------
  // HistoryPage: keyset pagination with .lt('plan_date', cursorDate)
  // Source: HistoryPage.tsx line 48-49
  //   if (cursorDate) { query = query.lt('plan_date', cursorDate); }
  // -------------------------------------------------------------------
  it('keyset pagination with lt filter succeeds', async () => {
    // Use a future date cursor so our plan is included
    const futureCursor = '2099-12-31';
    const PAGE_SIZE = 20;
    const result = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id, plan_date, summary')
      .eq('user_id', ctx.userId)
      .order('plan_date', { ascending: false })
      .lt('plan_date', futureCursor)
      .limit(PAGE_SIZE + 1);

    const data = assertQuerySucceeds(result, 'keyset pagination');
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].plan_id).toBe(planId);
  });

  it('keyset pagination with past cursor returns empty', async () => {
    const pastCursor = '2000-01-01';
    const PAGE_SIZE = 20;
    const result = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id, plan_date, summary')
      .eq('user_id', ctx.userId)
      .order('plan_date', { ascending: false })
      .lt('plan_date', pastCursor)
      .limit(PAGE_SIZE + 1);

    const data = assertQuerySucceeds(result, 'keyset pagination past cursor');
    expect(data.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // HistoryPage: planned_sets count query
  // Source: HistoryPage.tsx line 65-69
  //   .from('planned_sets')
  //   .select('plan_id')
  //   .in('plan_id', planIds)
  // -------------------------------------------------------------------
  it('planned_sets count query returns rows with plan_id', async () => {
    const result = await coachbyte(ctx.client).from('planned_sets').select('plan_id').in('plan_id', [planId]);

    const data = assertQuerySucceeds(result, 'planned_sets count');
    expect(Array.isArray(data)).toBe(true);
    // Should have planned sets from split template (3 sets)
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].plan_id).toBe(planId);
  });

  // -------------------------------------------------------------------
  // HistoryPage: completed_sets count query
  // Source: HistoryPage.tsx line 71-75
  //   .from('completed_sets')
  //   .select('plan_id')
  //   .in('plan_id', planIds)
  // -------------------------------------------------------------------
  it('completed_sets count query returns rows with plan_id', async () => {
    const result = await coachbyte(ctx.client).from('completed_sets').select('plan_id').in('plan_id', [planId]);

    const data = assertQuerySucceeds(result, 'completed_sets count');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].plan_id).toBe(planId);
  });

  // -------------------------------------------------------------------
  // HistoryPage: exercises query for filter dropdown
  // Source: HistoryPage.tsx line 108-113
  //   .from('exercises')
  //   .select('exercise_id, name')
  //   .or(`user_id.is.null,user_id.eq.${user.id}`)
  //   .order('name')
  // -------------------------------------------------------------------
  it('exercises query for filter dropdown returns exercise_id and name', async () => {
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name');

    const data = assertQuerySucceeds(result, 'exercises filter');
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0]).toHaveProperty('exercise_id');
    expect(data[0]).toHaveProperty('name');
  });

  // -------------------------------------------------------------------
  // HistoryPage: completed_sets detail query with exercises join
  // Source: HistoryPage.tsx line 124-129
  //   .from('completed_sets')
  //   .select('actual_reps, actual_load, completed_at, exercises(name)')
  //   .eq('plan_id', planId)
  //   .order('completed_at')
  // -------------------------------------------------------------------
  it('completed_sets detail query returns joined exercise name', async () => {
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', planId)
      .order('completed_at');

    const data = assertQuerySucceeds(result, 'completed_sets detail');
    expect(data.length).toBeGreaterThanOrEqual(1);

    const first = data[0];
    expect(first).toHaveProperty('actual_reps');
    expect(first).toHaveProperty('actual_load');
    expect(first).toHaveProperty('completed_at');
    expect(first).toHaveProperty('exercises');
    expect(first.exercises).toHaveProperty('name');
    expect(typeof first.exercises.name).toBe('string');
    expect(first.actual_reps).toBe(5);
    expect(Number(first.actual_load)).toBe(225);
  });
});
