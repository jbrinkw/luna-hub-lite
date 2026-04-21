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

// =====================================================================
// Audit recommendation #17 (MEDIUM): keyset pagination cross-page
// boundary. Catches a regression where `.lt('plan_date', cursor)`
// silently drifts to `.lte(...)` — the last row of page N would then
// duplicate as the first row of page N+1.
//
// Independent describe with its own fresh user + 25 seeded plans so the
// PAGE_SIZE arithmetic is clean and nothing from the main describe's
// seed leaks into the boundary math.
// =====================================================================
describe('CoachByte HistoryPage keyset pagination boundary', () => {
  let ctx: PageTestContext;
  const PAGE_SIZE = 10;
  const SEED_DAYS = 25;
  const seededDates: string[] = []; // newest-first, matching descending order

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-history-boundary');

    // Seed 25 consecutive past days of daily_plans directly (skip splits
    // + completed_sets; HistoryPage only needs plan_date to paginate).
    // We insert in SEED_DAYS..1 order relative to a fixed anchor so
    // plan_date values are unique and monotonically decreasing.
    const coach = coachbyte(ctx.client);
    const anchor = new Date('2025-06-15T00:00:00Z');
    const rows: Array<{ user_id: string; plan_date: string; logical_date: string }> = [];
    for (let i = 0; i < SEED_DAYS; i++) {
      const d = new Date(anchor);
      d.setUTCDate(d.getUTCDate() - i);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;
      rows.push({ user_id: ctx.userId, plan_date: dateStr, logical_date: dateStr });
      seededDates.push(dateStr); // i=0 is newest → matches descending order
    }

    const { error } = await coach.from('daily_plans').insert(rows);
    if (error) throw new Error(`Seed failed: ${error.message}`);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // ---------------------------------------------------------------------
  // Replica of HistoryPage pagination: fetch PAGE_SIZE+1 per page,
  // discard the sentinel, use last-plan_date as next cursor with
  // `.lt('plan_date', cursor)`. Any drift to `.lte(...)` duplicates
  // the boundary row on the next page.
  //
  // Source references:
  //   - initial fetch: HistoryPage.tsx lines 51-59
  //   - loadMore:      HistoryPage.tsx lines 172-182 (uses .lt)
  // ---------------------------------------------------------------------
  async function fetchPage(cursor: string | null): Promise<{ rows: Array<{ plan_id: string; plan_date: string }>; hasMore: boolean }> {
    let q = coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id, plan_date')
      .eq('user_id', ctx.userId)
      .order('plan_date', { ascending: false });

    if (cursor) q = q.lt('plan_date', cursor);
    q = q.limit(PAGE_SIZE + 1);

    const res = await q;
    const data = assertQuerySucceeds(res, `fetchPage cursor=${cursor}`);
    const hasMore = (data as any[]).length > PAGE_SIZE;
    const rows = hasMore ? (data as any[]).slice(0, PAGE_SIZE) : (data as any[]);
    return { rows, hasMore };
  }

  it('paginates 25 rows across 3 pages (10+10+5) with no duplicates, no gaps, strictly decreasing', async () => {
    // Page 1
    const page1 = await fetchPage(null);
    expect(page1.rows.length).toBe(PAGE_SIZE);
    expect(page1.hasMore).toBe(true);

    // Page 2 — cursor is the last plan_date of page 1
    const cursor1 = page1.rows[page1.rows.length - 1].plan_date;
    const page2 = await fetchPage(cursor1);
    expect(page2.rows.length).toBe(PAGE_SIZE);
    expect(page2.hasMore).toBe(true);

    // Page 3 — cursor is the last plan_date of page 2. Only 5 rows left.
    const cursor2 = page2.rows[page2.rows.length - 1].plan_date;
    const page3 = await fetchPage(cursor2);
    expect(page3.rows.length).toBe(5);
    expect(page3.hasMore).toBe(false);

    // ── Boundary check: .lt vs .lte regression guard ──
    // First row of page 2 must be STRICTLY less than last row of page 1.
    // If `.lt` ever drifts to `.lte`, page 2's first row == page 1's last
    // row and the Set-size assertion below fails on the duplicate.
    const page1Last = page1.rows[page1.rows.length - 1].plan_date;
    const page2First = page2.rows[0].plan_date;
    expect(page2First < page1Last).toBe(true);

    const page2Last = page2.rows[page2.rows.length - 1].plan_date;
    const page3First = page3.rows[0].plan_date;
    expect(page3First < page2Last).toBe(true);

    // ── No duplicates across pages ──
    const allDates = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.plan_date);
    const allPlanIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.plan_id);
    expect(new Set(allDates).size).toBe(allDates.length);
    expect(new Set(allPlanIds).size).toBe(allPlanIds.length);
    expect(allDates.length).toBe(SEED_DAYS);

    // ── No missing rows (set equality against seeded input) ──
    expect(new Set(allDates)).toEqual(new Set(seededDates));

    // ── Monotonically decreasing (newest → oldest) ──
    for (let i = 1; i < allDates.length; i++) {
      expect(allDates[i] < allDates[i - 1]).toBe(true);
    }

    // ── Specific boundary values: the first seeded date must appear
    // first on page 1; the oldest seeded date must appear last on page 3.
    expect(allDates[0]).toBe(seededDates[0]); // newest
    expect(allDates[allDates.length - 1]).toBe(seededDates[seededDates.length - 1]); // oldest
  });

  it('page 2 first row is NOT equal to page 1 last row (explicit .lt regression pin)', async () => {
    // Tight focus on the exact regression: if `.lt` → `.lte`, the
    // boundary row repeats. This assertion fails loudly if that happens,
    // independently of the overall set/sequence checks above.
    const page1 = await fetchPage(null);
    const cursor1 = page1.rows[page1.rows.length - 1].plan_date;
    const page2 = await fetchPage(cursor1);

    expect(page1.rows[page1.rows.length - 1].plan_date).not.toBe(page2.rows[0].plan_date);
    expect(page1.rows[page1.rows.length - 1].plan_id).not.toBe(page2.rows[0].plan_id);
  });
});
