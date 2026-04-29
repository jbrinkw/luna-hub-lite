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
import { DEFAULT_TIMER, loadDailyPlanData, loadExercisesForToday, loadTimerState } from '@/pages/coachbyte/TodayPage';
import { epley1RM } from '@/pages/coachbyte/PrsPage';

// Legacy-audit issue #3 (2026-04-22): this test previously replicated
// TodayPage's query strings inline with "// Source: TodayPage.tsx line N"
// comments. 21 such replicas — the largest of any integration file. The
// load-and-assemble queries are now called from their extracted loaders
// (loadDailyPlanData, loadTimerState, loadExercisesForToday). Pure
// mutation paths (insert/update/delete) remain as direct RPC calls —
// those aren't query replicas, they're CRUD round-trip checks.

// W-16 fix: removed legacy p_reps/p_load fallback shim. The migration
// 20260425040000_timer_state_machine_rpcs.sql has been stable since
// 2026-04-25. The compat shim allowed the wrong (deprecated) signature to
// silently succeed via the fallback path — masking any re-introduction of
// the old signature. Integration tests must use the canonical arg names
// exclusively so PGRST202 would surface immediately.
async function completeNextSet(ctx: PageTestContext, planId: string, reps: number, load: number): Promise<any> {
  return coachbyte(ctx.client).rpc('complete_next_set', {
    p_plan_id: planId,
    p_actual_reps: reps,
    p_actual_load: load,
  });
}

