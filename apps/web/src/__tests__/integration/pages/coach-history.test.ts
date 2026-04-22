import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  coachbyte,
  seedSplit,
  assertQuerySucceeds,
  todayDate,
  type PageTestContext,
} from './helpers';
import {
  HISTORY_PAGE_SIZE,
  loadHistoryPage,
  loadHistoryTotalCount,
  loadHistoryExercises,
  loadHistoryDetail,
  loadPlanIdsWithExercise,
} from '@/pages/coachbyte/HistoryPage';

// Legacy-audit issue #3 (2026-04-22): this test previously replicated
// HistoryPage's query strings inline with "// Source:" comments that
// drifted out of sync with the page. Now the test calls the exact
// exported loaders the UI uses — refactoring one side surfaces the
// other automatically.

describe('CoachByte HistoryPage loaders', () => {
  let ctx: PageTestContext;
  let planId: string;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-history');
    await seedSplit(ctx);

    const today = todayDate();
    const planResult = await coachbyte(ctx.client).rpc('ensure_daily_plan', { p_day: today });
    assertQuerySucceeds(planResult, 'setup ensure_daily_plan');
    planId = planResult.data.plan_id;

    // Accept both the legacy (p_reps/p_load) and migrated
    // (p_actual_reps/p_actual_load) RPC signatures — the pgTAP-integration
    // agent is actively renaming these during the 2026-04-25 batch.
    // First attempt: legacy. If PGRST202 (sig not found), retry migrated.
    let completeResult: any = await coachbyte(ctx.client).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 225,
    });
    if (completeResult.error && completeResult.error.code === 'PGRST202') {
      completeResult = await coachbyte(ctx.client).rpc('complete_next_set', {
        p_plan_id: planId,
        p_actual_reps: 5,
        p_actual_load: 225,
      });
    }
    assertQuerySucceeds(completeResult, 'setup complete_next_set');

    await coachbyte(ctx.client).from('daily_plans').update({ summary: 'Test history day' }).eq('plan_id', planId);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // loadHistoryPage — the queryFn behind the first-page load + loadMore.
  // Asserts: shape of each HistoryDay row, planned/completed counts
  // filled in from the in-clause queries, hasMore flag when fewer than
  // PAGE_SIZE+1 rows exist.
  // -------------------------------------------------------------------
  it('loadHistoryPage returns days with filled planned/completed counts', async () => {
    const page = await loadHistoryPage(ctx.userId, null, ctx.client);

    expect(page.days.length).toBeGreaterThanOrEqual(1);
    expect(page.hasMore).toBe(false); // only 1 plan in this user
    expect(page.cursor).toBe(todayDate());

    const today = page.days.find((d) => d.plan_id === planId);
    expect(today).toBeDefined();
    expect(today!.plan_date).toBe(todayDate());
    expect(today!.summary).toBe('Test history day');
    // seedSplit seeds 3 template sets → ensure_daily_plan copies them in.
    expect(today!.planned_count).toBeGreaterThanOrEqual(1);
    // One complete_next_set call in beforeAll → exactly one completed row.
    expect(today!.completed_count).toBe(1);
  });

  // -------------------------------------------------------------------
  // loadHistoryPage cursor semantics — the `.lt('plan_date', cursor)`
  // contract. Past cursor → no rows; future cursor → all rows.
  // -------------------------------------------------------------------
  it('loadHistoryPage with past cursor returns empty', async () => {
    const page = await loadHistoryPage(ctx.userId, '2000-01-01', ctx.client);
    expect(page.days).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it('loadHistoryPage with future cursor returns full history', async () => {
    const page = await loadHistoryPage(ctx.userId, '2099-12-31', ctx.client);
    expect(page.days.length).toBeGreaterThanOrEqual(1);
    expect(page.days.some((d) => d.plan_id === planId)).toBe(true);
  });

  // -------------------------------------------------------------------
  // loadHistoryTotalCount — powers the "1–N of TOTAL" summary.
  // -------------------------------------------------------------------
  it('loadHistoryTotalCount returns the row count', async () => {
    const total = await loadHistoryTotalCount(ctx.userId, ctx.client);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // loadHistoryExercises — populates the filter dropdown.
  // -------------------------------------------------------------------
  it('loadHistoryExercises returns exercises in alphabetical order', async () => {
    const exercises = await loadHistoryExercises(ctx.userId, ctx.client);
    expect(exercises.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < exercises.length; i++) {
      expect(exercises[i].name.localeCompare(exercises[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
    for (const e of exercises) {
      expect(typeof e.exercise_id).toBe('string');
      expect(typeof e.name).toBe('string');
    }
  });

  // -------------------------------------------------------------------
  // loadHistoryDetail — expanded plan card's joined completed_sets.
  // -------------------------------------------------------------------
  it('loadHistoryDetail returns completed sets with exercise_name joined', async () => {
    const detail = await loadHistoryDetail(planId, ctx.userId, ctx.client);

    expect(detail.length).toBeGreaterThanOrEqual(1);
    const first = detail[0];
    expect(first.exercise_name).toBe('Squat');
    expect(first.actual_reps).toBe(5);
    expect(first.actual_load).toBe(225);
    expect(typeof first.completed_at).toBe('string');
  });

  it('loadHistoryDetail returns [] for a plan with no completed sets', async () => {
    const emptyDate = '2026-01-10';
    const { data: emptyPlan } = await (coachbyte(ctx.client) as any).rpc('ensure_daily_plan', { p_day: emptyDate });
    expect(emptyPlan).not.toBeNull();

    const detail = await loadHistoryDetail(emptyPlan.plan_id, ctx.userId, ctx.client);
    expect(detail).toEqual([]);

    await coachbyte(ctx.client).from('daily_plans').delete().eq('plan_id', emptyPlan.plan_id);
  });

  // -------------------------------------------------------------------
  // loadPlanIdsWithExercise — powers the exercise-filter dropdown.
  // Returns the Set of plan_ids containing any completed_set for the
  // given exercise_id; UI uses `exercisePlanIds.has(day.plan_id)` to
  // narrow the days list.
  // -------------------------------------------------------------------
  it('loadPlanIdsWithExercise returns a set containing the matching plan_id', async () => {
    // Find the exercise that has a completed set
    const { data: sets } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id')
      .eq('user_id', ctx.userId)
      .limit(1);
    expect(sets!.length).toBeGreaterThan(0);
    const exerciseId = sets![0].exercise_id;

    const ids = await loadPlanIdsWithExercise(ctx.userId, exerciseId, ctx.client);
    expect(ids.has(planId)).toBe(true);
  });

  it('loadPlanIdsWithExercise excludes plans without the chosen exercise', async () => {
    // Create a plan with a DIFFERENT exercise to verify filtering
    const otherDate = '2026-01-11';
    const { data: otherPlan } = await (coachbyte(ctx.client) as any).rpc('ensure_daily_plan', { p_day: otherDate });

    const { data: allExercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name')
      .is('user_id', null)
      .order('name');

    // Find an exercise NOT used by the main planId's completed_sets
    const { data: usedSets } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id')
      .eq('plan_id', planId);
    const usedIds = new Set((usedSets ?? []).map((r: any) => r.exercise_id as string));
    const unusedExercise = (allExercises as any[]).find((e) => !usedIds.has(e.exercise_id));
    expect(unusedExercise).toBeDefined();

    await coachbyte(ctx.client).from('completed_sets').insert({
      plan_id: otherPlan.plan_id,
      user_id: ctx.userId,
      exercise_id: unusedExercise!.exercise_id,
      actual_reps: 10,
      actual_load: 50,
    });

    // Filter by the OTHER exercise — should not include the main planId
    const otherIds = await loadPlanIdsWithExercise(ctx.userId, unusedExercise!.exercise_id, ctx.client);
    expect(otherIds.has(otherPlan.plan_id)).toBe(true);
    expect(otherIds.has(planId)).toBe(false);

    // Cleanup
    await coachbyte(ctx.client).from('daily_plans').delete().eq('plan_id', otherPlan.plan_id);
  });
});

// =====================================================================
// Keyset pagination boundary test — unchanged in structure but now
// drives loadHistoryPage directly instead of duplicating its query.
// PAGE_SIZE is imported from the page so if the page ever changes
// the constant, the test boundary math picks it up.
// =====================================================================
describe('CoachByte HistoryPage keyset pagination boundary', () => {
  let ctx: PageTestContext;
  // Use the production page-size constant directly — if the UI changes
  // its page size, the test math stays coupled.
  const PAGE_SIZE = HISTORY_PAGE_SIZE;
  // Seed PAGE_SIZE*2 + half so we cover three pages (full, full, partial).
  const SEED_DAYS = PAGE_SIZE * 2 + Math.floor(PAGE_SIZE / 4);
  const seededDates: string[] = []; // newest-first, matching descending order

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-history-boundary');

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
      seededDates.push(dateStr);
    }

    const { error } = await coach.from('daily_plans').insert(rows);
    if (error) throw new Error(`Seed failed: ${error.message}`);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('paginates across 3 pages with no duplicates, no gaps, strictly decreasing', async () => {
    // Page 1 — no cursor
    const page1 = await loadHistoryPage(ctx.userId, null, ctx.client);
    expect(page1.days.length).toBe(PAGE_SIZE);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBe(page1.days[page1.days.length - 1].plan_date);

    // Page 2 — cursor from page 1's last row
    const page2 = await loadHistoryPage(ctx.userId, page1.cursor, ctx.client);
    expect(page2.days.length).toBe(PAGE_SIZE);
    expect(page2.hasMore).toBe(true);

    // Page 3 — partial
    const page3 = await loadHistoryPage(ctx.userId, page2.cursor, ctx.client);
    expect(page3.days.length).toBe(SEED_DAYS - 2 * PAGE_SIZE);
    expect(page3.hasMore).toBe(false);

    // ── Boundary check: .lt vs .lte regression guard ──
    // First row of page N+1 must be STRICTLY less than last row of page N.
    expect(page2.days[0].plan_date < page1.days[page1.days.length - 1].plan_date).toBe(true);
    expect(page3.days[0].plan_date < page2.days[page2.days.length - 1].plan_date).toBe(true);

    // ── No duplicates across pages ──
    const allDates = [...page1.days, ...page2.days, ...page3.days].map((r) => r.plan_date);
    const allPlanIds = [...page1.days, ...page2.days, ...page3.days].map((r) => r.plan_id);
    expect(new Set(allDates).size).toBe(allDates.length);
    expect(new Set(allPlanIds).size).toBe(allPlanIds.length);
    expect(allDates.length).toBe(SEED_DAYS);

    // ── No missing rows (set equality against seeded input) ──
    expect(new Set(allDates)).toEqual(new Set(seededDates));

    // ── Monotonically decreasing ──
    for (let i = 1; i < allDates.length; i++) {
      expect(allDates[i] < allDates[i - 1]).toBe(true);
    }

    // ── Boundary values ──
    expect(allDates[0]).toBe(seededDates[0]); // newest
    expect(allDates[allDates.length - 1]).toBe(seededDates[seededDates.length - 1]); // oldest
  });

  it('page 2 first row is NOT equal to page 1 last row (explicit .lt regression pin)', async () => {
    const page1 = await loadHistoryPage(ctx.userId, null, ctx.client);
    const page2 = await loadHistoryPage(ctx.userId, page1.cursor, ctx.client);

    expect(page1.days[page1.days.length - 1].plan_date).not.toBe(page2.days[0].plan_date);
    expect(page1.days[page1.days.length - 1].plan_id).not.toBe(page2.days[0].plan_id);
  });
});
