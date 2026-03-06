import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUser, createToolContext, parseToolResult, admin } from './helpers';
import type { ToolContext } from '../../types';
import { getTodayPlan } from '../../coachbyte/get-today-plan';
import { completeNextSet } from '../../coachbyte/complete-next-set';
import { logSet } from '../../coachbyte/log-set';
import { getHistory } from '../../coachbyte/get-history';
import { getSplit } from '../../coachbyte/get-split';
import { updateSplit } from '../../coachbyte/update-split';
import { setTimer } from '../../coachbyte/set-timer';
import { getTimer } from '../../coachbyte/get-timer';
import { getPrs } from '../../coachbyte/get-prs';
import { updatePlan } from '../../coachbyte/update-plan';
import { updateSummary } from '../../coachbyte/update-summary';
import { pauseTimer } from '../../coachbyte/pause-timer';
import { resumeTimer } from '../../coachbyte/resume-timer';
import { resetTimer } from '../../coachbyte/reset-timer';
import { getExercises } from '../../coachbyte/get-exercises';

// ---------------------------------------------------------------------------
// CoachByte Tool Integration Tests
//
// These tests run sequentially against a local Supabase instance. Each test
// builds on state created by previous tests (plan creation, set completion,
// etc.), so ordering matters.
// ---------------------------------------------------------------------------

