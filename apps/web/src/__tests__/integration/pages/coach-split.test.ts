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
    expect(typeof split.split_id).toBe('string');
    const todayWeekday = new Date().getDay();
    expect(split.weekday).toBe(todayWeekday);
    expect(Array.isArray(split.template_sets)).toBe(true);
    expect(split.template_sets.length).toBe(3);
    expect(split.split_notes).toBe('Integration test split');

    // Validate JSONB template_sets shape
    for (const s of split.template_sets as any[]) {
      expect(typeof s.exercise_id).toBe('string');
      expect(typeof s.target_reps).toBe('number');
      expect(typeof s.target_load).toBe('number');
      expect(typeof s.order).toBe('number');
    }

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
    expect(sets.length).toBe(3); // seedSplit creates 3 template sets

    // Validate JSONB shape: each template_set must have exercise_id, target_reps, target_load, order
    for (const s of sets) {
      expect(typeof s.exercise_id).toBe('string');
      expect(typeof s.target_reps).toBe('number');
      expect(typeof s.target_load).toBe('number');
      expect(typeof s.order).toBe('number');
    }

    // Verify exact values from seedSplit
    const squat = seeds.exerciseMap['Squat'];
    const bench = seeds.exerciseMap['Bench Press'];
    expect(sets[0]).toEqual({ exercise_id: squat, target_reps: 5, target_load: 225, order: 1 });
    expect(sets[1]).toEqual({ exercise_id: squat, target_reps: 5, target_load: 225, order: 2 });
    expect(sets[2]).toEqual({ exercise_id: bench, target_reps: 5, target_load: 185, order: 3 });
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
    expect(typeof data.split_id).toBe('string');
    expect(data.split_id.length).toBeGreaterThan(0);

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
  // SplitPage: template set with is_percentage=true stores relative load
  // Source: SplitPage.tsx line 287-294 — checkbox toggles target_load_percentage
  //   The UI stores target_load_percentage in the template_sets JSONB
  // -------------------------------------------------------------------
  it('template set with target_load_percentage stores relative load', async () => {
    const squat = seeds.exerciseMap['Squat'];
    const setsWithPct = [
      { exercise_id: squat, target_reps: 5, target_load: null, target_load_percentage: 80, rest_seconds: 90, order: 1 },
    ];

    const updateResult = await coachbyte(ctx.client)
      .from('splits')
      .update({ template_sets: setsWithPct as any })
      .eq('split_id', splitId);
    expect(updateResult.error).toBeNull();

    // Verify stored correctly
    const result = await coachbyte(ctx.client).from('splits').select('template_sets').eq('split_id', splitId).single();
    const data = assertQuerySucceeds(result, 'template_sets with percentage');
    const sets = data.template_sets as any[];
    expect(sets.length).toBe(1);
    expect(sets[0].target_load_percentage).toBe(80);
    expect(sets[0].target_load).toBeNull();
    expect(sets[0].target_reps).toBe(5);
  });

  // -------------------------------------------------------------------
  // SplitPage: template set with rest_seconds stores correctly
  // Source: SplitPage.tsx line 298-309 — rest_seconds input
  // -------------------------------------------------------------------
  it('template set with rest_seconds stores correctly', async () => {
    const bench = seeds.exerciseMap['Bench Press'];
    const setsWithRest = [
      { exercise_id: bench, target_reps: 8, target_load: 135, rest_seconds: 120, order: 1 },
      { exercise_id: bench, target_reps: 8, target_load: 135, rest_seconds: 60, order: 2 },
    ];

    const updateResult = await coachbyte(ctx.client)
      .from('splits')
      .update({ template_sets: setsWithRest as any })
      .eq('split_id', splitId);
    expect(updateResult.error).toBeNull();

    // Verify stored values
    const result = await coachbyte(ctx.client).from('splits').select('template_sets').eq('split_id', splitId).single();
    const data = assertQuerySucceeds(result, 'template_sets with rest');
    const sets = data.template_sets as any[];
    expect(sets.length).toBe(2);
    expect(sets[0].rest_seconds).toBe(120);
    expect(sets[1].rest_seconds).toBe(60);
  });

  // -------------------------------------------------------------------
  // SplitPage: removing middle set renumbers order
  // Source: SplitPage.tsx line 153-161 — removeSet
  //   const sets = s.template_sets.filter((_, i) => i !== setIndex)
  //     .map((set, i) => ({ ...set, order: i + 1 }));
  // -------------------------------------------------------------------
  it('removing middle set renumbers order correctly', async () => {
    const squat = seeds.exerciseMap['Squat'];
    const bench = seeds.exerciseMap['Bench Press'];

    // Store 3 sets
    const threeSets = [
      { exercise_id: squat, target_reps: 5, target_load: 225, order: 1 },
      { exercise_id: bench, target_reps: 8, target_load: 135, order: 2 },
      { exercise_id: squat, target_reps: 3, target_load: 275, order: 3 },
    ];

    await coachbyte(ctx.client)
      .from('splits')
      .update({ template_sets: threeSets as any })
      .eq('split_id', splitId);

    // Simulate removing the middle set (index 1) and renumbering (same as SplitPage removeSet)
    const remainingSets = threeSets.filter((_, i) => i !== 1).map((set, i) => ({ ...set, order: i + 1 }));

    expect(remainingSets.length).toBe(2);
    expect(remainingSets[0].order).toBe(1);
    expect(remainingSets[0].exercise_id).toBe(squat);
    expect(remainingSets[1].order).toBe(2);
    expect(remainingSets[1].exercise_id).toBe(squat);

    // Save and verify
    const updateResult = await coachbyte(ctx.client)
      .from('splits')
      .update({ template_sets: remainingSets as any })
      .eq('split_id', splitId);
    expect(updateResult.error).toBeNull();

    const result = await coachbyte(ctx.client).from('splits').select('template_sets').eq('split_id', splitId).single();
    const data = assertQuerySucceeds(result, 'template_sets after remove');
    const sets = data.template_sets as any[];
    expect(sets.length).toBe(2);
    expect(sets[0].order).toBe(1);
    expect(sets[1].order).toBe(2);
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
