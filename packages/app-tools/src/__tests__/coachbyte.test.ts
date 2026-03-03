import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTodayPlan } from '../coachbyte/get-today-plan';
import { completeNextSet } from '../coachbyte/complete-next-set';
import { logSet } from '../coachbyte/log-set';
import { updatePlan } from '../coachbyte/update-plan';
import { updateSummary } from '../coachbyte/update-summary';
import { getHistory } from '../coachbyte/get-history';
import { getSplit } from '../coachbyte/get-split';
import { updateSplit } from '../coachbyte/update-split';
import { setTimer } from '../coachbyte/set-timer';
import { getTimer } from '../coachbyte/get-timer';
import { getPrs } from '../coachbyte/get-prs';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------
// Each schema ('hub', 'coachbyte') gets its own chain + from + rpc so tests
// can configure independent resolve values per schema and per call sequence.

interface ChainMock {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  lte: ReturnType<typeof vi.fn>;
  then?: (resolve: (v: any) => void, reject?: (e: any) => void) => void;
  data: any;
  error: any;
}

function createChain(): ChainMock {
  const chain: any = {};
  const methods = [
    'select', 'eq', 'neq', 'in', 'is', 'order', 'limit',
    'single', 'maybeSingle', 'insert', 'update', 'delete', 'upsert',
    'gte', 'lte',
  ];
  methods.forEach((m) => {
    chain[m] = vi.fn(() => chain);
  });
  chain.data = null;
  chain.error = null;
  // Make the chain thenable so `await chain` resolves to { data, error }
  chain.then = function (
    resolve: (v: any) => void,
    _reject?: (e: any) => void,
  ) {
    return Promise.resolve({ data: chain.data, error: chain.error }).then(resolve, _reject);
  };
  return chain;
}

function createMockSupabase() {
  const hubChain = createChain();
  const cbChain = createChain();

  const hubFrom = vi.fn(() => hubChain);
  const hubRpc = vi.fn((): any => ({ data: null, error: null }));
  const cbFrom = vi.fn(() => cbChain);
  const cbRpc = vi.fn((): any => ({ data: null, error: null }));

  const schemaMap: Record<string, { from: any; rpc: any }> = {
    hub: { from: hubFrom, rpc: hubRpc },
    coachbyte: { from: cbFrom, rpc: cbRpc },
  };

  const schema = vi.fn((name: string) => schemaMap[name] ?? { from: vi.fn(), rpc: vi.fn() });

  // Top-level rpc (used when handler calls supabase.rpc() directly, without .schema())
  const rpc = vi.fn((): any => ({ data: null, error: null }));

  return {
    supabase: { schema, rpc } as any,
    schema,
    rpc,
    hubChain,
    cbChain,
    hubFrom,
    cbFrom,
    hubRpc,
    cbRpc,
  };
}

const USER_ID = 'user-uuid-123';

function ctx(supabase: any) {
  return { userId: USER_ID, supabase };
}