describe('CoachByte TodayPage loaders + mutations', () => {
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
  // loadDailyPlanData — the queryFn behind `queryKeys.dailyPlan`.
  // Wraps ensure_daily_plan + planned_sets + completed_sets + summary/
  // notes into a single payload. This is the most-replicated query in
  // the old test (ensure_daily_plan RPC + 3 selects fanned out across
  // 4 individual test cases). One loader call covers it all.
  // -------------------------------------------------------------------
  it("loadDailyPlanData creates + assembles today's plan on first call", async () => {
    const data = await loadDailyPlanData(todayDate(), ctx.client);

    expect(typeof data.planId).toBe('string');
    expect(data.planId.length).toBeGreaterThan(0);
    planId = data.planId;

    // seedSplit seeds 3 template sets (2 Squat + 1 Bench) for today's weekday;
    // ensure_daily_plan copies them into planned_sets.
    expect(data.sets.length).toBe(3);
    // Sorted by order.
    for (let i = 1; i < data.sets.length; i++) {
      expect(data.sets[i].order).toBeGreaterThan(data.sets[i - 1].order);
    }
    // Every set carries the joined exercise_name (never 'Unknown').
    for (const s of data.sets) {
      expect(['Squat', 'Bench Press']).toContain(s.exercise_name);
      expect(typeof s.exercise_id).toBe('string');
    }
    // No completions on first call.
    expect(data.completedSets).toEqual([]);
    // Summary/notes default empty-string.
    expect(data.summary).toBe('');
    expect(data.notes).toBe('');
    // ``completed`` flag starts false for every set.
    for (const s of data.sets) expect(s.completed).toBe(false);
  });

  // -------------------------------------------------------------------
  // loadDailyPlanData again after completing a set — verifies the
  // completedPlanIds flip lands on the matching planned_set entry.
  // -------------------------------------------------------------------
  it('loadDailyPlanData reflects completed sets + flips completed flag on planned set', async () => {
    // Complete the first planned set via the RPC (signature adaptively handled).
    const r = await completeNextSet(ctx, planId, 5, 225);
    assertQuerySucceeds(r, 'complete_next_set');

    const data = await loadDailyPlanData(todayDate(), ctx.client);
    expect(data.planId).toBe(planId);
    expect(data.completedSets.length).toBe(1);

    const cs = data.completedSets[0];
    expect(cs.exercise_name).toBe('Squat');
    expect(cs.actual_reps).toBe(5);
    expect(cs.actual_load).toBe(225);
    expect(typeof cs.completed_at).toBe('string');
    expect(typeof cs.completed_set_id).toBe('string');

    // Exactly one of the planned sets (first-in-order) now shows completed=true.
    const completedCount = data.sets.filter((s) => s.completed).length;
    expect(completedCount).toBe(1);
  });

  // -------------------------------------------------------------------
  // loadTimerState — no row ⇒ DEFAULT_TIMER, running row ⇒ hydrated state.
  // -------------------------------------------------------------------
  it('loadTimerState returns DEFAULT_TIMER when no row exists', async () => {
    // Ensure clean state — routed through reset_timer RPC, same as page.
    await coachbyte(ctx.client).rpc('reset_timer');

    const t = await loadTimerState(ctx.userId, ctx.client);
    expect(t).toEqual(DEFAULT_TIMER);
    expect(t.state).toBe('idle');
    expect(t.end_time).toBeNull();
    expect(t.duration_seconds).toBe(0);
    expect(t.elapsed_before_pause).toBe(0);
  });

  it('loadTimerState hydrates a running timer row', async () => {
    // Start via the state-machine RPC (matches TodayPage startTimer).
    const start = await coachbyte(ctx.client).rpc('start_timer', {
      p_duration_seconds: 90,
    });
    expect(start.error).toBeNull();

    const t = await loadTimerState(ctx.userId, ctx.client);
    expect(t.state).toBe('running');
    expect(t.end_time).not.toBeNull();
    // end_time must be in the future (RPC used now() + duration)
    expect(new Date(t.end_time!).getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(t.duration_seconds).toBe(90);
    expect(t.elapsed_before_pause).toBe(0);
  });

  it('loadTimerState reflects a paused-then-reset round-trip', async () => {
    // Pause via the RPC (matches TodayPage pauseTimer).
    const paused = await coachbyte(ctx.client).rpc('pause_timer');
    expect(paused.error).toBeNull();

    const afterPause = await loadTimerState(ctx.userId, ctx.client);
    expect(afterPause.state).toBe('paused');
    expect(afterPause.elapsed_before_pause).toBeGreaterThanOrEqual(0);
    expect(afterPause.end_time).toBeNull();

    // Reset via RPC (matches TodayPage resetTimer).
    const del = await coachbyte(ctx.client).rpc('reset_timer');
    expect(del.error).toBeNull();

    const afterReset = await loadTimerState(ctx.userId, ctx.client);
    expect(afterReset).toEqual(DEFAULT_TIMER);
  });

  // -------------------------------------------------------------------
  // loadExercisesForToday — populates the AdHocSetForm dropdown.
  // -------------------------------------------------------------------
  it('loadExercisesForToday returns alphabetically-ordered exercises', async () => {
    const exercises = await loadExercisesForToday(ctx.userId, ctx.client);
    expect(exercises.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < exercises.length; i++) {
      expect(exercises[i].name.localeCompare(exercises[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
    for (const e of exercises) {
      expect(typeof e.exercise_id).toBe('string');
      expect(typeof e.name).toBe('string');
    }
  });

  // -------------------------------------------------------------------
  // CRUD helpers below exercise the mutation paths the UI uses against
  // the DB. They are NOT query replicas — they're round-trip checks on
  // the insert/update/delete handlers. Kept because they pin behavior
  // the extracted loaders don't cover (the loaders are read-only).
  // -------------------------------------------------------------------
  it('daily_plans summary update propagates through loadDailyPlanData', async () => {
    const upd = await coachbyte(ctx.client)
      .from('daily_plans')
      .update({ summary: 'Great workout today' })
      .eq('plan_id', planId);
    expect(upd.error).toBeNull();

    const data = await loadDailyPlanData(todayDate(), ctx.client);
    expect(data.summary).toBe('Great workout today');
  });

  it('ad-hoc completed_sets insert shows up via loadDailyPlanData', async () => {
    const exerciseId = Object.values(seeds.exerciseMap)[0]; // Squat
    const { data: planInfo } = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();

    const beforeCount = (await loadDailyPlanData(todayDate(), ctx.client)).completedSets.length;

    const { error: insertErr } = await coachbyte(ctx.client).from('completed_sets').insert({
      plan_id: planId,
      user_id: ctx.userId,
      exercise_id: exerciseId,
      actual_reps: 10,
      actual_load: 100,
      logical_date: planInfo!.logical_date,
    });
    expect(insertErr).toBeNull();

    const after = await loadDailyPlanData(todayDate(), ctx.client);
    expect(after.completedSets.length).toBe(beforeCount + 1);
    const adHoc = after.completedSets.find((cs) => cs.actual_reps === 10 && cs.actual_load === 100);
    expect(adHoc).toBeDefined();
  });

  it('planned_sets update (edit target_reps/target_load) round-trips', async () => {
    const { data: sets } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('planned_set_id, target_reps, target_load')
      .eq('plan_id', planId)
      .order('"order"')
      .limit(1);
    expect(sets!.length).toBeGreaterThan(0);
    const setId = sets![0].planned_set_id;
    const origReps = sets![0].target_reps;
    const origLoad = sets![0].target_load;

    const upd = await coachbyte(ctx.client)
      .from('planned_sets')
      .update({ target_reps: 8, target_load: 200 })
      .eq('planned_set_id', setId);
    expect(upd.error).toBeNull();

    const data = await loadDailyPlanData(todayDate(), ctx.client);
    const edited = data.sets.find((s) => s.planned_set_id === setId);
    expect(edited).toBeDefined();
    expect(edited!.target_reps).toBe(8);
    expect(edited!.target_load).toBe(200);

    // Restore to keep other tests deterministic.
    await coachbyte(ctx.client)
      .from('planned_sets')
      .update({ target_reps: origReps, target_load: origLoad })
      .eq('planned_set_id', setId);
  });

  it('planned_sets insert + delete round-trip', async () => {
    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(1);

    const beforeSets = (await loadDailyPlanData(todayDate(), ctx.client)).sets.length;
    const nextOrder = Math.max(0, ...(await loadDailyPlanData(todayDate(), ctx.client)).sets.map((s) => s.order)) + 1;

    const ins = await coachbyte(ctx.client)
      .from('planned_sets')
      .insert({
        plan_id: planId,
        user_id: ctx.userId,
        exercise_id: (exercises as any[])[0].exercise_id,
        target_reps: 10,
        target_load: 135,
        rest_seconds: 90,
        order: nextOrder,
      })
      .select('planned_set_id')
      .single();
    expect(ins.error).toBeNull();
    const newId = (ins.data as any).planned_set_id;

    const afterIns = await loadDailyPlanData(todayDate(), ctx.client);
    expect(afterIns.sets.length).toBe(beforeSets + 1);
    expect(afterIns.sets.some((s) => s.planned_set_id === newId)).toBe(true);

    const del = await coachbyte(ctx.client).from('planned_sets').delete().eq('planned_set_id', newId);
    expect(del.error).toBeNull();

    const afterDel = await loadDailyPlanData(todayDate(), ctx.client);
    expect(afterDel.sets.length).toBe(beforeSets);
    expect(afterDel.sets.some((s) => s.planned_set_id === newId)).toBe(false);
  });

  it('completed_sets delete by completed_set_id', async () => {
    const before = await loadDailyPlanData(todayDate(), ctx.client);
    expect(before.completedSets.length).toBeGreaterThanOrEqual(1);
    const targetId = before.completedSets[0].completed_set_id;

    const del = await coachbyte(ctx.client).from('completed_sets').delete().eq('completed_set_id', targetId);
    expect(del.error).toBeNull();

    const after = await loadDailyPlanData(todayDate(), ctx.client);
    expect(after.completedSets.length).toBe(before.completedSets.length - 1);
    expect(after.completedSets.some((cs) => cs.completed_set_id === targetId)).toBe(false);
  });

  it('daily_plans delete resets entire plan + cascades planned_sets', async () => {
    // Use a fresh date so we don't clobber the main planId.
    const testDate = '2026-01-15';
    const { data: fresh } = await (coachbyte(ctx.client) as any).rpc('ensure_daily_plan', { p_day: testDate });
    expect(fresh).not.toBeNull();

    const { data: exercises } = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .limit(1);

    await coachbyte(ctx.client)
      .from('planned_sets')
      .insert({
        plan_id: fresh.plan_id,
        user_id: ctx.userId,
        exercise_id: (exercises as any[])[0].exercise_id,
        target_reps: 5,
        target_load: 100,
        order: 1,
      });

    const del = await coachbyte(ctx.client).from('daily_plans').delete().eq('plan_id', fresh.plan_id);
    expect(del.error).toBeNull();

    const { data: planAfter } = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id')
      .eq('plan_id', fresh.plan_id);
    expect(planAfter!.length).toBe(0);

    const { data: setsAfter } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('planned_set_id')
      .eq('plan_id', fresh.plan_id);
    expect(setsAfter!.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // PR detection — the UI's completed-set handler queries
  // completed_sets for the same exercise and runs Epley to decide
  // whether to show a "NEW PR!" toast. The loader extraction doesn't
  // cover this branch (it's per-mutation), so keep the query inline
  // but import epley1RM from PrsPage so the numeric test stays coupled
  // to the one implementation that actually ships.
  // -------------------------------------------------------------------
  it('PR detection branch: new heavier set beats prior best', async () => {
    const exerciseId = Object.values(seeds.exerciseMap)[0]; // Squat
    const { data: prev } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load')
      .eq('exercise_id', exerciseId)
      .eq('user_id', ctx.userId);
    const prevBest = Math.max(0, ...(prev ?? []).map((ps: any) => epley1RM(Number(ps.actual_load), ps.actual_reps)));

    const newE1RM = epley1RM(500, 1); // 500 lb single — guaranteed PR
    expect(newE1RM).toBe(500);
    expect(newE1RM).toBeGreaterThan(prevBest);
  });

  it('PR detection branch: first-ever set for an exercise (prev best is 0)', async () => {
    const ins = await coachbyte(ctx.client)
      .from('exercises')
      .insert({ user_id: ctx.userId, name: 'Zercher Squat' })
      .select('exercise_id')
      .single();
    expect(ins.error).toBeNull();
    const customId = ins.data!.exercise_id;

    // No completed rows for this exercise yet — prev best must be 0.
    const { data: prev } = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('actual_reps, actual_load')
      .eq('exercise_id', customId)
      .eq('user_id', ctx.userId);
    expect((prev ?? []).length).toBe(0);
    const prevBest = Math.max(0, ...(prev ?? []).map((ps: any) => epley1RM(Number(ps.actual_load), ps.actual_reps)));
    expect(prevBest).toBe(0);

    // Cleanup
    await coachbyte(ctx.client).from('exercises').delete().eq('exercise_id', customId);
  });
});