describe('CoachByte Tool Integration Tests', () => {
  let userId: string;
  let ctx: ToolContext;
  let cleanup: () => Promise<void>;

  // Shared state accumulated across sequential tests
  let planId: string;
  let squatId: string;
  let benchId: string;
  let exerciseMap: Record<string, string>;

  // Today's weekday (0=Sun, 6=Sat) — used for split seeding
  const todayWeekday = new Date().getDay();
  // A different weekday for updateSplit to avoid interfering with today's plan
  const otherWeekday = (todayWeekday + 1) % 7;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  beforeAll(async () => {
    // 1. Create test user with both modules activated
    const user = await createTestUser('coachbyte-tools');
    userId = user.userId;
    ctx = createToolContext(userId);
    cleanup = user.cleanup;

    // 2. Fetch global exercises
    const { data: exercises, error: exErr } = await admin
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name')
      .is('user_id', null);

    if (exErr || !exercises || exercises.length === 0) {
      throw new Error(`Failed to fetch global exercises: ${exErr?.message ?? 'no exercises found'}`);
    }

    exerciseMap = {};
    for (const e of exercises) {
      exerciseMap[e.name] = e.exercise_id;
    }

    squatId = exerciseMap['Squat'];
    benchId = exerciseMap['Bench Press'];
    if (!squatId || !benchId) {
      throw new Error('Global exercises Squat and Bench Press must exist in seeds');
    }

    // 3. Create a split for today's weekday so getTodayPlan can generate a plan
    const templateSets = [
      { exercise_id: squatId, target_reps: 5, target_load: 225, rest_seconds: 120, order: 1 },
      { exercise_id: squatId, target_reps: 5, target_load: 225, rest_seconds: 120, order: 2 },
      { exercise_id: benchId, target_reps: 5, target_load: 185, rest_seconds: 90, order: 3 },
    ];

    const { error: splitErr } = await admin.schema('coachbyte').from('splits').insert({
      user_id: userId,
      weekday: todayWeekday,
      template_sets: templateSets,
      split_notes: 'Integration test split',
    });

    if (splitErr) {
      throw new Error(`Failed to seed split: ${splitErr.message}`);
    }
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // 1. getTodayPlan — creates plan from split template
  // -------------------------------------------------------------------------

  it('getTodayPlan creates a plan from the seeded split and returns sets', async () => {
    const result = await getTodayPlan.handler({}, ctx);
    const data = parseToolResult(result);

    // Plan metadata
    expect(data.plan_id).toBeDefined();
    expect(typeof data.plan_id).toBe('string');
    expect(data.plan_date).toBeDefined();
    expect(data.logical_date).toBeDefined();

    // Save for subsequent tests
    planId = data.plan_id;

    // Sets from the split template — should have 3 planned sets
    expect(data.sets).toHaveLength(3);
    expect(data.total_planned).toBe(3);
    expect(data.completed_count).toBe(0);
    expect(data.ad_hoc_sets).toHaveLength(0);
    expect(data.ad_hoc_count).toBe(0);

    // Verify the set details match the template
    const squatSets = data.sets.filter((s: any) => s.exercise_id === squatId);
    expect(squatSets).toHaveLength(2);
    expect(squatSets[0].exercise_name).toBe('Squat');
    expect(squatSets[0].target_reps).toBe(5);
    expect(squatSets[0].target_load).toBe(225);
    expect(squatSets[0].completed).toBe(false);
    expect(squatSets[0].planned_set_id).toBeDefined();

    const benchSets = data.sets.filter((s: any) => s.exercise_id === benchId);
    expect(benchSets).toHaveLength(1);
    expect(benchSets[0].exercise_name).toBe('Bench Press');
    expect(benchSets[0].target_reps).toBe(5);
    expect(benchSets[0].target_load).toBe(185);
    expect(benchSets[0].completed).toBe(false);

    // Order should be ascending (1, 2, 3)
    expect(data.sets[0].order).toBe(1);
    expect(data.sets[1].order).toBe(2);
    expect(data.sets[2].order).toBe(3);
  });

  it('getTodayPlan is idempotent — calling again returns the same plan', async () => {
    const result = await getTodayPlan.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.plan_id).toBe(planId);
    expect(data.sets).toHaveLength(3);
    expect(data.completed_count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. completeNextSet — complete the first incomplete set
  // -------------------------------------------------------------------------

  it('completeNextSet completes the first set and returns rest_seconds of the next set', async () => {
    const result = await completeNextSet.handler({ plan_id: planId, reps: 5, load: 230 }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toContain('5 reps');
    expect(data.message).toContain('230');
    // rest_seconds comes from the NEXT incomplete set (order 2, rest_seconds: 120)
    expect(typeof data.rest_seconds).toBe('number');
    expect(data.rest_seconds).toBe(120);
  });

  it('after completeNextSet, getTodayPlan reflects the completed set', async () => {
    const result = await getTodayPlan.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.completed_count).toBe(1);
    expect(data.total_planned).toBe(3);

    // The first set (order 1) should now be completed
    const firstSet = data.sets.find((s: any) => s.order === 1);
    expect(firstSet?.completed).toBe(true);

    // The remaining two sets should still be incomplete
    const incompleteSets = data.sets.filter((s: any) => !s.completed);
    expect(incompleteSets).toHaveLength(2);
  });

  it('completeNextSet completes a second set', async () => {
    const result = await completeNextSet.handler({ plan_id: planId, reps: 5, load: 225 }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toContain('5 reps');
    expect(data.message).toContain('225');
  });

  it('completeNextSet completes the third and final set (rest_seconds: 0)', async () => {
    const result = await completeNextSet.handler({ plan_id: planId, reps: 5, load: 185 }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toContain('5 reps');
    expect(data.message).toContain('185');
    // No more sets after the last one, so rest_seconds is 0 (null coalesced)
    expect(data.rest_seconds).toBe(0);
  });

  it('completeNextSet when no incomplete sets remain returns rest_seconds: 0', async () => {
    // NOTE: The underlying RPC (complete_next_set) always returns one row.
    // When no incomplete sets remain, no insert happens but the handler
    // still returns success with rest_seconds: 0. This is a known limitation
    // of the RPC return type — it doesn't distinguish "completed last set"
    // from "nothing to complete".
    const result = await completeNextSet.handler({ plan_id: planId, reps: 5, load: 185 }, ctx);
    const data = parseToolResult(result);

    // The handler returns success with rest_seconds: 0 (null coalesced to 0)
    expect(data.rest_seconds).toBe(0);
    expect(data.message).toContain('5 reps');
  });

  it('after all sets completed, getTodayPlan shows completed_count === total_planned', async () => {
    const result = await getTodayPlan.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.completed_count).toBe(3);
    expect(data.total_planned).toBe(3);
    expect(data.sets.every((s: any) => s.completed)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. logSet — ad-hoc set (not part of the plan)
  // -------------------------------------------------------------------------

  it('logSet logs an ad-hoc set and returns completed_set_id', async () => {
    const result = await logSet.handler({ exercise_id: squatId, reps: 8, load: 185 }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toContain('Ad-hoc');
    expect(data.message).toContain('8 reps');
    expect(data.message).toContain('185');
    expect(data.completed_set_id).toBeDefined();
    expect(typeof data.completed_set_id).toBe('string');
    expect(data.completed_at).toBeDefined();
  });

  it('after logSet, getTodayPlan shows the ad-hoc set', async () => {
    const result = await getTodayPlan.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.ad_hoc_count).toBe(1);
    expect(data.ad_hoc_sets).toHaveLength(1);

    const adHoc = data.ad_hoc_sets[0];
    expect(adHoc.exercise_id).toBe(squatId);
    expect(adHoc.exercise_name).toBe('Squat');
    expect(adHoc.actual_reps).toBe(8);
    expect(adHoc.actual_load).toBe(185);
    expect(adHoc.ad_hoc).toBe(true);
    expect(adHoc.completed_at).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 4. getHistory — after completing sets
  // -------------------------------------------------------------------------

  it("getHistory returns today's plan with completed sets", async () => {
    const result = await getHistory.handler({ days: 7 }, ctx);
    const data = parseToolResult(result);

    expect(data.days).toBeDefined();
    expect(Array.isArray(data.days)).toBe(true);
    expect(data.days.length).toBeGreaterThanOrEqual(1);

    // Find today's plan in history
    const todayPlan = data.days.find((d: any) => d.plan_id === planId);
    expect(todayPlan).toBeDefined();
    expect(todayPlan.plan_id).toBe(planId);

    // Should have 4 total completed sets (3 from plan + 1 ad-hoc)
    expect(todayPlan.total_sets_completed).toBe(4);
    expect(todayPlan.completed_sets).toHaveLength(4);

    // Check completed set details
    const squatCompletedSets = todayPlan.completed_sets.filter((cs: any) => cs.exercise_name === 'Squat');
    expect(squatCompletedSets.length).toBeGreaterThanOrEqual(3); // 2 planned + 1 ad-hoc

    const benchCompletedSets = todayPlan.completed_sets.filter((cs: any) => cs.exercise_name === 'Bench Press');
    expect(benchCompletedSets).toHaveLength(1);
  });

  it('getHistory with days=0 returns an empty array', async () => {
    const result = await getHistory.handler({ days: 0 }, ctx);
    const data = parseToolResult(result);

    // days=0 means limit(0) — Supabase should return no rows
    expect(data.days).toHaveLength(0);
  });

  it('getHistory with default days works', async () => {
    const result = await getHistory.handler({}, ctx);
    const data = parseToolResult(result);

    // With no days arg, defaults to 7
    expect(data.days).toBeDefined();
    expect(data.days.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 5. getSplit — retrieve split configuration
  // -------------------------------------------------------------------------

  it('getSplit with no weekday returns all splits', async () => {
    const result = await getSplit.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.splits).toBeDefined();
    expect(Array.isArray(data.splits)).toBe(true);
    // We seeded one split for today's weekday
    expect(data.splits.length).toBeGreaterThanOrEqual(1);

    const todaySplit = data.splits.find((s: any) => s.weekday === todayWeekday);
    expect(todaySplit).toBeDefined();
    expect(todaySplit.day_name).toBe(dayNames[todayWeekday]);
    expect(todaySplit.split_id).toBeDefined();
    expect(todaySplit.template_sets).toHaveLength(3);

    // Verify exercise names are resolved
    const squatTemplate = todaySplit.template_sets.find((ts: any) => ts.exercise_id === squatId);
    expect(squatTemplate).toBeDefined();
    expect(squatTemplate.exercise_name).toBe('Squat');
  });

  it('getSplit with specific weekday filters correctly', async () => {
    const result = await getSplit.handler({ weekday: todayWeekday }, ctx);
    const data = parseToolResult(result);

    expect(data.splits).toHaveLength(1);
    expect(data.splits[0].weekday).toBe(todayWeekday);
  });

  it('getSplit for a weekday with no split returns empty array', async () => {
    // otherWeekday has no split yet (we only seeded todayWeekday)
    const result = await getSplit.handler({ weekday: otherWeekday }, ctx);
    const data = parseToolResult(result);

    expect(data.splits).toHaveLength(0);
    expect(data.message).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. updateSplit — set template for a different weekday
  // -------------------------------------------------------------------------

  it('updateSplit creates a split for a new weekday', async () => {
    const newTemplateSets = [
      { exercise_id: benchId, target_reps: 8, target_load: 155, rest_seconds: 90 },
      { exercise_id: benchId, target_reps: 8, target_load: 155, rest_seconds: 90 },
      { exercise_id: squatId, target_reps: 3, target_load: 275, rest_seconds: 180 },
    ];

    const result = await updateSplit.handler({ weekday: otherWeekday, template_sets: newTemplateSets }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toContain(dayNames[otherWeekday]);
    expect(data.split_id).toBeDefined();
    expect(data.weekday).toBe(otherWeekday);
    expect(data.day_name).toBe(dayNames[otherWeekday]);
    expect(data.template_sets).toHaveLength(3);
  });

  it('updateSplit overwrites existing split for the same weekday (upsert)', async () => {
    const updatedTemplateSets = [{ exercise_id: squatId, target_reps: 10, target_load: 135, rest_seconds: 60 }];

    const result = await updateSplit.handler({ weekday: otherWeekday, template_sets: updatedTemplateSets }, ctx);
    const data = parseToolResult(result);

    expect(data.template_sets).toHaveLength(1);
    expect(data.template_sets[0].exercise_id).toBe(squatId);
    expect(data.template_sets[0].target_reps).toBe(10);
    expect(data.template_sets[0].target_load).toBe(135);

    // L12 fix: Re-read DB to confirm old template_sets were replaced, not appended
    const { data: row, error } = await admin
      .schema('coachbyte')
      .from('splits')
      .select('template_sets')
      .eq('user_id', userId)
      .eq('weekday', otherWeekday)
      .single();
    expect(error).toBeNull();
    const dbSets = row!.template_sets as any[];
    expect(dbSets).toHaveLength(1);
    expect(dbSets[0].exercise_id).toBe(squatId);
    expect(dbSets[0].target_reps).toBe(10);
    expect(dbSets[0].target_load).toBe(135);
    expect(dbSets[0].rest_seconds).toBe(60);
  });

  it('updateSplit rejects invalid weekday', async () => {
    const result = await updateSplit.handler({ weekday: 7, template_sets: [] }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('weekday must be between');
  });

  it('after updateSplit, getSplit confirms both splits exist', async () => {
    const result = await getSplit.handler({}, ctx);
    const data = parseToolResult(result);

    // Should have at least 2 splits: today + otherWeekday
    expect(data.splits.length).toBeGreaterThanOrEqual(2);

    const other = data.splits.find((s: any) => s.weekday === otherWeekday);
    expect(other).toBeDefined();
    expect(other.template_sets).toHaveLength(1); // After the upsert overwrite
  });

  // -------------------------------------------------------------------------
  // 7. setTimer — start a rest timer
  // -------------------------------------------------------------------------

  it('setTimer starts a timer with the specified duration', async () => {
    const result = await setTimer.handler({ duration_seconds: 120 }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toContain('120 seconds');
    expect(data.timer_id).toBeDefined();
    expect(data.state).toBe('running');
    expect(data.duration_seconds).toBe(120);
    expect(data.end_time).toBeDefined();

    // end_time should be in the future
    const endMs = new Date(data.end_time).getTime();
    expect(endMs).toBeGreaterThan(Date.now() - 5000); // Allow 5s clock skew
  });

  it('setTimer rejects non-positive duration', async () => {
    const result = await setTimer.handler({ duration_seconds: 0 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('duration_seconds must be positive');
  });

  it('setTimer with negative duration is rejected', async () => {
    const result = await setTimer.handler({ duration_seconds: -10 }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('duration_seconds must be positive');
  });

  // -------------------------------------------------------------------------
  // 8. getTimer — check running timer state
  // -------------------------------------------------------------------------

  it('getTimer returns running timer with remaining_seconds > 0', async () => {
    // First, start a fresh timer with a large duration so it won't expire
    await setTimer.handler({ duration_seconds: 600 }, ctx);

    const result = await getTimer.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.timer_id).toBeDefined();
    expect(data.state).toBe('running');
    expect(data.remaining_seconds).toBeGreaterThan(0);
    expect(data.duration_seconds).toBe(600);
    expect(data.end_time).toBeDefined();
  });

  it('getTimer returns idle when no timer exists for another user', async () => {
    // Create a second user to verify timer isolation
    const user2 = await createTestUser('coachbyte-timer-iso');
    const ctx2 = createToolContext(user2.userId);

    try {
      const result = await getTimer.handler({}, ctx2);
      const data = parseToolResult(result);

      expect(data.state).toBe('idle');
      expect(data.remaining_seconds).toBe(0);
      expect(data.duration_seconds).toBe(0);
      expect(data.timer_id).toBeUndefined();
    } finally {
      await user2.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 9. getPrs — personal records via Epley formula
  // -------------------------------------------------------------------------

  it('getPrs returns PRs after completing sets', async () => {
    const result = await getPrs.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.prs).toBeDefined();
    expect(Array.isArray(data.prs)).toBe(true);

    // We completed sets for Squat and Bench Press, so we should have 2 PRs
    expect(data.prs.length).toBe(2);

    // Find Bench Press PR
    const benchPr = data.prs.find((pr: any) => pr.exercise_id === benchId);
    expect(benchPr).toBeDefined();
    expect(benchPr.exercise_name).toBe('Bench Press');
    expect(benchPr.estimated_1rm).toBeGreaterThan(0);
    expect(benchPr.best_set).toBeDefined();
    expect(benchPr.best_set.reps).toBe(5);
    expect(benchPr.best_set.load).toBe(185);
    expect(benchPr.best_set.date).toBeDefined();

    // Verify Epley formula: e1RM = load * (1 + reps/30) = 185 * (1 + 5/30) = 185 * 7/6 ~ 215.8
    const expectedBenchE1rm = Math.round(185 * (1 + 5 / 30) * 10) / 10;
    expect(benchPr.estimated_1rm).toBe(expectedBenchE1rm);

    // RM table should have 1RM through 10RM
    expect(benchPr.rm_table).toBeDefined();
    expect(benchPr.rm_table['1RM']).toBeDefined();
    expect(benchPr.rm_table['10RM']).toBeDefined();
    // 1RM should equal estimated_1rm
    expect(benchPr.rm_table['1RM']).toBe(benchPr.estimated_1rm);
    // Higher rep maxes should be lower
    expect(benchPr.rm_table['10RM']).toBeLessThan(benchPr.rm_table['1RM']);
  });

  it('getPrs filters by exercise_id', async () => {
    const result = await getPrs.handler({ exercise_id: squatId }, ctx);
    const data = parseToolResult(result);

    expect(data.prs).toHaveLength(1);
    expect(data.prs[0].exercise_id).toBe(squatId);
    expect(data.prs[0].exercise_name).toBe('Squat');

    // Best squat set: we did 5x230, 5x225, and 8x185 (ad-hoc)
    // Epley: 230*(1+5/30) = 268.3, 225*(1+5/30) = 262.5, 185*(1+8/30) = 234.3
    // Best is 5x230 with e1RM = 268.3
    const expectedSquatE1rm = Math.round(230 * (1 + 5 / 30) * 10) / 10;
    expect(data.prs[0].estimated_1rm).toBe(expectedSquatE1rm);
    expect(data.prs[0].best_set.reps).toBe(5);
    expect(data.prs[0].best_set.load).toBe(230);
  });

  it('getPrs for an exercise with no sets returns empty', async () => {
    // Use a random exercise ID that has no completed sets
    const deadliftId = exerciseMap['Deadlift'];
    if (deadliftId) {
      const result = await getPrs.handler({ exercise_id: deadliftId }, ctx);
      const data = parseToolResult(result);

      expect(data.prs).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // 10. updatePlan — replace planned sets for the existing plan
  // -------------------------------------------------------------------------

  it('updatePlan replaces all planned sets with new ones', async () => {
    const newSets = [
      { exercise_id: benchId, target_reps: 10, target_load: 135, rest_seconds: 60, order: 1 },
      { exercise_id: benchId, target_reps: 10, target_load: 135, rest_seconds: 60, order: 2 },
      { exercise_id: squatId, target_reps: 3, target_load: 315, rest_seconds: 180, order: 3 },
      { exercise_id: squatId, target_reps: 3, target_load: 315, rest_seconds: 180, order: 4 },
    ];

    const result = await updatePlan.handler({ plan_id: planId, sets: newSets }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toContain('4 sets');
    expect(data.plan_id).toBe(planId);
    expect(data.sets).toHaveLength(4);

    // Verify the new sets have the correct values
    const benchSets = data.sets.filter((s: any) => s.exercise_id === benchId);
    expect(benchSets).toHaveLength(2);
    for (const s of benchSets) {
      expect(s.target_reps).toBe(10);
      expect(s.target_load).toBe(135);
      expect(s.rest_seconds).toBe(60);
      expect(s.planned_set_id).toBeDefined();
    }

    const squatSets = data.sets.filter((s: any) => s.exercise_id === squatId);
    expect(squatSets).toHaveLength(2);
    for (const s of squatSets) {
      expect(s.target_reps).toBe(3);
      expect(s.target_load).toBe(315);
      expect(s.rest_seconds).toBe(180);
    }
  });

  it('after updatePlan, getTodayPlan reflects the new planned sets', async () => {
    const result = await getTodayPlan.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.plan_id).toBe(planId);
    // The old 3 sets were replaced by 4 new ones
    expect(data.total_planned).toBe(4);
    // The previously completed sets were tied to old planned_set_ids,
    // so completed_count should now be 0 (new planned sets are incomplete)
    expect(data.completed_count).toBe(0);
    // After updatePlan deletes old planned_sets, the FK (ON DELETE SET NULL)
    // nullifies planned_set_id on all 3 previously completed planned-set
    // completions. Combined with the 1 original ad-hoc, all 4 completed
    // sets now appear as ad-hoc (planned_set_id IS NULL).
    expect(data.ad_hoc_count).toBe(4);
  });

  it('updatePlan errors for a non-existent plan', async () => {
    const result = await updatePlan.handler(
      {
        plan_id: '00000000-0000-0000-0000-000000000000',
        sets: [{ exercise_id: squatId, target_reps: 5, target_load: 225, rest_seconds: 90, order: 1 }],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  // -------------------------------------------------------------------------
  // 11. updateSummary — update the plan's summary note
  // -------------------------------------------------------------------------

  it('updateSummary sets a summary on the plan', async () => {
    const summaryText = 'Great workout session - hit new PR on squats!';
    const result = await updateSummary.handler({ plan_id: planId, summary: summaryText }, ctx);
    const data = parseToolResult(result);

    expect(data.message).toBe('Summary updated');
    expect(data.plan_id).toBe(planId);
    expect(data.summary).toBe(summaryText);
  });

  it('after updateSummary, getTodayPlan reflects the new summary', async () => {
    const result = await getTodayPlan.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.summary).toBe('Great workout session - hit new PR on squats!');
  });

  it('updateSummary can overwrite the summary', async () => {
    const newSummary = 'Updated: rest day tomorrow';
    const result = await updateSummary.handler({ plan_id: planId, summary: newSummary }, ctx);
    const data = parseToolResult(result);

    expect(data.summary).toBe(newSummary);
  });

  it('updateSummary errors for a non-existent plan', async () => {
    const result = await updateSummary.handler(
      {
        plan_id: '00000000-0000-0000-0000-000000000000',
        summary: 'Should fail',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Edge cases and cross-cutting concerns
  // -------------------------------------------------------------------------

  it('logSet for a different exercise creates its own PR entry', async () => {
    // Log an ad-hoc set for bench press with a different weight
    await logSet.handler({ exercise_id: benchId, reps: 1, load: 275 }, ctx);

    // Check PRs — bench should now show the 1-rep max
    const result = await getPrs.handler({ exercise_id: benchId }, ctx);
    const data = parseToolResult(result);

    expect(data.prs).toHaveLength(1);
    // 1-rep set: e1RM = load (special case in the handler)
    expect(data.prs[0].estimated_1rm).toBe(275);
    expect(data.prs[0].best_set.reps).toBe(1);
    expect(data.prs[0].best_set.load).toBe(275);
  });

  it('getHistory after additional sets shows updated totals', async () => {
    const result = await getHistory.handler({ days: 1 }, ctx);
    const data = parseToolResult(result);

    expect(data.days.length).toBeGreaterThanOrEqual(1);
    const todayHistory = data.days.find((d: any) => d.plan_id === planId);
    expect(todayHistory).toBeDefined();

    // 3 original completed sets + 1 ad-hoc squat + 1 ad-hoc bench = 5
    expect(todayHistory.total_sets_completed).toBe(5);
  });

  it('setTimer overwrites existing timer (upsert by user_id)', async () => {
    // Set a 60-second timer
    const result1 = await setTimer.handler({ duration_seconds: 60 }, ctx);
    const data1 = parseToolResult(result1);
    const timerId = data1.timer_id;

    // Set a 90-second timer — should overwrite
    const result2 = await setTimer.handler({ duration_seconds: 90 }, ctx);
    const data2 = parseToolResult(result2);

    // Timer ID should be the same (upsert on user_id)
    expect(data2.timer_id).toBe(timerId);
    expect(data2.duration_seconds).toBe(90);
    expect(data2.state).toBe('running');
  });

  // -------------------------------------------------------------------------
  // 12. pauseTimer — pause a running rest timer
  // -------------------------------------------------------------------------

  it('pauseTimer pauses a running timer and returns remaining seconds', async () => {
    // Start a fresh timer with a large duration
    await setTimer.handler({ duration_seconds: 300 }, ctx);

    const result = await pauseTimer.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.state).toBe('paused');
    expect(data.timer_id).toBeDefined();
    expect(data.duration_seconds).toBe(300);
    expect(data.elapsed_seconds).toBeDefined();
    expect(typeof data.elapsed_seconds).toBe('number');
    expect(data.remaining_seconds).toBeGreaterThan(0);
    expect(data.remaining_seconds).toBeLessThanOrEqual(300);
    expect(data.message).toContain('paused');
  });

  it('pauseTimer errors when no timer exists', async () => {
    const freshUser = await createTestUser('coachbyte-pause-no-timer');
    const freshCtx = createToolContext(freshUser.userId);

    try {
      const result = await pauseTimer.handler({}, freshCtx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No active timer');
    } finally {
      await freshUser.cleanup();
    }
  });

  it('pauseTimer errors when timer is already paused', async () => {
    // Timer was paused in a previous test
    const result = await pauseTimer.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot pause');
    expect(result.content[0].text).toContain('paused');
  });

  // -------------------------------------------------------------------------
  // 13. resumeTimer — resume a paused rest timer
  // -------------------------------------------------------------------------

  it('resumeTimer resumes a paused timer and returns running state', async () => {
    // Timer is currently paused from previous tests
    const result = await resumeTimer.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.state).toBe('running');
    expect(data.timer_id).toBeDefined();
    expect(data.duration_seconds).toBe(300);
    expect(data.remaining_seconds).toBeGreaterThan(0);
    expect(data.end_time).toBeDefined();
    expect(data.message).toContain('resumed');
  });

  it('resumeTimer errors when no timer exists', async () => {
    const freshUser = await createTestUser('coachbyte-resume-no-timer');
    const freshCtx = createToolContext(freshUser.userId);

    try {
      const result = await resumeTimer.handler({}, freshCtx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No active timer');
    } finally {
      await freshUser.cleanup();
    }
  });

  it('resumeTimer errors when timer is already running', async () => {
    // Timer was resumed in a previous test — it's running now
    const result = await resumeTimer.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot resume');
    expect(result.content[0].text).toContain('running');
  });

  // -------------------------------------------------------------------------
  // 14. resetTimer — delete the current timer
  // -------------------------------------------------------------------------

  it('resetTimer deletes the running timer', async () => {
    // Timer is currently running from previous tests
    const result = await resetTimer.handler({}, ctx);
    const data = parseToolResult(result);

    expect(data.message).toBe('Timer reset');
    expect(data.state).toBe('idle');

    // Verify timer is gone
    const timerResult = await getTimer.handler({}, ctx);
    const timerData = parseToolResult(timerResult);
    expect(timerData.state).toBe('idle');
    expect(timerData.remaining_seconds).toBe(0);
  });

  it('resetTimer errors when no timer exists', async () => {
    // Timer was just deleted
    const result = await resetTimer.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No active timer');
  });

  // -------------------------------------------------------------------------
  // 15. getExercises — list exercises for the user
  // -------------------------------------------------------------------------

  describe('getExercises', () => {
    let userExerciseId: string;

    it('returns empty when user has no custom exercises', async () => {
      // The handler filters by user_id, so global (seeded) exercises won't appear
      const result = await getExercises.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.exercises).toBeInstanceOf(Array);
      // Global exercises have user_id=NULL, so they won't match .eq('user_id', ctx.userId)
      // User has not created any custom exercises yet
      expect(data.total).toBe(0);
    });

    it('returns user-created exercises after inserting one', async () => {
      // Create a user-specific exercise
      const { data: inserted, error } = await admin
        .schema('coachbyte')
        .from('exercises')
        .insert({ user_id: userId, name: 'Bulgarian Split Squat' })
        .select('exercise_id')
        .single();

      expect(error).toBeNull();
      userExerciseId = inserted!.exercise_id;

      const result = await getExercises.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(1);
      expect(data.exercises[0].name).toBe('Bulgarian Split Squat');
      expect(data.exercises[0].exercise_id).toBe(userExerciseId);
    });

    it('filters exercises by search term', async () => {
      // Add another exercise
      await admin.schema('coachbyte').from('exercises').insert({ user_id: userId, name: 'Romanian Deadlift' });

      // Search for "Bulgarian"
      const result = await getExercises.handler({ search: 'Bulgarian' }, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(1);
      expect(data.exercises[0].name).toBe('Bulgarian Split Squat');
    });

    it('returns all user exercises without search filter', async () => {
      const result = await getExercises.handler({}, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(2);
      // Ordered alphabetically
      expect(data.exercises[0].name).toBe('Bulgarian Split Squat');
      expect(data.exercises[1].name).toBe('Romanian Deadlift');
    });

    it('returns empty for non-matching search', async () => {
      const result = await getExercises.handler({ search: 'XYZNONEXISTENT' }, ctx);
      const data = parseToolResult(result);

      expect(data.total).toBe(0);
      expect(data.exercises).toEqual([]);
    });
  });
});
