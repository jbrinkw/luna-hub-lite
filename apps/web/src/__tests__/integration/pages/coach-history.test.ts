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
    expect(first.plan_id).toBe(planId);
    expect(first.plan_date).toBe(todayDate());
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
    expect(typeof data[0].exercise_id).toBe('string');
    expect(typeof data[0].name).toBe('string');
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
    expect(first.actual_reps).toBe(5);
    expect(Number(first.actual_load)).toBe(225);
    expect(typeof first.completed_at).toBe('string');
    expect(first.exercises).not.toBeNull();
    expect(first.exercises.name).toBe('Squat');
  });

  // -------------------------------------------------------------------
  // HistoryPage: expanded day detail with zero completed sets returns empty
  // Source: HistoryPage.tsx line 145-151 — loadDetail
  //   .from('completed_sets')
  //   .select('actual_reps, actual_load, completed_at, exercises(name)')
  //   .eq('plan_id', planId)
  //   .order('completed_at')
  // -------------------------------------------------------------------
  it('expanded day detail with zero completed sets returns empty array', async () => {
    // Create a plan with no completed sets
    const emptyDate = '2026-01-10';
    const { data: emptyPlan } = await (coachbyte(ctx.client) as any).rpc('ensure_daily_plan', {
      p_day: emptyDate,
    });
    expect(emptyPlan).not.toBeNull();

    // Query completed_sets for this plan (EXACT pattern from loadDetail)
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', emptyPlan.plan_id)
      .order('completed_at');

    const data = assertQuerySucceeds(result, 'empty plan completed_sets');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);

    // Cleanup
    await coachbyte(ctx.client).from('daily_plans').delete().eq('plan_id', emptyPlan.plan_id);
  });

  // -------------------------------------------------------------------
  // HistoryPage: history days filtered by exercise_id
  // Source: HistoryPage.tsx line 170-180 — exerciseFilter effect
  //   .from('completed_sets')
  //   .select('plan_id')
  //   .eq('user_id', user.id)
  //   .eq('exercise_id', exerciseFilter)
  //   Then filteredDays = days.filter(d => exercisePlanIds.has(d.plan_id))
  // -------------------------------------------------------------------
  it('history days filtered by exercise_id returns only matching plans', async () => {
    // Get the exercise_id for the completed set we made in setup (Squat)
    const { data: completedSets } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id')
      .eq('user_id', ctx.userId)
      .limit(1);
    expect(completedSets).not.toBeNull();
    expect(completedSets!.length).toBeGreaterThan(0);
    const exerciseId = completedSets![0].exercise_id;

    // EXACT query from HistoryPage exerciseFilter effect
    const { data: matchingPlanIds } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('plan_id')
      .eq('user_id', ctx.userId)
      .eq('exercise_id', exerciseId);

    expect(matchingPlanIds).not.toBeNull();
    expect(matchingPlanIds!.length).toBeGreaterThan(0);

    // The plan_id should match our known planId
    const ids = matchingPlanIds!.map((r: any) => r.plan_id);
    expect(ids).toContain(planId);

    // Create a plan with a DIFFERENT exercise to verify filtering
    const otherDate = '2026-01-11';
    const { data: otherPlan } = await (coachbyte(ctx.client) as any).rpc('ensure_daily_plan', {
      p_day: otherDate,
    });

    // Get a different exercise
    const { data: allExercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name')
      .is('user_id', null)
      .order('name');
    const differentEx = allExercises!.find((e: any) => e.exercise_id !== exerciseId);
    expect(differentEx).toBeDefined();

    // Insert a completed set for the different exercise
    await coachbyte(ctx.client).from('completed_sets').insert({
      plan_id: otherPlan.plan_id,
      user_id: ctx.userId,
      exercise_id: differentEx!.exercise_id,
      actual_reps: 10,
      actual_load: 50,
    });

    // Re-query with the ORIGINAL exercise filter — should NOT include otherPlan
    const { data: filtered } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('plan_id')
      .eq('user_id', ctx.userId)
      .eq('exercise_id', exerciseId);

    const filteredIds = filtered!.map((r: any) => r.plan_id);
    expect(filteredIds).toContain(planId);
    expect(filteredIds).not.toContain(otherPlan.plan_id);

    // Cleanup
    await coachbyte(ctx.client).from('daily_plans').delete().eq('plan_id', otherPlan.plan_id);
  });

  // -------------------------------------------------------------------
  // HistoryPage: exercise filter query (completed_sets plan_ids by exercise)
  // Source: HistoryPage.tsx line 183-194
  //   .from('completed_sets')
  //   .select('plan_id')
  //   .eq('user_id', user.id)
  //   .eq('exercise_id', exerciseFilter)
  // -------------------------------------------------------------------
  it('completed_sets filter by exercise_id returns plan_ids', async () => {
    // Get an exercise that has completed sets
    const { data: completedSets } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id')
      .eq('user_id', ctx.userId)
      .limit(1);

    expect(completedSets).not.toBeNull();
    expect(completedSets!.length).toBeGreaterThan(0);

    const exerciseId = completedSets![0].exercise_id;

    // EXACT query from HistoryPage exercise filter
    const { data: planIds } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('plan_id')
      .eq('user_id', ctx.userId)
      .eq('exercise_id', exerciseId);

    expect(planIds).not.toBeNull();
    expect(planIds!.length).toBeGreaterThan(0);
    expect(typeof planIds![0].plan_id).toBe('string');
  });

  // -------------------------------------------------------------------
  // #33: History toggle collapse — click View Details, then click Hide
  // The UI toggles expandedPlan state and queries completed_sets for
  // the clicked plan_id. Verify the detail query returns data.
  // -------------------------------------------------------------------
  it('plan detail query returns completed_sets for expand/collapse', async () => {
    // Expand: query completed_sets for a specific plan_id
    const { data: detail } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id, exercise_id, actual_reps, actual_load')
      .eq('plan_id', planId)
      .eq('user_id', ctx.userId);

    expect(detail).not.toBeNull();
    expect(detail!.length).toBeGreaterThan(0);

    // Collapse is pure UI state (expandedPlan = null), no query needed
    // The point is the query works both ways — data is available for expand
    expect(detail![0].completed_set_id).toBeDefined();
    expect(detail![0].actual_reps).toBeDefined();
  });
});
