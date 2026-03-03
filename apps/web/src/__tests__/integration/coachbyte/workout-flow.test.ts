import { describe, it, expect, afterEach } from 'vitest';
import { createTestUser, cleanupUser } from '../../test-helpers';

let userIds: string[] = [];

afterEach(async () => {
  for (const id of userIds) {
    await cleanupUser(id);
  }
  userIds = [];
});

/**
 * Helper: activate CoachByte for a user, fetch 2 global exercises,
 * create a split for today's weekday, and return everything needed for tests.
 */
async function setupWorkout(
  suffix: string,
  opts?: {
    buildTemplate?: (
      ex1: any,
      ex2: any,
    ) => Array<{
      exercise_id: string;
      target_reps: number;
      target_load: number;
      rest_seconds: number;
    }>;
  },
) {
  const { userId, email, client } = await createTestUser(suffix);
  userIds.push(userId);

  // Activate CoachByte (seeds user_settings)
  const { error: activateError } = await (client.schema('hub') as any).rpc('activate_app', { p_app_name: 'coachbyte' });
  expect(activateError).toBeNull();

  // Fetch 2 global exercises
  const { data: exercises, error: exError } = await (client.schema('coachbyte') as any)
    .from('exercises')
    .select('exercise_id, name')
    .is('user_id', null)
    .limit(2);
  expect(exError).toBeNull();
  expect(exercises).toHaveLength(2);

  const ex1 = exercises![0];
  const ex2 = exercises![1];

  const todayWeekday = 2;
  const todayDate = '2026-03-03';

  const templateSets = opts?.buildTemplate
    ? opts.buildTemplate(ex1, ex2)
    : [
        { exercise_id: ex1.exercise_id, target_reps: 5, target_load: 135, rest_seconds: 180 },
        { exercise_id: ex2.exercise_id, target_reps: 8, target_load: 95, rest_seconds: 120 },
      ];

  // Create split for today's weekday
  const { error: splitError } = await (client.schema('coachbyte') as any).from('splits').insert({
    user_id: userId,
    weekday: todayWeekday,
    template_sets: templateSets,
    split_notes: 'Integration test split',
  });
  expect(splitError).toBeNull();

  return { userId, email, client, ex1, ex2, todayDate, templateSets };
}