/** Parse the JSON text from a toolSuccess/toolError result */
function parseResult(result: any) {
  try {
    return JSON.parse(result.content[0].text);
  } catch {
    return result.content[0].text;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
// NOTE: Handlers intentionally do not have try/catch — unhandled exceptions
// propagate to the MCP worker's top-level error handling layer. This is by
// design, so we do not test for uncaught exception behavior here.

describe('COACHBYTE_get_today_plan', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
    // getLogicalDate reads hub.profiles
    mock.hubChain.data = { timezone: 'America/New_York', day_start_hour: 6 };
    mock.hubChain.error = null;
  });

  it('returns plan with sets on success', async () => {
    // rpc ensure_daily_plan_admin
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    // Three chained queries: daily_plans, planned_sets, completed_sets
    // Because all three use cbChain, we need to cycle data per call.
    // We use mockReturnValueOnce on cbFrom to return separate chains.
    const planChain = createChain();
    planChain.data = { plan_id: 'plan-1', plan_date: '2026-03-03', summary: 'Push day', logical_date: '2026-03-03' };

    const psChain = createChain();
    psChain.data = [
      { planned_set_id: 'ps-1', exercise_id: 'ex-1', target_reps: 8, target_load: 135, rest_seconds: 90, order: 1, exercises: { name: 'Bench Press' } },
    ];

    const csChain = createChain();
    csChain.data = [];

    mock.cbFrom
      .mockReturnValueOnce(planChain)
      .mockReturnValueOnce(psChain)
      .mockReturnValueOnce(csChain);

    const result = await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.plan_id).toBe('plan-1');
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.sets[0].exercise_name).toBe('Bench Press');
    expect(parsed.total_planned).toBe(1);
    expect(parsed.completed_count).toBe(0);
  });

  it('returns toolError when rpc fails', async () => {
    mock.rpc.mockReturnValue({ data: null, error: { message: 'rpc boom' } });

    const result = await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rpc boom');
  });

  it('returns toolError when rpc returns null plan_id', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: null }, error: null });

    const result = await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No plan_id returned');
  });

  it('returns toolError when plan fetch fails', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    const planChain = createChain();
    planChain.data = null;
    planChain.error = { message: 'plan not found' };
    mock.cbFrom.mockReturnValueOnce(planChain);

    const result = await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('plan not found');
  });

  it('returns toolError when planned_sets query fails', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    const planChain = createChain();
    planChain.data = { plan_id: 'plan-1', plan_date: '2026-03-03', summary: 'Push day', logical_date: '2026-03-03' };

    const psChain = createChain();
    psChain.data = null;
    psChain.error = { message: 'planned sets query boom' };

    mock.cbFrom
      .mockReturnValueOnce(planChain)
      .mockReturnValueOnce(psChain);

    const result = await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('planned sets query boom');
  });

  it('returns toolError when completed_sets query fails', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    const planChain = createChain();
    planChain.data = { plan_id: 'plan-1', plan_date: '2026-03-03', summary: 'Push day', logical_date: '2026-03-03' };

    const psChain = createChain();
    psChain.data = [
      { planned_set_id: 'ps-1', exercise_id: 'ex-1', target_reps: 8, target_load: 135, rest_seconds: 90, order: 1, exercises: { name: 'Bench Press' } },
    ];

    const csChain = createChain();
    csChain.data = null;
    csChain.error = { message: 'completed sets query boom' };

    mock.cbFrom
      .mockReturnValueOnce(planChain)
      .mockReturnValueOnce(psChain)
      .mockReturnValueOnce(csChain);

    const result = await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('completed sets query boom');
  });

  it('includes ad_hoc_sets for completed sets with no planned_set_id', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    const planChain = createChain();
    planChain.data = { plan_id: 'plan-1', plan_date: '2026-03-03', summary: 'Push day', logical_date: '2026-03-03' };

    const psChain = createChain();
    psChain.data = [
      { planned_set_id: 'ps-1', exercise_id: 'ex-1', target_reps: 8, target_load: 135, rest_seconds: 90, order: 1, exercises: { name: 'Bench Press' } },
    ];

    const csChain = createChain();
    csChain.data = [
      { completed_set_id: 'cs-1', planned_set_id: 'ps-1', exercise_id: 'ex-1', actual_reps: 8, actual_load: 135, completed_at: '2026-03-03T10:00:00Z', exercises: { name: 'Bench Press' } },
      { completed_set_id: 'cs-2', planned_set_id: null, exercise_id: 'ex-2', actual_reps: 12, actual_load: 50, completed_at: '2026-03-03T10:30:00Z', exercises: { name: 'Curls' } },
    ];

    mock.cbFrom
      .mockReturnValueOnce(planChain)
      .mockReturnValueOnce(psChain)
      .mockReturnValueOnce(csChain);

    const result = await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.ad_hoc_sets).toHaveLength(1);
    expect(parsed.ad_hoc_sets[0].completed_set_id).toBe('cs-2');
    expect(parsed.ad_hoc_sets[0].exercise_name).toBe('Curls');
    expect(parsed.ad_hoc_sets[0].ad_hoc).toBe(true);
    expect(parsed.ad_hoc_sets[0].actual_reps).toBe(12);
    expect(parsed.ad_hoc_sets[0].actual_load).toBe(50);
    expect(parsed.ad_hoc_count).toBe(1);
    // The planned set should be marked as completed
    expect(parsed.sets[0].completed).toBe(true);
    expect(parsed.completed_count).toBe(1);
  });

  it('queries the correct tables (daily_plans, planned_sets, completed_sets)', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    const planChain = createChain();
    planChain.data = { plan_id: 'plan-1', plan_date: '2026-03-03', summary: 'Push day', logical_date: '2026-03-03' };

    const psChain = createChain();
    psChain.data = [];

    const csChain = createChain();
    csChain.data = [];

    mock.cbFrom
      .mockReturnValueOnce(planChain)
      .mockReturnValueOnce(psChain)
      .mockReturnValueOnce(csChain);

    await getTodayPlan.handler({}, ctx(mock.supabase));

    expect(mock.cbFrom).toHaveBeenCalledWith('daily_plans');
    expect(mock.cbFrom).toHaveBeenCalledWith('planned_sets');
    expect(mock.cbFrom).toHaveBeenCalledWith('completed_sets');
  });
});

