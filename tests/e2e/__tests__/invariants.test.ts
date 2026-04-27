/**
 * Invariant predicate unit tests (Vitest).
 *
 * Each of the 10 invariants gets:
 *   - synthetic violation: planted bad data + assertions on the recorded
 *     filter calls (so a predicate that mutates its filter values is
 *     still caught — the mock builder records every .eq/.lt/.gte/.is/
 *     .not/.in call into a captured array)
 *   - clean: well-formed data, predicate returns null
 *
 * Why filter-call recording: an earlier version of this suite used a
 * fully permissive mock that ignored filter args entirely. That made
 * mutating e.g. `.lt('qty_containers', 0)` to `.lt('qty_containers', -100)`
 * a no-op test pass — the predicate's SQL filter logic was unverified
 * and the tests were tautological for the predicates whose filter logic
 * lives in the SQL clause (qty_non_negative, mcp_tool_log_user_id_present,
 * coachbyte_timer_consistent, livetrack_session_no_zombie_active). The
 * recorded-filter-call assertion fixes that — see Audit B 2026-04-27.
 *
 * Uses an in-memory mock supabase client so the suite runs as part of
 * `pnpm verify:fast` without needing a live Supabase. The mock honors
 * the chained PostgREST builder shape every predicate uses
 * (`.schema().from().select().eq().lt().is().not().gte().in()`).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PREDICATES,
  INVARIANT_NAMES,
  assertSystemInvariants,
  InvariantViolationError,
  type AssertSystemInvariantsOpts,
  type PiSimulatorState,
} from '../invariants';

// ─── Mock supabase shape ────────────────────────────────────────────

/**
 * One recorded filter call — column name, operator, and the value(s)
 * the predicate passed. Tests pull these out of the capture and assert
 * the SQL filter is shaped correctly.
 */
interface RecordedFilter {
  table: string;          // `${schema}.${table}`
  op: 'eq' | 'lt' | 'gte' | 'is' | 'not' | 'in';
  column: string;
  value: unknown;
  // For .not(col, op, val) the second op string lives here.
  notOp?: string;
}

/**
 * Build a chainable PostgREST-builder mock that returns `data` and
 * optionally `error`. Each chain method records its (op, column, value)
 * into the supplied `filters` array AND returns the same builder so the
 * fluent chain works. Awaiting the builder (PostgREST is thenable)
 * yields `{ data, error }`.
 */
function buildBuilder(
  table: string,
  data: any[],
  filters: RecordedFilter[],
  error: any = null,
): any {
  const record = (op: RecordedFilter['op'], column: string, value: unknown, notOp?: string) => {
    filters.push({ table, op, column, value, notOp });
  };
  const builder: any = {
    data,
    error,
    select: () => builder,
    eq: (column: string, value: unknown) => {
      record('eq', column, value);
      return builder;
    },
    lt: (column: string, value: unknown) => {
      record('lt', column, value);
      return builder;
    },
    gte: (column: string, value: unknown) => {
      record('gte', column, value);
      return builder;
    },
    is: (column: string, value: unknown) => {
      record('is', column, value);
      return builder;
    },
    not: (column: string, op: string, value: unknown) => {
      record('not', column, value, op);
      return builder;
    },
    in: (column: string, value: unknown) => {
      record('in', column, value);
      return builder;
    },
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error }),
    single: () => Promise.resolve({ data: data[0] ?? null, error }),
    then: (onFulfilled: any) => Promise.resolve({ data, error }).then(onFulfilled),
  };
  return builder;
}

/**
 * Build a multi-table mock supabase client.
 *
 * `tables` keys are `${schema}.${table}` strings; values are the rows
 * (or, for predicates that query the same table twice, an array of
 * payloads returned in order).
 *
 * Returns `{ supabase, filters }` — the recorded filter calls are
 * appended to `filters` in the order the predicate makes them, scoped
 * by `${schema}.${table}` so tests can assert per-table filter shape.
 */
