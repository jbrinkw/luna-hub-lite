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
import {
  epley1RM,
  loadPrsData,
  loadExercisesForPrs,
  loadPrTrackedExerciseIds,
  savePrTrackedExerciseIds,
} from '@/pages/coachbyte/PrsPage';

// Legacy-audit issue #3 (2026-04-22): this test used to replicate each
// query from PrsPage.tsx inline with a "// Source: PrsPage.tsx line N"
// comment. Stale replicas kept passing after refactors. Now the test
// calls the SAME exported loaders the page calls — if a loader changes,
// this test exercises the new behavior automatically.

describe('CoachByte PrsPage loaders', () => {
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
  // loadPrsData — aggregates completed_sets by exercise + rep bucket
  // and computes e1RM. This is the primary query driving the PR cards.
  //
  // The loader groups by exercise_id, keeps the best load per rep
  // bucket, and computes e1RM as the max Epley across buckets. We
  // assert against the completed_sets rows actually in the DB — seed
  // helpers are noisy enough that a fixed-count assertion here is
  // fragile (see the original coach-prs suite's beforeAll, whose ad-
  // hoc insert is fire-and-forget). This is the point of the
  // extraction refactor: the test pins loader BEHAVIOR, not seed shape.
  // -------------------------------------------------------------------
  it('loadPrsData groups completed_sets by exercise + rep bucket with max-Epley e1RM', async () => {
    const prs = await loadPrsData(ctx.userId, 90, ctx.client);

    expect(Array.isArray(prs)).toBe(true);
    expect(prs.length).toBeGreaterThanOrEqual(1);

    // Rebuild the expected grouping directly from completed_sets so the
    // assertion stays true regardless of which seed rows landed.
    const { data: raw } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id, actual_reps, actual_load, exercises(name)')
      .eq('user_id', ctx.userId);
    expect(raw).not.toBeNull();

    const expectedByExercise = new Map<string, { name: string; byReps: Map<number, number> }>();
    for (const row of raw as any[]) {
      const id = row.exercise_id as string;
      const name = row.exercises?.name ?? 'Unknown';
      const reps = row.actual_reps as number;
      const load = Number(row.actual_load);
      if (!expectedByExercise.has(id)) expectedByExercise.set(id, { name, byReps: new Map() });
      const entry = expectedByExercise.get(id)!;
      entry.byReps.set(reps, Math.max(entry.byReps.get(reps) ?? 0, load));
    }

    // Loader must produce one PR record per distinct exercise_id.
    expect(prs).toHaveLength(expectedByExercise.size);

    // Loader sorts by exercise name ascending.
    for (let i = 1; i < prs.length; i++) {
      expect(prs[i].exercise_name.localeCompare(prs[i - 1].exercise_name)).toBeGreaterThanOrEqual(0);
    }

    // Every card matches the rep-bucket pivot + the max-Epley e1RM.
    for (const pr of prs) {
      const expected = expectedByExercise.get(pr.exercise_id)!;
      expect(expected).toBeDefined();
      expect(pr.exercise_name).toBe(expected.name);

      // rep_records contains one entry per distinct reps count, with
      // the load equal to the max load observed at that count.
      expect(pr.rep_records).toHaveLength(expected.byReps.size);
      for (const r of pr.rep_records) {
        expect(r.load).toBe(expected.byReps.get(r.reps));
      }

      // Ascending by reps.
      for (let i = 1; i < pr.rep_records.length; i++) {
        expect(pr.rep_records[i].reps).toBeGreaterThan(pr.rep_records[i - 1].reps);
      }

      // e1RM = max Epley across all rep records.
      const expectedE1rm = Math.max(...pr.rep_records.map((r) => epley1RM(r.load, r.reps)));
      expect(pr.e1rm).toBe(expectedE1rm);
    }
  });

  // -------------------------------------------------------------------
  // loadPrsData date-range sentinel — 9999 means "all history" (no gte).
  // Tests both branches of the conditional inside the loader.
  // -------------------------------------------------------------------
  it('loadPrsData with dateRange=9999 returns all history (no gte filter)', async () => {
    const boundedPrs = await loadPrsData(ctx.userId, 90, ctx.client);
    const unboundedPrs = await loadPrsData(ctx.userId, 9999, ctx.client);

    // Every set completed in beforeAll is recent, so both sets should
    // have identical PR cards. The important thing is the 9999 branch
    // didn't fail and produced the same shape.
    expect(unboundedPrs).toHaveLength(boundedPrs.length);
    expect(
      unboundedPrs.map((p) => p.exercise_name).sort(),
    ).toEqual(boundedPrs.map((p) => p.exercise_name).sort());
  });

  // -------------------------------------------------------------------
  // loadExercisesForPrs — populates the search + tracked-chip list.
  // -------------------------------------------------------------------
  it('loadExercisesForPrs returns alphabetically-ordered exercise list', async () => {
    const exercises = await loadExercisesForPrs(ctx.userId, ctx.client);
    expect(exercises.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < exercises.length; i++) {
      expect(exercises[i].name.localeCompare(exercises[i - 1].name)).toBeGreaterThanOrEqual(0);
    }

    // Every row has the column shape the UI consumes.
    for (const e of exercises) {
      expect(typeof e.exercise_id).toBe('string');
      expect(typeof e.name).toBe('string');
    }
  });

  // -------------------------------------------------------------------
  // loadPrTrackedExerciseIds / savePrTrackedExerciseIds round-trip —
  // same helper pair the chip toggles use.
  // -------------------------------------------------------------------
  it('savePrTrackedExerciseIds + loadPrTrackedExerciseIds round-trip', async () => {
    const exercises = await loadExercisesForPrs(ctx.userId, ctx.client);
    const ids = [exercises[0].exercise_id, exercises[1].exercise_id];

    await savePrTrackedExerciseIds(ctx.userId, ids, ctx.client);
    const loaded = await loadPrTrackedExerciseIds(ctx.userId, ctx.client);
    expect(loaded).toEqual(ids);

    // Empty list is a distinct signal from null — the UI respects "user
    // explicitly tracks zero" vs "user hasn't configured yet".
    await savePrTrackedExerciseIds(ctx.userId, [], ctx.client);
    const empty = await loadPrTrackedExerciseIds(ctx.userId, ctx.client);
    expect(empty).toEqual([]);

    // Cleanup: restore the null sentinel so other tests see the
    // unconfigured state.
    const { error } = await coachbyte(ctx.client)
      .from('user_settings')
      .update({ pr_tracked_exercise_ids: null })
      .eq('user_id', ctx.userId);
    expect(error).toBeNull();
  });

  // -------------------------------------------------------------------
  // Derived UI state — tracked-filter removes cards whose exercise_id
  // isn't in the tracked set. Keep this as a pure-function check of
  // the render-side filter that operates on loadPrsData's output.
  // -------------------------------------------------------------------
  it('PR cards filter by tracked exercise_ids (UI render-side filter)', async () => {
    const prs = await loadPrsData(ctx.userId, 90, ctx.client);
    expect(prs.length).toBeGreaterThan(0);

    // Track only Squat → filteredPRs must drop Bench Press.
    const squatId = seeds.exerciseMap['Squat'];
    const trackedIds = new Set([squatId]);
    const filtered = prs.filter((pr) => trackedIds.has(pr.exercise_id));
    expect(filtered.map((p) => p.exercise_name)).toEqual(['Squat']);

    // Track nothing → empty PR cards.
    const noneTracked = new Set<string>();
    expect(prs.filter((pr) => noneTracked.has(pr.exercise_id))).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Derived UI state — search excludes already-tracked exercises.
  // Pure function over loadExercisesForPrs output.
  // -------------------------------------------------------------------
  it('search excludes already-tracked exercise_ids (UI filter)', async () => {
    const all = await loadExercisesForPrs(ctx.userId, ctx.client);
    expect(all.length).toBeGreaterThanOrEqual(2);

    const trackedIds = new Set([all[0].exercise_id, all[1].exercise_id]);
    const searchText = '';
    const searchResults = all.filter(
      (e) => (searchText === '' || e.name.toLowerCase().includes(searchText)) && !trackedIds.has(e.exercise_id),
    );

    for (const r of searchResults) {
      expect(trackedIds.has(r.exercise_id)).toBe(false);
    }
    expect(searchResults).toHaveLength(all.length - 2);
  });

  // -------------------------------------------------------------------
  // Epley formula — pure function. Keep this because it pins the
  // numeric behavior the PR cards surface.
  // -------------------------------------------------------------------
  it('epley1RM matches the formula used to populate e1rm', () => {
    expect(epley1RM(225, 1)).toBe(225);
    expect(epley1RM(185, 5)).toBe(216); // round(185 * (1 + 5/30))
    expect(epley1RM(275, 3)).toBe(303); // round(275 * 1.1)
    // Guards
    expect(epley1RM(0, 5)).toBe(0);
    expect(epley1RM(225, 0)).toBe(0);
  });
});