describe('COACHBYTE_complete_next_set', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns success with rest_seconds', async () => {
    mock.rpc.mockReturnValue({
      data: [{ rest_seconds: 90 }],
      error: null,
    });

    const result = await completeNextSet.handler(
      { plan_id: 'plan-1', reps: 8, load: 135 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.rest_seconds).toBe(90);
    expect(parsed.message).toContain('8 reps @ 135 lbs');
    expect(mock.rpc).toHaveBeenCalledWith(
      'complete_next_set_admin',
      expect.objectContaining({ p_plan_id: 'plan-1', p_actual_reps: 8, p_actual_load: 135 }),
      { schema: 'coachbyte' },
    );
  });

  it('returns error when no incomplete sets remain', async () => {
    mock.rpc.mockReturnValue({ data: [], error: null });

    const result = await completeNextSet.handler(
      { plan_id: 'plan-1', reps: 8, load: 135 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No incomplete sets');
  });

  it('returns error on rpc failure', async () => {
    mock.rpc.mockReturnValue({ data: null, error: { message: 'db error' } });

    const result = await completeNextSet.handler(
      { plan_id: 'plan-1', reps: 8, load: 135 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('db error');
  });
});

describe('COACHBYTE_log_set', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
    mock.hubChain.data = { timezone: 'America/New_York', day_start_hour: 6 };
    mock.hubChain.error = null;
  });

  it('inserts an ad-hoc set and returns success', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    const insertChain = createChain();
    insertChain.data = {
      completed_set_id: 'cs-1',
      actual_reps: 10,
      actual_load: 100,
      completed_at: '2026-03-03T12:00:00Z',
    };
    mock.cbFrom.mockReturnValueOnce(insertChain);

    const result = await logSet.handler(
      { exercise_id: 'ex-1', reps: 10, load: 100 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.completed_set_id).toBe('cs-1');
    expect(parsed.message).toContain('10 reps @ 100 lbs');

    // Verify insert was called with correct fields (matches log-set.ts handler)
    expect(insertChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      planned_set_id: null,
      exercise_id: 'ex-1',
      actual_reps: 10,
      actual_load: 100,
    }));
  });

  it('returns error when ensure_daily_plan rpc fails', async () => {
    mock.rpc.mockReturnValue({ data: null, error: { message: 'rpc fail' } });

    const result = await logSet.handler(
      { exercise_id: 'ex-1', reps: 10, load: 100 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rpc fail');
  });

  it('returns error when rpc returns null plan_id', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: null }, error: null });

    const result = await logSet.handler(
      { exercise_id: 'ex-1', reps: 10, load: 100 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No plan_id returned');
  });

  it('returns error when insert fails', async () => {
    mock.rpc.mockReturnValue({ data: { plan_id: 'plan-1' }, error: null });

    const insertChain = createChain();
    insertChain.data = null;
    insertChain.error = { message: 'insert error' };
    mock.cbFrom.mockReturnValueOnce(insertChain);

    const result = await logSet.handler(
      { exercise_id: 'ex-1', reps: 10, load: 100 },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('insert error');
  });
});