function buildClient(tables: Record<string, any[] | Array<any[]>>): {
  supabase: any;
  filters: RecordedFilter[];
} {
  const callIdx: Record<string, number> = {};
  const filters: RecordedFilter[] = [];
  const supabase = {
    schema: (s: string) => ({
      from: (t: string) => {
        const key = `${s}.${t}`;
        const v = tables[key];
        if (!v) {
          // Default: empty result. Predicates that query a table not
          // present in the test setup will see no violations.
          return buildBuilder(key, [], filters);
        }
        if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) {
          // Sequence-of-payloads form for multi-call predicates.
          const seq = v as Array<any[]>;
          const idx = (callIdx[key] = (callIdx[key] ?? 0) + 1) - 1;
          return buildBuilder(key, seq[Math.min(idx, seq.length - 1)], filters);
        }
        return buildBuilder(key, v as any[], filters);
      },
    }),
  };
  return { supabase, filters };
}

const SCENARIO_START = new Date('2026-04-27T12:00:00Z');
const TEST_USER = '00000000-0000-4000-8000-000000000001';

function baseOpts(supabase: any, extra: Partial<AssertSystemInvariantsOpts> = {}): AssertSystemInvariantsOpts {
  return {
    supabase,
    testUserId: TEST_USER,
    scenarioStartTime: SCENARIO_START,
    scenarioName: 'unit-test-scenario',
    ...extra,
  };
}

/** Helpers for filter-call assertions. */
function findFilter(
  filters: RecordedFilter[],
  predicate: (f: RecordedFilter) => boolean,
): RecordedFilter | undefined {
  return filters.find(predicate);
}

// ─── Predicate-by-predicate tests ───────────────────────────────────

describe('invariants predicate registry', () => {
  it('exports exactly the 11 documented invariants (post-2026-04-27 reconcile)', () => {
    expect(INVARIANT_NAMES).toEqual([
      'qty_non_negative',
      'food_logs_4_4_9_within_tolerance',
      'stock_lots_in_flight_consistent',
      'pi_cloud_lot_id_match',
      'mcp_tool_log_user_id_present',
      'shelf_event_log_no_orphan_lots',
      'livetrack_session_no_zombie_active',
      'coachbyte_timer_running_has_end_time',
      'coachbyte_timer_running_not_stale',
      'product_macro_drift_4_4_9',
      'cloud_outbox_no_permanent_failed',
    ]);
  });
});

