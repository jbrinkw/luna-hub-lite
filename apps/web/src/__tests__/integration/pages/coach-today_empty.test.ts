import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, coachbyte, assertQuerySucceeds, todayDate, type PageTestContext } from './helpers';

/* Empty-fixture sibling for coach-today.test.ts (L9 audit) */

describe('CoachByte TodayPage loaders — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-today-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('ensure_daily_plan with no split returns a payload with empty planned_sets', async () => {
    const { data: payload, error: ensureErr } = await (ctx.client as any)
      .schema('coachbyte')
      .rpc('ensure_daily_plan', { p_day: todayDate() });

    expect(ensureErr).toBeNull();
    expect(payload).not.toBeNull();
    // Payload is a JSONB envelope { plan_id, planned_sets: [], ... }
    const planId: string =
      typeof payload === 'object' && payload !== null ? (payload.plan_id ?? payload.id ?? null) : null;
    expect(typeof planId).toBe('string');

    // Planned sets for that plan must be empty
    const { data: planned, error: plannedErr } = await coachbyte(ctx.client)
      .from('planned_sets')
      .select('planned_set_id,exercise_id,target_reps,target_load')
      .eq('plan_id', planId);
    expect(plannedErr).toBeNull();
    expect(planned).toEqual([]);
  });

  it('completed_sets returns [] for a fresh user', async () => {
    const result = await coachbyte(ctx.client)
      .from('completed_sets')
      .select('completed_set_id,actual_reps,actual_load')
      .eq('user_id', ctx.userId);

    const data = assertQuerySucceeds(result, 'completed_sets');
    expect(data).toEqual([]);
  });

  it('splits filtered by today returns empty list when no split is configured', async () => {
    const weekday = new Date().getDay();
    const result = await coachbyte(ctx.client)
      .from('splits')
      .select('split_id,template_sets')
      .eq('user_id', ctx.userId)
      .eq('weekday', weekday);

    const data = assertQuerySucceeds(result, 'splits');
    expect(data).toEqual([]);
  });
});