describe('COACHBYTE_update_plan', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('replaces planned sets and returns success', async () => {
    // First call: verify plan ownership
    const verifyChain = createChain();
    verifyChain.data = { plan_id: 'plan-1' };
    // Second call: delete existing sets
    const deleteChain = createChain();
    deleteChain.data = null;
    deleteChain.error = null;
    // Third call: insert new sets
    const insertChain = createChain();
    insertChain.data = [
      { planned_set_id: 'ps-new', exercise_id: 'ex-1', target_reps: 10, target_load: 100, rest_seconds: 60, order: 1 },
    ];

    mock.cbFrom
      .mockReturnValueOnce(verifyChain)
      .mockReturnValueOnce(deleteChain)
      .mockReturnValueOnce(insertChain);

    const sets = [
      { exercise_id: 'ex-1', target_reps: 10, target_load: 100, rest_seconds: 60, order: 1 },
    ];

    const result = await updatePlan.handler({ plan_id: 'plan-1', sets }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('1 sets');
    expect(parsed.plan_id).toBe('plan-1');

    // Verify delete().eq() was called on planned_sets before insert
    expect(deleteChain.delete).toHaveBeenCalled();
    expect(deleteChain.eq).toHaveBeenCalledWith('plan_id', 'plan-1');

    // Verify insert was called with the new sets
    expect(insertChain.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        plan_id: 'plan-1',
        exercise_id: 'ex-1',
        target_reps: 10,
        target_load: 100,
        rest_seconds: 60,
        order: 1,
      }),
    ]);
  });

  it('returns error when plan not owned by user', async () => {
    const verifyChain = createChain();
    verifyChain.data = null;
    verifyChain.error = { message: 'not found' };
    mock.cbFrom.mockReturnValueOnce(verifyChain);

    const result = await updatePlan.handler(
      { plan_id: 'plan-1', sets: [] },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

describe('COACHBYTE_update_summary', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('updates summary and returns the DB value (not the input)', async () => {
    // Mock returns a DIFFERENT summary than input to prove handler returns data.summary
    mock.cbChain.data = { plan_id: 'plan-1', summary: 'Leg day (trimmed by DB)' };
    mock.cbChain.error = null;

    const result = await updateSummary.handler(
      { plan_id: 'plan-1', summary: '  Leg day (trimmed by DB)  ' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    // The handler returns data.summary from the DB, not the input args.summary
    expect(parsed.summary).toBe('Leg day (trimmed by DB)');
    expect(parsed.message).toBe('Summary updated');
  });

  it('returns error when update fails', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'update failed' };

    const result = await updateSummary.handler(
      { plan_id: 'plan-1', summary: 'whatever' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('update failed');
  });

  it('returns error when plan not found', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = null;

    const result = await updateSummary.handler(
      { plan_id: 'plan-x', summary: 'test' },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not owned by user');
  });
});

describe('COACHBYTE_get_history', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns grouped history on success', async () => {
    const plansChain = createChain();
    plansChain.data = [
      { plan_id: 'p1', plan_date: '2026-03-02', summary: 'Push', logical_date: '2026-03-02' },
    ];

    const csChain = createChain();
    csChain.data = [
      { completed_set_id: 'cs-1', plan_id: 'p1', exercise_id: 'ex-1', actual_reps: 8, actual_load: 135, completed_at: '2026-03-02T10:00:00Z', exercises: { name: 'Bench' } },
    ];

    mock.cbFrom
      .mockReturnValueOnce(plansChain)
      .mockReturnValueOnce(csChain);

    const result = await getHistory.handler({ days: 7 }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.days).toHaveLength(1);
    expect(parsed.days[0].total_sets_completed).toBe(1);
  });

  it('returns empty message when no history', async () => {
    const plansChain = createChain();
    plansChain.data = [];
    mock.cbFrom.mockReturnValueOnce(plansChain);

    const result = await getHistory.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.message).toContain('No workout history');
  });

  it('returns error when plans query fails', async () => {
    const plansChain = createChain();
    plansChain.data = null;
    plansChain.error = { message: 'query failed' };
    mock.cbFrom.mockReturnValueOnce(plansChain);

    const result = await getHistory.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query failed');
  });

  it('returns error when completed_sets query fails', async () => {
    const plansChain = createChain();
    plansChain.data = [
      { plan_id: 'p1', plan_date: '2026-03-02', summary: 'Push', logical_date: '2026-03-02' },
    ];

    const csChain = createChain();
    csChain.data = null;
    csChain.error = { message: 'completed sets fetch failed' };

    mock.cbFrom
      .mockReturnValueOnce(plansChain)
      .mockReturnValueOnce(csChain);

    const result = await getHistory.handler({ days: 7 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('completed sets fetch failed');
  });
});

describe('COACHBYTE_get_split', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns splits with exercise names resolved', async () => {
    const splitsChain = createChain();
    splitsChain.data = [
      { split_id: 's1', weekday: 1, template_sets: [{ exercise_id: 'ex-1', target_reps: 8, target_load: 135, rest_seconds: 90 }] },
    ];

    const exercisesChain = createChain();
    exercisesChain.data = [{ exercise_id: 'ex-1', name: 'Bench Press' }];

    mock.cbFrom
      .mockReturnValueOnce(splitsChain)
      .mockReturnValueOnce(exercisesChain);

    const result = await getSplit.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.splits).toHaveLength(1);
    expect(parsed.splits[0].day_name).toBe('Monday');
    expect(parsed.splits[0].template_sets[0].exercise_name).toBe('Bench Press');
  });

  it('returns empty when no splits configured', async () => {
    const splitsChain = createChain();
    splitsChain.data = [];
    mock.cbFrom.mockReturnValueOnce(splitsChain);

    const result = await getSplit.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.splits).toEqual([]);
  });

  it('filters by weekday when provided', async () => {
    const splitsChain = createChain();
    splitsChain.data = [
      { split_id: 's1', weekday: 3, template_sets: [] },
    ];
    mock.cbFrom.mockReturnValueOnce(splitsChain);

    const result = await getSplit.handler({ weekday: 3 }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.splits[0].day_name).toBe('Wednesday');
    // Verify .eq was called for weekday filter
    expect(splitsChain.eq).toHaveBeenCalledWith('weekday', 3);
  });
});

