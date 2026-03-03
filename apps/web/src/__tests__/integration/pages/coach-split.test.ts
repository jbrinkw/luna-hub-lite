import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPageTestContext,
  coachbyte,
  seedSplit,
  assertQuerySucceeds,
  type PageTestContext,
  type CoachByteSeeds,
} from './helpers';

describe('CoachByte SplitPage queries', () => {
  let ctx: PageTestContext;
  let seeds: CoachByteSeeds;
  let splitId: string;

  beforeAll(async () => {
    ctx = await createPageTestContext('coach-split');
    seeds = await seedSplit(ctx);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // SplitPage: splits query for all weekdays
  // Source: SplitPage.tsx line 41-46
  //   .from('splits')
  //   .select('split_id, weekday, template_sets, split_notes')
  //   .eq('user_id', user.id)
  //   .order('weekday')
  // -------------------------------------------------------------------
  it('splits query returns split_id, weekday, template_sets, split_notes', async () => {
    const result = await coachbyte(ctx.client)
      .from('splits')
      .select('split_id, weekday, template_sets, split_notes')
      .eq('user_id', ctx.userId)
      .order('weekday');

    const data = assertQuerySucceeds(result, 'splits query');
    expect(Array.isArray(data)).toBe(true);
    // seedSplit creates one split for today's weekday
    expect(data.length).toBeGreaterThanOrEqual(1);

    const split = data[0];
    expect(split).toHaveProperty('split_id');
    expect(split).toHaveProperty('weekday');
    expect(split).toHaveProperty('template_sets');
    expect(split).toHaveProperty('split_notes');
    expect(typeof split.weekday).toBe('number');
    expect(split.weekday).toBeGreaterThanOrEqual(0);
    expect(split.weekday).toBeLessThanOrEqual(6);
    expect(Array.isArray(split.template_sets)).toBe(true);
    expect(split.split_notes).toBe('Integration test split');

    splitId = split.split_id;
  });

  // -------------------------------------------------------------------
  // SplitPage: template_sets structure verification
  // The page reads template_sets JSONB and expects exercise_id, target_reps, etc.
  // -------------------------------------------------------------------
  it('template_sets JSONB has expected exercise fields', async () => {
    const result = await coachbyte(ctx.client).from('splits').select('template_sets').eq('split_id', splitId).single();

    const data = assertQuerySucceeds(result, 'template_sets');
    const sets = data.template_sets as any[];
    expect(sets.length).toBeGreaterThanOrEqual(1);

    const first = sets[0];
    expect(first).toHaveProperty('exercise_id');
    expect(first).toHaveProperty('target_reps');
    expect(first).toHaveProperty('target_load');
    expect(first).toHaveProperty('order');
  });

  // -------------------------------------------------------------------
  // SplitPage: exercises query (same as other pages)
  // Source: SplitPage.tsx line 71-77
  //   .from('exercises')
  //   .select('exercise_id, name')
  //   .or(`user_id.is.null,user_id.eq.${user.id}`)
  //   .order('name')
  // -------------------------------------------------------------------
  it('exercises query returns global exercises', async () => {
    const result = await coachbyte(ctx.client)
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name');

    const data = assertQuerySucceeds(result, 'exercises for split');
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0]).toHaveProperty('exercise_id');
    expect(data[0]).toHaveProperty('name');

    // Verify alphabetical ordering
    for (let i = 1; i < data.length; i++) {
      expect(data[i].name.localeCompare(data[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------
  // SplitPage: split update (template_sets + split_notes)
  // Source: SplitPage.tsx line 85-89
  //   .from('splits')
  //   .update({ template_sets: day.template_sets, split_notes: day.split_notes })
  //   .eq('split_id', day.split_id)
  // -------------------------------------------------------------------
  it('split update modifies template_sets and split_notes', async () => {
    const squat = seeds.exerciseMap['Squat'];
    const updatedSets = [{ exercise_id: squat, target_reps: 3, target_load: 315, order: 1 }];

    const updateResult = await coachbyte(ctx.client)
      .from('splits')
      .update({ template_sets: updatedSets as any, split_notes: 'Updated heavy day' })
      .eq('split_id', splitId);
    expect(updateResult.error).toBeNull();

    // Verify the update
    const result = await coachbyte(ctx.client)
      .from('splits')
      .select('template_sets, split_notes')
      .eq('split_id', splitId)
      .single();

    const data = assertQuerySucceeds(result, 'split after update');
    expect(data.split_notes).toBe('Updated heavy day');
    const sets = data.template_sets as any[];
    expect(sets.length).toBe(1);
    expect(sets[0].target_reps).toBe(3);
    expect(sets[0].target_load).toBe(315);
  });

  // -------------------------------------------------------------------
  // SplitPage: split insert for a new weekday
  // Source: SplitPage.tsx line 92-101
  //   .from('splits')
  //   .insert({ user_id, weekday, template_sets, split_notes })
  //   .select('split_id')
  //   .single()
  // -------------------------------------------------------------------
  it('split insert for new weekday returns split_id', async () => {
    const bench = seeds.exerciseMap['Bench Press'];
    // Pick a weekday different from today to avoid conflict
    const todayWeekday = new Date().getDay();
    const otherWeekday = (todayWeekday + 1) % 7;

    const newSets = [{ exercise_id: bench, target_reps: 8, target_load: 135, order: 1 }];

    const insertResult = await coachbyte(ctx.client)
      .from('splits')
      .insert({
        user_id: ctx.userId,
        weekday: otherWeekday,
        template_sets: newSets as any,
        split_notes: 'New day',
      })
      .select('split_id')
      .single();

    const data = assertQuerySucceeds(insertResult, 'split insert');
    expect(data).toHaveProperty('split_id');
    expect(typeof data.split_id).toBe('string');

    // Verify the new split appears in the full list
    const allResult = await coachbyte(ctx.client)
      .from('splits')
      .select('split_id, weekday')
      .eq('user_id', ctx.userId)
      .order('weekday');

    const allData = assertQuerySucceeds(allResult, 'all splits after insert');
    expect(allData.length).toBe(2);
  });

  // -------------------------------------------------------------------
  // SplitPage: weekday ordering is preserved in query
  // -------------------------------------------------------------------
  it('splits are ordered by weekday', async () => {
    const result = await coachbyte(ctx.client)
      .from('splits')
      .select('weekday')
      .eq('user_id', ctx.userId)
      .order('weekday');

    const data = assertQuerySucceeds(result, 'weekday ordering');
    for (let i = 1; i < data.length; i++) {
      expect(data[i].weekday).toBeGreaterThan(data[i - 1].weekday);
    }
  });
});
