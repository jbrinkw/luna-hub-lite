import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, coachbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* Empty-fixture sibling for coach-history.test.ts (L9 audit) */

describe('CoachByte HistoryPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-history-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('daily_plans keyset query returns [] for a fresh user with no history', async () => {
    const result = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id,logical_date')
      .eq('user_id', ctx.userId)
      .order('logical_date', { ascending: false })
      .limit(20);

    const data = assertQuerySucceeds(result, 'daily_plans');
    expect(data).toEqual([]);
  });

  it('history pagination cursor handles an empty page without crashing', async () => {
    // Simulate a "load more" with no rows — must yield empty without throwing.
    const result = await coachbyte(ctx.client)
      .from('daily_plans')
      .select('plan_id,logical_date')
      .eq('user_id', ctx.userId)
      .lt('logical_date', '1970-01-02')
      .order('logical_date', { ascending: false })
      .limit(20);

    const data = assertQuerySucceeds(result, 'history pagination');
    expect(data).toEqual([]);
  });
});