describe('COACHBYTE_update_split', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('upserts split and returns success', async () => {
    mock.cbChain.data = {
      split_id: 's1',
      weekday: 1,
      template_sets: [{ exercise_id: 'ex-1', target_reps: 8, target_load: 135, rest_seconds: 90 }],
    };
    mock.cbChain.error = null;

    const result = await updateSplit.handler(
      {
        weekday: 1,
        template_sets: [{ exercise_id: 'ex-1', target_reps: 8, target_load: 135, rest_seconds: 90 }],
      },
      ctx(mock.supabase),
    );

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.day_name).toBe('Monday');
    expect(parsed.message).toContain('Monday');
  });

  it('rejects invalid weekday', async () => {
    const result = await updateSplit.handler(
      { weekday: 7, template_sets: [] },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('weekday must be between');
  });

  it('returns error on upsert failure', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'upsert failed' };

    const result = await updateSplit.handler(
      { weekday: 0, template_sets: [] },
      ctx(mock.supabase),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('upsert failed');
  });
});

describe('COACHBYTE_set_timer', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('starts a timer and returns success', async () => {
    mock.cbChain.data = {
      timer_id: 't1',
      state: 'running',
      duration_seconds: 90,
      end_time: '2026-03-03T12:01:30Z',
    };
    mock.cbChain.error = null;

    const result = await setTimer.handler({ duration_seconds: 90 }, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.state).toBe('running');
    expect(parsed.duration_seconds).toBe(90);
    expect(parsed.message).toContain('90 seconds');
  });

  it('rejects non-positive duration', async () => {
    const result = await setTimer.handler({ duration_seconds: 0 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('must be positive');
  });

  it('returns error on upsert failure', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'upsert boom' };

    const result = await setTimer.handler({ duration_seconds: 60 }, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('upsert boom');
  });
});