describe('CoachByte workout flow (real Supabase)', () => {
  it('ensure_daily_plan bootstraps from split template', async () => {
    const { client, todayDate, templateSets } = await setupWorkout('wf-bootstrap');

    // Call ensure_daily_plan for today
    const { data: planResult, error: planError } = await (client.schema('coachbyte') as any).rpc('ensure_daily_plan', {
      p_day: todayDate,
    });
    expect(planError).toBeNull();
    expect(planResult).toBeDefined();
    expect(planResult.status).toBe('created');
    expect(planResult.plan_id).toBeDefined();

    // Verify planned_sets were created from the split template
    const { data: plannedSets, error: psError } = await (client.schema('coachbyte') as any)
      .from('planned_sets')
      .select('planned_set_id, exercise_id, target_reps, target_load, rest_seconds, "order"')
      .eq('plan_id', planResult.plan_id)
      .order('"order"', { ascending: true });
    expect(psError).toBeNull();
    expect(plannedSets).toHaveLength(2);

    // Verify set 1 matches template
    expect(plannedSets![0].target_reps).toBe(templateSets[0].target_reps);
    expect(Number(plannedSets![0].target_load)).toBe(templateSets[0].target_load);
    expect(plannedSets![0].rest_seconds).toBe(templateSets[0].rest_seconds);
    expect(plannedSets![0].exercise_id).toBe(templateSets[0].exercise_id);
    expect(plannedSets![0].order).toBe(1);

    // Verify set 2 matches template
    expect(plannedSets![1].target_reps).toBe(templateSets[1].target_reps);
    expect(Number(plannedSets![1].target_load)).toBe(templateSets[1].target_load);
    expect(plannedSets![1].rest_seconds).toBe(templateSets[1].rest_seconds);
    expect(plannedSets![1].exercise_id).toBe(templateSets[1].exercise_id);
    expect(plannedSets![1].order).toBe(2);
  });

  it('complete_next_set processes sets in order and returns correct rest_seconds', async () => {
    const { client } = await setupWorkout('wf-complete', {
      buildTemplate: (ex1, ex2) => [
        { exercise_id: ex1.exercise_id, target_reps: 5, target_load: 135, rest_seconds: 180 },
        { exercise_id: ex1.exercise_id, target_reps: 5, target_load: 155, rest_seconds: 120 },
        { exercise_id: ex2.exercise_id, target_reps: 8, target_load: 95, rest_seconds: 90 },
      ],
    });

    const todayDate = '2026-03-03';

    // Bootstrap daily plan with 3 sets
    const { data: planResult, error: planError } = await (client.schema('coachbyte') as any).rpc('ensure_daily_plan', {
      p_day: todayDate,
    });
    expect(planError).toBeNull();
    expect(planResult.status).toBe('created');

    const planId = planResult.plan_id;

    // Complete set 1 → should return rest_seconds of set 2 (120)
    const { data: result1, error: err1 } = await (client.schema('coachbyte') as any).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 135,
    });
    expect(err1).toBeNull();
    expect(result1).toHaveLength(1);
    expect(result1![0].rest_seconds).toBe(120);

    // Complete set 2 → should return rest_seconds of set 3 (90)
    const { data: result2, error: err2 } = await (client.schema('coachbyte') as any).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 155,
    });
    expect(err2).toBeNull();
    expect(result2).toHaveLength(1);
    expect(result2![0].rest_seconds).toBe(90);

    // Complete set 3 → should return null rest_seconds (no more sets)
    const { data: result3, error: err3 } = await (client.schema('coachbyte') as any).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 8,
      p_load: 95,
    });
    expect(err3).toBeNull();
    expect(result3).toHaveLength(1);
    expect(result3![0].rest_seconds).toBeNull();

    // Verify 3 completed_sets exist for this plan
    const { data: completedSets, error: csError } = await (client.schema('coachbyte') as any)
      .from('completed_sets')
      .select('completed_set_id, actual_reps, actual_load')
      .eq('plan_id', planId);
    expect(csError).toBeNull();
    expect(completedSets).toHaveLength(3);
  });

  it('ensure_daily_plan is idempotent', async () => {
    const { client, todayDate } = await setupWorkout('wf-idempotent');

    // First call → creates the plan
    const { data: first, error: err1 } = await (client.schema('coachbyte') as any).rpc('ensure_daily_plan', {
      p_day: todayDate,
    });
    expect(err1).toBeNull();
    expect(first.status).toBe('created');
    expect(first.plan_id).toBeDefined();

    // Second call → returns the same plan
    const { data: second, error: err2 } = await (client.schema('coachbyte') as any).rpc('ensure_daily_plan', {
      p_day: todayDate,
    });
    expect(err2).toBeNull();
    expect(second.status).toBe('existing');
    expect(second.plan_id).toBe(first.plan_id);

    // Verify planned_sets were not duplicated (still exactly 2 from template)
    const { data: plannedSets, error: psError } = await (client.schema('coachbyte') as any)
      .from('planned_sets')
      .select('planned_set_id')
      .eq('plan_id', first.plan_id);
    expect(psError).toBeNull();
    expect(plannedSets).toHaveLength(2);
  });

  it('completed_sets have correct logical_date matching plan', async () => {
    const { client, todayDate } = await setupWorkout('wf-logdate');

    // Bootstrap plan
    const { data: planResult, error: planError } = await (client.schema('coachbyte') as any).rpc('ensure_daily_plan', {
      p_day: todayDate,
    });
    expect(planError).toBeNull();

    const planId = planResult.plan_id;

    // Complete one set
    const { error: completeError } = await (client.schema('coachbyte') as any).rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: 5,
      p_load: 135,
    });
    expect(completeError).toBeNull();

    // Query the plan's logical_date
    const { data: plan, error: planReadError } = await (client.schema('coachbyte') as any)
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();
    expect(planReadError).toBeNull();
    expect(plan).toBeDefined();

    // Query the completed set's logical_date
    const { data: completed, error: csError } = await (client.schema('coachbyte') as any)
      .from('completed_sets')
      .select('logical_date')
      .eq('plan_id', planId);
    expect(csError).toBeNull();
    expect(completed).toHaveLength(1);

    // Verify they match
    expect(completed![0].logical_date).toBe(plan!.logical_date);
  });
});
