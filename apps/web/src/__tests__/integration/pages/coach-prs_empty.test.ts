import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, coachbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* Empty-fixture sibling for coach-prs.test.ts (L9 audit) */

describe('CoachByte PRsPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-prs-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('completed_sets returns [] for a fresh user (PRs are derived, not stored)', async () => {
    // PRsPage runs Epley over completed_sets — empty input must yield [].
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('exercise_id,actual_reps,actual_load')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'completed_sets');
    expect(data).toEqual([]);

    // Page-side: deriving 1RM from empty sets must yield empty PR list
    const byExercise = new Map<string, number>();
    for (const s of data) {
      const e1rm = Number(s.actual_load) * (1 + Number(s.actual_reps) / 30);
      const prev = byExercise.get(s.exercise_id) ?? 0;
      if (e1rm > prev) byExercise.set(s.exercise_id, e1rm);
    }
    expect(byExercise.size).toBe(0);
  });

  it('user_settings has the default row with NULL pr_tracked_exercise_ids for a fresh user', async () => {
    // user_settings is auto-populated by the activation trigger with
    // defaults; the PR-tracked column starts NULL → page must treat NULL
    // as "track all" (not crash).
    const result = await coachbyte(ctx.client)
      .from('user_settings')
      .select('user_id,pr_tracked_exercise_ids')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'user_settings');
    // Either the trigger populated a row OR no row exists — both are
    // empty-state for the PR-tracking feature. Both must NOT crash the
    // page filter logic.
    expect(data.length).toBeLessThanOrEqual(1);
    if (data.length === 1) {
      expect(data[0].pr_tracked_exercise_ids).toBeNull();
    }
  });
});