describe('COACHBYTE_get_timer', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('returns idle state when no timer exists', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = null;

    const result = await getTimer.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.state).toBe('idle');
    expect(parsed.remaining_seconds).toBe(0);
  });

  it('returns running timer with remaining seconds', async () => {
    const futureEnd = new Date(Date.now() + 45_000).toISOString();
    mock.cbChain.data = {
      timer_id: 't1',
      state: 'running',
      duration_seconds: 90,
      end_time: futureEnd,
    };
    mock.cbChain.error = null;

    const result = await getTimer.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.state).toBe('running');
    expect(parsed.remaining_seconds).toBeGreaterThan(0);
    expect(parsed.remaining_seconds).toBeLessThanOrEqual(45);
  });

  it('reports expired timer as done', async () => {
    const pastEnd = new Date(Date.now() - 5000).toISOString();
    mock.cbChain.data = {
      timer_id: 't1',
      state: 'running',
      duration_seconds: 90,
      end_time: pastEnd,
    };
    mock.cbChain.error = null;

    const result = await getTimer.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.state).toBe('done');
    expect(parsed.remaining_seconds).toBe(0);
  });
});

describe('COACHBYTE_get_prs', () => {
  let mock: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    mock = createMockSupabase();
  });

  it('calculates Epley 1RM and returns PR table', async () => {
    mock.cbChain.data = [
      { completed_set_id: 'cs-1', exercise_id: 'ex-1', actual_reps: 8, actual_load: 200, completed_at: '2026-03-01T10:00:00Z', exercises: { name: 'Squat' } },
      { completed_set_id: 'cs-2', exercise_id: 'ex-1', actual_reps: 5, actual_load: 225, completed_at: '2026-03-02T10:00:00Z', exercises: { name: 'Squat' } },
    ];
    mock.cbChain.error = null;

    const result = await getPrs.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.prs).toHaveLength(1);
    expect(parsed.prs[0].exercise_name).toBe('Squat');
    // Epley: 200*(1+8/30) = 253.3, 225*(1+5/30) = 262.5 -> best is 262.5
    expect(parsed.prs[0].estimated_1rm).toBe(262.5);
    expect(parsed.prs[0].rm_table['1RM']).toBe(262.5);
    // 5RM = 262.5 / (1 + 5/30) = 225
    expect(parsed.prs[0].rm_table['5RM']).toBe(225);
  });

  it('returns empty when no completed sets', async () => {
    mock.cbChain.data = [];
    mock.cbChain.error = null;

    const result = await getPrs.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.prs).toEqual([]);
    expect(parsed.message).toContain('No completed sets');
  });

  it('returns error on query failure', async () => {
    mock.cbChain.data = null;
    mock.cbChain.error = { message: 'query error' };

    const result = await getPrs.handler({}, ctx(mock.supabase));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('query error');
  });

  it('skips sets with zero load or reps', async () => {
    mock.cbChain.data = [
      { completed_set_id: 'cs-1', exercise_id: 'ex-1', actual_reps: 0, actual_load: 200, completed_at: '2026-03-01T10:00:00Z', exercises: { name: 'Squat' } },
      { completed_set_id: 'cs-2', exercise_id: 'ex-1', actual_reps: 8, actual_load: 0, completed_at: '2026-03-02T10:00:00Z', exercises: { name: 'Squat' } },
    ];
    mock.cbChain.error = null;

    const result = await getPrs.handler({}, ctx(mock.supabase));

    expect(result.isError).toBeUndefined();
    const parsed = parseResult(result);
    expect(parsed.prs).toEqual([]);
  });
});