describe('1. qty_non_negative', () => {
  const predicate = PREDICATES.qty_non_negative;

  it('returns null when no lots have negative qty', async () => {
    const { supabase, filters } = buildClient({ 'chefbyte.stock_lots': [] });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    // Even on the clean path, the filters must be shaped correctly —
    // otherwise a mutation that flipped lt→gte would silently widen.
    const lt = findFilter(filters, (f) => f.table === 'chefbyte.stock_lots' && f.op === 'lt');
    expect(lt).toMatchObject({ column: 'qty_containers', value: 0 });
    const eq = findFilter(filters, (f) => f.table === 'chefbyte.stock_lots' && f.op === 'eq');
    expect(eq).toMatchObject({ column: 'user_id', value: TEST_USER });
  });

  it('returns a violation when a lot has qty_containers < 0', async () => {
    const { supabase, filters } = buildClient({
      'chefbyte.stock_lots': [{ lot_id: 'lot-1', qty_containers: -1, product_id: 'p-1' }],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r).not.toBeNull();
    expect(r!.name).toBe('qty_non_negative');
    expect(r!.severity).toBe('critical');
    expect((r!.details as any).violating_lots).toEqual([
      { lot_id: 'lot-1', qty_containers: -1, product_id: 'p-1' },
    ]);
    // SQL filter shape: lt('qty_containers', 0). A mutation to
    // lt('qty_containers', -100) would change `value` and trip here.
    const lt = findFilter(filters, (f) => f.table === 'chefbyte.stock_lots' && f.op === 'lt');
    expect(lt).toBeDefined();
    expect(lt!.column).toBe('qty_containers');
    expect(lt!.value).toBe(0);
  });
});

describe('2. food_logs_4_4_9_within_tolerance', () => {
  const predicate = PREDICATES.food_logs_4_4_9_within_tolerance;

  it('returns null when all food_logs satisfy 4-4-9 within ±10 kcal', async () => {
    // 100 cal = 4*5 + 4*5 + 9*7 + tolerance? 4*5+4*5+9*7 = 20+20+63 = 103,
    // |100-103|=3 ≤ 10 → clean.
    const { supabase, filters } = buildClient({
      'chefbyte.food_logs': [{ log_id: 'l1', calories: 100, carbs: 5, protein: 5, fat: 7 }],
    });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    const eq = findFilter(filters, (f) => f.table === 'chefbyte.food_logs' && f.op === 'eq');
    expect(eq).toMatchObject({ column: 'user_id', value: TEST_USER });
    const gte = findFilter(filters, (f) => f.table === 'chefbyte.food_logs' && f.op === 'gte');
    expect(gte).toMatchObject({ column: 'created_at', value: SCENARIO_START.toISOString() });
  });

  it('returns a violation when calories drift > 10 kcal from inferred', async () => {
    // calories=500, carbs=10, protein=10, fat=10 → inferred = 40+40+90 = 170, drift=330
    const { supabase } = buildClient({
      'chefbyte.food_logs': [{ log_id: 'l1', calories: 500, carbs: 10, protein: 10, fat: 10 }],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('food_logs_4_4_9_within_tolerance');
    expect((r!.details as any).violations[0]).toMatchObject({
      log_id: 'l1',
      calories: 500,
      inferred: 170,
      drift_kcal: 330,
    });
  });
});

describe('3. stock_lots_in_flight_consistent', () => {
  const predicate = PREDICATES.stock_lots_in_flight_consistent;

  it('returns null when in-flight lots have a pickup_event_id', async () => {
    const { supabase, filters } = buildClient({
      'chefbyte.stock_lots': [
        {
          lot_id: 'lot-1',
          in_flight_since: new Date(Date.now() - 60_000).toISOString(),
          pickup_event_id: '11111111-1111-1111-1111-111111111111',
        },
      ],
    });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    const not = findFilter(filters, (f) => f.table === 'chefbyte.stock_lots' && f.op === 'not');
    expect(not).toMatchObject({ column: 'in_flight_since', notOp: 'is', value: null });
  });

  it('returns a violation when in-flight lot lacks a pickup_event_id', async () => {
    const { supabase } = buildClient({
      'chefbyte.stock_lots': [
        {
          lot_id: 'lot-1',
          in_flight_since: new Date(Date.now() - 60_000).toISOString(),
          pickup_event_id: null,
        },
      ],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('stock_lots_in_flight_consistent');
    expect((r!.details as any).orphans[0].reason).toBe('no_pickup_event_id');
  });
});

describe('4. pi_cloud_lot_id_match', () => {
  const predicate = PREDICATES.pi_cloud_lot_id_match;

  it('returns null when simulator absent', async () => {
    const { supabase } = buildClient({});
    expect(await predicate(baseOpts(supabase))).toBeNull();
  });

  it('returns a violation when Pi knows about a lot the cloud lacks', async () => {
    const sim: PiSimulatorState = {
      getKnownCloudLotIds: () => ['ghost-lot-1', 'present-lot-2'],
    };
    const { supabase, filters } = buildClient({
      'chefbyte.stock_lots': [{ lot_id: 'present-lot-2' }],
    });
    const r = await predicate(baseOpts(supabase, { piSimulator: sim }));
    expect(r!.name).toBe('pi_cloud_lot_id_match');
    expect((r!.details as any).pi_lot_ids_missing_in_cloud).toEqual(['ghost-lot-1']);
    // The IN() filter must carry the simulator's lot ids — a mutation
    // that swapped the column or dropped the filter would trip here.
    const inCall = findFilter(filters, (f) => f.table === 'chefbyte.stock_lots' && f.op === 'in');
    expect(inCall).toMatchObject({ column: 'lot_id' });
    expect(inCall!.value).toEqual(['ghost-lot-1', 'present-lot-2']);
  });
});

describe('5. mcp_tool_log_user_id_present', () => {
  const predicate = PREDICATES.mcp_tool_log_user_id_present;

  it('returns null when no rows have NULL user_id', async () => {
    const { supabase, filters } = buildClient({ 'hub.mcp_tool_logs': [] });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    // SQL: .is('user_id', null). Mutation to .is('user_id', '') would
    // change `value` and trip here.
    const isCall = findFilter(filters, (f) => f.table === 'hub.mcp_tool_logs' && f.op === 'is');
    expect(isCall).toMatchObject({ column: 'user_id', value: null });
    const gte = findFilter(filters, (f) => f.table === 'hub.mcp_tool_logs' && f.op === 'gte');
    expect(gte).toMatchObject({ column: 'created_at', value: SCENARIO_START.toISOString() });
  });

  it('returns a violation when an mcp_tool_logs row has NULL user_id', async () => {
    const { supabase, filters } = buildClient({
      'hub.mcp_tool_logs': [{ id: 42, tool_name: 'COACHBYTE_log_set', created_at: '2026-04-27T13:00:00Z' }],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('mcp_tool_log_user_id_present');
    expect(r!.severity).toBe('error');
    expect((r!.details as any).rows_with_null_user_id[0].id).toBe(42);
    const isCall = findFilter(filters, (f) => f.table === 'hub.mcp_tool_logs' && f.op === 'is');
    expect(isCall).toMatchObject({ column: 'user_id', value: null });
  });
});

describe('6. shelf_event_log_no_orphan_lots', () => {
  const predicate = PREDICATES.shelf_event_log_no_orphan_lots;

  it('returns null when every event resolved_lot_id matches a stock_lots row', async () => {
    const { supabase, filters } = buildClient({
      'chefbyte.shelf_event_log': [{ event_id: 'e1', resolved_lot_id: 'lot-1' }],
      'chefbyte.stock_lots': [{ lot_id: 'lot-1' }],
    });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    const not = findFilter(filters, (f) => f.table === 'chefbyte.shelf_event_log' && f.op === 'not');
    expect(not).toMatchObject({ column: 'resolved_lot_id', notOp: 'is', value: null });
  });

  it('returns a violation when an event references a missing lot_id', async () => {
    const { supabase } = buildClient({
      'chefbyte.shelf_event_log': [{ event_id: 'e1', resolved_lot_id: 'ghost-lot' }],
      'chefbyte.stock_lots': [], // ghost-lot doesn't exist
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('shelf_event_log_no_orphan_lots');
    expect((r!.details as any).orphan_events[0]).toEqual({
      event_id: 'e1',
      missing_lot_id: 'ghost-lot',
    });
  });
});

describe('7. livetrack_session_no_zombie_active', () => {
  const predicate = PREDICATES.livetrack_session_no_zombie_active;

  it('returns null when all old sessions are terminal', async () => {
    const { supabase, filters } = buildClient({
      'chefbyte.livetrack_import_sessions': [
        { session_id: 's1', state: 'closed', created_at: '2026-04-26T10:00:00Z' },
        { session_id: 's2', state: 'expired', created_at: '2026-04-26T10:00:00Z' },
      ],
    });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    // The cutoff filter is "created_at < now-5min". We can't pin the
    // exact timestamp but we can assert it's a recent ISO string and
    // older than now (i.e. the predicate is computing a cutoff and not
    // passing a fixed sentinel like 0).
    const lt = findFilter(filters, (f) => f.table === 'chefbyte.livetrack_import_sessions' && f.op === 'lt');
    expect(lt).toBeDefined();
    expect(lt!.column).toBe('created_at');
    const cutoff = new Date(lt!.value as string).getTime();
    expect(cutoff).toBeGreaterThan(Date.now() - 10 * 60 * 1000);
    expect(cutoff).toBeLessThan(Date.now());
  });

  it('returns a violation when an active session is older than 5 min', async () => {
    const { supabase } = buildClient({
      'chefbyte.livetrack_import_sessions': [
        { session_id: 's-zombie', state: 'waiting_scale', created_at: '2026-04-26T10:00:00Z' },
      ],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('livetrack_session_no_zombie_active');
    expect((r!.details as any).zombie_sessions[0].session_id).toBe('s-zombie');
  });
});

describe('8. coachbyte_timer_running_has_end_time', () => {
  const predicate = PREDICATES.coachbyte_timer_running_has_end_time;

  it('returns null when no running timers have null end_time', async () => {
    const { supabase, filters } = buildClient({ 'coachbyte.timers': [] });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    // SQL shape: eq('state', 'running') + is('end_time', null).
    const stateEq = findFilter(
      filters,
      (f) => f.table === 'coachbyte.timers' && f.op === 'eq' && f.column === 'state',
    );
    expect(stateEq).toMatchObject({ value: 'running' });
    const isEnd = findFilter(filters, (f) => f.table === 'coachbyte.timers' && f.op === 'is' && f.column === 'end_time');
    expect(isEnd).toMatchObject({ value: null });
  });

  it('returns a violation when a running timer has end_time IS NULL', async () => {
    const { supabase } = buildClient({
      'coachbyte.timers': [{ timer_id: 't1', state: 'running', end_time: null }],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('coachbyte_timer_running_has_end_time');
    expect((r!.details as any).running_timers_without_end_time[0].timer_id).toBe('t1');
  });
});

describe('9. coachbyte_timer_running_not_stale', () => {
  const predicate = PREDICATES.coachbyte_timer_running_not_stale;

  it('returns null when no running timers are stale (>4h old)', async () => {
    const { supabase, filters } = buildClient({ 'coachbyte.timers': [] });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    // SQL: eq(state,running) + not(end_time, is, null) + lt(end_time, now-4h)
    const stateEq = findFilter(
      filters,
      (f) => f.table === 'coachbyte.timers' && f.op === 'eq' && f.column === 'state',
    );
    expect(stateEq).toMatchObject({ value: 'running' });
    const notEnd = findFilter(
      filters,
      (f) => f.table === 'coachbyte.timers' && f.op === 'not' && f.column === 'end_time',
    );
    expect(notEnd).toMatchObject({ notOp: 'is', value: null });
    const lt = findFilter(filters, (f) => f.table === 'coachbyte.timers' && f.op === 'lt' && f.column === 'end_time');
    expect(lt).toBeDefined();
    const cutoff = new Date(lt!.value as string).getTime();
    // Must be approximately now - 4h (within ±10 min slack).
    const expected = Date.now() - 4 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThan(expected - 10 * 60 * 1000);
    expect(cutoff).toBeLessThan(expected + 10 * 60 * 1000);
  });

  it('returns a violation when a running timer has end_time > 4h in the past', async () => {
    const stale = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const { supabase } = buildClient({
      'coachbyte.timers': [{ timer_id: 't1', state: 'running', end_time: stale }],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('coachbyte_timer_running_not_stale');
    expect((r!.details as any).stale_running_timers[0].timer_id).toBe('t1');
  });
});

describe('10. product_macro_drift_4_4_9', () => {
  const predicate = PREDICATES.product_macro_drift_4_4_9;

  it('returns null for products within 5% drift', async () => {
    // 100 cal vs inferred 4*5+4*5+9*7=103 → drift_pct ≈ 0.029 → clean.
    const { supabase, filters } = buildClient({
      'chefbyte.products': [
        {
          product_id: 'p1',
          name: 'Test',
          calories_per_serving: 100,
          carbs_per_serving: 5,
          protein_per_serving: 5,
          fat_per_serving: 7,
        },
      ],
    });
    expect(await predicate(baseOpts(supabase))).toBeNull();
    const eq = findFilter(filters, (f) => f.table === 'chefbyte.products' && f.op === 'eq');
    expect(eq).toMatchObject({ column: 'user_id', value: TEST_USER });
    const gte = findFilter(filters, (f) => f.table === 'chefbyte.products' && f.op === 'gte');
    expect(gte).toMatchObject({ column: 'updated_at', value: SCENARIO_START.toISOString() });
  });

  it('returns a violation when product drift exceeds 5%', async () => {
    // 500 vs 4*10+4*10+9*10 = 170 → drift_pct = 330/500 = 0.66 >> 0.05
    const { supabase } = buildClient({
      'chefbyte.products': [
        {
          product_id: 'p1',
          name: 'Bad Product',
          calories_per_serving: 500,
          carbs_per_serving: 10,
          protein_per_serving: 10,
          fat_per_serving: 10,
        },
      ],
    });
    const r = await predicate(baseOpts(supabase));
    expect(r!.name).toBe('product_macro_drift_4_4_9');
    expect((r!.details as any).drifting_products[0]).toMatchObject({
      product_id: 'p1',
      calories_per_serving: 500,
      inferred: 170,
    });
  });
});

describe('11. cloud_outbox_no_permanent_failed', () => {
  const predicate = PREDICATES.cloud_outbox_no_permanent_failed;

  it('returns null when simulator reports zero permanent failures', async () => {
    const sim = {
      getOutboxPermanentFailedCount: () => 0,
    } as PiSimulatorState & { getOutboxPermanentFailedCount: () => number };
    const { supabase } = buildClient({});
    expect(await predicate(baseOpts(supabase, { piSimulator: sim }))).toBeNull();
  });

  it('returns a violation when simulator reports permanent failures > 0', async () => {
    const sim = {
      getOutboxPermanentFailedCount: () => 2,
    } as PiSimulatorState & { getOutboxPermanentFailedCount: () => number };
    const { supabase } = buildClient({});
    const r = await predicate(baseOpts(supabase, { piSimulator: sim }));
    expect(r!.name).toBe('cloud_outbox_no_permanent_failed');
    expect(r!.severity).toBe('critical');
    expect((r!.details as any).permanent_failed_count).toBe(2);
  });
});

// ─── Aggregate behavior ─────────────────────────────────────────────

describe('assertSystemInvariants aggregator', () => {
  it('throws InvariantViolationError naming every offender', async () => {
    const stale = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const { supabase } = buildClient({
      'chefbyte.stock_lots': [{ lot_id: 'lot-1', qty_containers: -1, product_id: 'p-1' }],
      // Plant TWO timer violations: one with null end_time (catches by
      // running_has_end_time predicate) and one stale (caught by
      // running_not_stale predicate). The mock returns the same row
      // set on both queries, so we build a shape that satisfies both.
      'coachbyte.timers': [
        { timer_id: 't1', state: 'running', end_time: null },
        { timer_id: 't2', state: 'running', end_time: stale },
      ],
    });
    await expect(assertSystemInvariants(baseOpts(supabase))).rejects.toThrow(InvariantViolationError);
    try {
      await assertSystemInvariants(baseOpts(supabase));
    } catch (e) {
      const err = e as InvariantViolationError;
      const names = err.violations.map((v) => v.name).sort();
      expect(names).toContain('qty_non_negative');
      // Both timer predicates fire because the mock doesn't filter the
      // row sets — that's fine, BOTH predicates are valid invariants.
      expect(names).toContain('coachbyte_timer_running_has_end_time');
      expect(names).toContain('coachbyte_timer_running_not_stale');
      expect(err.scenarioName).toBe('unit-test-scenario');
    }
  });

  it('returns silently when all invariants are clean', async () => {
    const { supabase } = buildClient({});
    await expect(assertSystemInvariants(baseOpts(supabase))).resolves.toBeUndefined();
  });

  it('does not silently swallow predicate query errors', async () => {
    // A query that errors (fake supabase error) should bubble up so a
    // broken invariant doesn't masquerade as clean.
    const sb: any = {
      schema: () => ({
        from: () => {
          const b: any = {
            data: null,
            error: { message: 'simulated postgrest failure' },
            select: () => b,
            eq: () => b,
            lt: () => b,
            gte: () => b,
            is: () => b,
            not: () => b,
            in: () => b,
            then: (cb: any) => Promise.resolve({ data: null, error: { message: 'simulated postgrest failure' } }).then(cb),
          };
          return b;
        },
      }),
    };
    await expect(assertSystemInvariants(baseOpts(sb))).rejects.toThrow(/simulated postgrest failure/);
  });

  // Smoke: confirm a Pi simulator without the optional methods doesn't
  // break the run. Mirrors the default state in this harness today.
  it('handles a Pi simulator with no methods (default TS simulator)', async () => {
    const { supabase } = buildClient({});
    const sim: PiSimulatorState = {};
    await expect(assertSystemInvariants(baseOpts(supabase, { piSimulator: sim }))).resolves.toBeUndefined();
  });
});

// Suppress noisy test output if a predicate console.errors during a
// negative-path test (we don't expect this today, but keep the guard
// so future expansions don't pollute the test stream).
vi.spyOn(console, 'error').mockImplementation(() => {});
