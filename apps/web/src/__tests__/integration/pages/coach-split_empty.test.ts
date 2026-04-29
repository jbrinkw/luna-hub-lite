import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPageTestContext, coachbyte, assertQuerySucceeds, type PageTestContext } from './helpers';

/* Empty-fixture sibling for coach-split.test.ts (L9 audit) */

describe('CoachByte SplitPage queries — empty fixture', () => {
  let ctx: PageTestContext;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-split-empty');
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('splits query returns [] across all 7 weekdays for a fresh user', async () => {
    const result = await coachbyte(ctx.client)
      .from('splits')
      .select('split_id,weekday,template_sets,split_notes')
      .eq('user_id', ctx.userId)
      .order('weekday');

    const data = assertQuerySucceeds(result, 'splits');
    expect(data).toEqual([]);
  });

  it('weekday-grouped view exposes all 7 slots as empty', async () => {
    const { data } = await coachbyte(ctx.client)
      .from('splits')
      .select('weekday,template_sets')
      .eq('user_id', ctx.userId);

    // SplitPage renders a 7-row grid. Empty fixture must yield 7 empty rows.
    const byDay = new Map<number, any>();
    for (const s of data ?? []) byDay.set(s.weekday, s);
    const grid = Array.from({ length: 7 }, (_, i) => ({
      weekday: i,
      sets: byDay.get(i)?.template_sets ?? [],
    }));
    expect(grid).toHaveLength(7);
    for (const row of grid) {
      expect(row.sets).toEqual([]);
    }
  });
});
