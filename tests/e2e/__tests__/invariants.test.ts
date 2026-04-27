/**
 * Invariant predicate unit tests (Vitest).
 *
 * Each of the 10 invariants gets two tests:
 *   - synthetic violation: planted bad data, predicate returns the
 *     correct violation shape
 *   - clean: well-formed data, predicate returns null
 *
 * Uses an in-memory mock supabase client so the suite runs as part of
 * `pnpm verify:fast` without needing a live Supabase. The mock honors
 * the chained PostgREST builder shape every predicate uses
 * (`.schema().from().select().eq().lt().is().not().gte().in()`).
 *
 * Coverage rationale: these tests verify the predicate logic is
 * correct in isolation. The end-to-end coverage of "the predicate
 * runs against real Supabase + catches a real violation" comes from
 * the manual sanity test described in `docs/test-system-fix-plan.md`
 * Phase 3 (plant `qty_containers = -1`, run scenario 01, confirm
 * scenario fails). That sanity test is documented but does not run
 * automatically — its purpose is to verify the wiring, not the logic.
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
 * Build a chainable PostgREST-builder mock that returns `data` and
 * optionally `error`. Each chain method (`.eq`, `.lt`, `.is`, etc.)
 * returns the same builder; awaiting it (PostgREST is thenable)
 * yields `{ data, error }`.
 *
 * The predicates only ever call:
 *   schema(s).from(t).select(cols).eq(c, v).lt(c, v).gte(c, v)
 *     .is(c, null|val).not(c, op, v).in(c, vals)
 * and then await. So the mock just needs to be a chainable thenable
 * that resolves with the configured payload.
 */
function buildBuilder(data: any[], error: any = null): any {
  const builder: any = {
    data,
    error,
    select: () => builder,
    eq: () => builder,
    lt: () => builder,
    gte: () => builder,
    is: () => builder,
    not: () => builder,
    in: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: data[0] ?? null, error }),
    single: () => Promise.resolve({ data: data[0] ?? null, error }),
    then: (onFulfilled: any) => Promise.resolve({ data, error }).then(onFulfilled),
  };
  return builder;
}

/**
 * Build a multi-table mock supabase client. `tables` keys are
 * `${schema}.${table}` strings; values are the rows. If a table has
 * a function for "second-call" style (used by predicates that query
 * the same table twice with different filters — e.g. shelf_event_log
 * predicate looks up events then looks up matching lots), provide an
 * array of payloads and the builder returns them in order.
 */
function buildClient(tables: Record<string, any[] | Array<any[]>>): any {
  const callIdx: Record<string, number> = {};
  return {
    schema: (s: string) => ({
      from: (t: string) => {
        const key = `${s}.${t}`;
        const v = tables[key];
        if (!v) {
          // Default: empty result. Predicates that query a table
          // not present in the test setup will see no violations.
          return buildBuilder([]);
        }
        if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) {
          // Sequence-of-payloads form for multi-call predicates.
          const seq = v as Array<any[]>;
          const idx = (callIdx[key] = (callIdx[key] ?? 0) + 1) - 1;
          return buildBuilder(seq[Math.min(idx, seq.length - 1)]);
        }
        return buildBuilder(v as any[]);
      },
    }),
  };
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

// ─── Predicate-by-predicate tests ───────────────────────────────────

describe('invariants predicate registry', () => {
  it('exports exactly the 10 documented invariants', () => {
    expect(INVARIANT_NAMES).toEqual([
      'qty_non_negative',
      'food_logs_4_4_9_within_tolerance',
      'stock_lots_in_flight_consistent',
      'pi_cloud_lot_id_match',
      'mcp_tool_log_user_id_present',
      'shelf_event_log_no_orphan_lots',
      'livetrack_session_no_zombie_active',
      'coachbyte_timer_consistent',
      'product_macro_drift_4_4_9',
      'cloud_outbox_no_permanent_failed',
    ]);
  });
});

describe('1. qty_non_negative', () => {
  const predicate = PREDICATES.qty_non_negative;

  it('returns null when no lots have negative qty', async () => {
    const sb = buildClient({ 'chefbyte.stock_lots': [] });
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when a lot has qty_containers < 0', async () => {
    const sb = buildClient({
      'chefbyte.stock_lots': [{ lot_id: 'lot-1', qty_containers: -1, product_id: 'p-1' }],
    });
    const r = await predicate(baseOpts(sb));
    expect(r).not.toBeNull();
    expect(r!.name).toBe('qty_non_negative');
    expect(r!.severity).toBe('critical');
    expect((r!.details as any).violating_lots).toEqual([
      { lot_id: 'lot-1', qty_containers: -1, product_id: 'p-1' },
    ]);
  });
});

describe('2. food_logs_4_4_9_within_tolerance', () => {
  const predicate = PREDICATES.food_logs_4_4_9_within_tolerance;

  it('returns null when all food_logs satisfy 4-4-9 within ±10 kcal', async () => {
    // 100 cal = 4*5 + 4*5 + 9*7 + tolerance? 4*5+4*5+9*7 = 20+20+63 = 103,
    // |100-103|=3 ≤ 10 → clean.
    const sb = buildClient({
      'chefbyte.food_logs': [{ log_id: 'l1', calories: 100, carbs: 5, protein: 5, fat: 7 }],
    });
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when calories drift > 10 kcal from inferred', async () => {
    // calories=500, carbs=10, protein=10, fat=10 → inferred = 40+40+90 = 170, drift=330
    const sb = buildClient({
      'chefbyte.food_logs': [{ log_id: 'l1', calories: 500, carbs: 10, protein: 10, fat: 10 }],
    });
    const r = await predicate(baseOpts(sb));
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
    const sb = buildClient({
      'chefbyte.stock_lots': [
        {
          lot_id: 'lot-1',
          in_flight_since: new Date(Date.now() - 60_000).toISOString(),
          pickup_event_id: '11111111-1111-1111-1111-111111111111',
        },
      ],
    });
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when in-flight lot lacks a pickup_event_id', async () => {
    const sb = buildClient({
      'chefbyte.stock_lots': [
        {
          lot_id: 'lot-1',
          in_flight_since: new Date(Date.now() - 60_000).toISOString(),
          pickup_event_id: null,
        },
      ],
    });
    const r = await predicate(baseOpts(sb));
    expect(r!.name).toBe('stock_lots_in_flight_consistent');
    expect((r!.details as any).orphans[0].reason).toBe('no_pickup_event_id');
  });
});

describe('4. pi_cloud_lot_id_match', () => {
  const predicate = PREDICATES.pi_cloud_lot_id_match;

  it('returns null when simulator absent', async () => {
    const sb = buildClient({});
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when Pi knows about a lot the cloud lacks', async () => {
    const sim: PiSimulatorState = {
      getKnownCloudLotIds: () => ['ghost-lot-1', 'present-lot-2'],
    };
    const sb = buildClient({
      'chefbyte.stock_lots': [{ lot_id: 'present-lot-2' }],
    });
    const r = await predicate(baseOpts(sb, { piSimulator: sim }));
    expect(r!.name).toBe('pi_cloud_lot_id_match');
    expect((r!.details as any).pi_lot_ids_missing_in_cloud).toEqual(['ghost-lot-1']);
  });
});

describe('5. mcp_tool_log_user_id_present', () => {
  const predicate = PREDICATES.mcp_tool_log_user_id_present;

  it('returns null when no rows have NULL user_id', async () => {
    const sb = buildClient({ 'hub.mcp_tool_logs': [] });
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when an mcp_tool_logs row has NULL user_id', async () => {
    const sb = buildClient({
      'hub.mcp_tool_logs': [{ id: 42, tool_name: 'COACHBYTE_log_set', created_at: '2026-04-27T13:00:00Z' }],
    });
    const r = await predicate(baseOpts(sb));
    expect(r!.name).toBe('mcp_tool_log_user_id_present');
    expect(r!.severity).toBe('error');
    expect((r!.details as any).rows_with_null_user_id[0].id).toBe(42);
  });
});

describe('6. shelf_event_log_no_orphan_lots', () => {
  const predicate = PREDICATES.shelf_event_log_no_orphan_lots;

  it('returns null when every event resolved_lot_id matches a stock_lots row', async () => {
    const sb = buildClient({
      'chefbyte.shelf_event_log': [{ event_id: 'e1', resolved_lot_id: 'lot-1' }],
      'chefbyte.stock_lots': [{ lot_id: 'lot-1' }],
    });
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when an event references a missing lot_id', async () => {
    const sb = buildClient({
      'chefbyte.shelf_event_log': [{ event_id: 'e1', resolved_lot_id: 'ghost-lot' }],
      'chefbyte.stock_lots': [], // ghost-lot doesn't exist
    });
    const r = await predicate(baseOpts(sb));
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
    const sb = buildClient({
      'chefbyte.livetrack_import_sessions': [
        { session_id: 's1', state: 'closed', created_at: '2026-04-26T10:00:00Z' },
        { session_id: 's2', state: 'expired', created_at: '2026-04-26T10:00:00Z' },
      ],
    });
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when an active session is older than 5 min', async () => {
    const sb = buildClient({
      'chefbyte.livetrack_import_sessions': [
        { session_id: 's-zombie', state: 'waiting_scale', created_at: '2026-04-26T10:00:00Z' },
      ],
    });
    const r = await predicate(baseOpts(sb));
    expect(r!.name).toBe('livetrack_session_no_zombie_active');
    expect((r!.details as any).zombie_sessions[0].session_id).toBe('s-zombie');
  });
});

describe('8. coachbyte_timer_consistent', () => {
  const predicate = PREDICATES.coachbyte_timer_consistent;

  it('returns null when no running timers have null end_time', async () => {
    const sb = buildClient({ 'coachbyte.timers': [] });
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when a running timer has end_time IS NULL', async () => {
    const sb = buildClient({
      'coachbyte.timers': [{ timer_id: 't1', state: 'running', end_time: null }],
    });
    const r = await predicate(baseOpts(sb));
    expect(r!.name).toBe('coachbyte_timer_consistent');
    expect((r!.details as any).running_timers_without_end_time[0].timer_id).toBe('t1');
  });
});

describe('9. product_macro_drift_4_4_9', () => {
  const predicate = PREDICATES.product_macro_drift_4_4_9;

  it('returns null for products within 5% drift', async () => {
    // 100 cal vs inferred 4*5+4*5+9*7=103 → drift_pct ≈ 0.029 → clean.
    const sb = buildClient({
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
    expect(await predicate(baseOpts(sb))).toBeNull();
  });

  it('returns a violation when product drift exceeds 5%', async () => {
    // 500 vs 4*10+4*10+9*10 = 170 → drift_pct = 330/500 = 0.66 >> 0.05
    const sb = buildClient({
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
    const r = await predicate(baseOpts(sb));
    expect(r!.name).toBe('product_macro_drift_4_4_9');
    expect((r!.details as any).drifting_products[0]).toMatchObject({
      product_id: 'p1',
      calories_per_serving: 500,
      inferred: 170,
    });
  });
});

describe('10. cloud_outbox_no_permanent_failed', () => {
  const predicate = PREDICATES.cloud_outbox_no_permanent_failed;

  it('returns null when simulator reports zero permanent failures', async () => {
    const sim = {
      getOutboxPermanentFailedCount: () => 0,
    } as PiSimulatorState & { getOutboxPermanentFailedCount: () => number };
    const sb = buildClient({});
    expect(await predicate(baseOpts(sb, { piSimulator: sim }))).toBeNull();
  });

  it('returns a violation when simulator reports permanent failures > 0', async () => {
    const sim = {
      getOutboxPermanentFailedCount: () => 2,
    } as PiSimulatorState & { getOutboxPermanentFailedCount: () => number };
    const sb = buildClient({});
    const r = await predicate(baseOpts(sb, { piSimulator: sim }));
    expect(r!.name).toBe('cloud_outbox_no_permanent_failed');
    expect(r!.severity).toBe('critical');
    expect((r!.details as any).permanent_failed_count).toBe(2);
  });
});

// ─── Aggregate behavior ─────────────────────────────────────────────

describe('assertSystemInvariants aggregator', () => {
  it('throws InvariantViolationError naming every offender', async () => {
    const sb = buildClient({
      'chefbyte.stock_lots': [{ lot_id: 'lot-1', qty_containers: -1, product_id: 'p-1' }],
      'coachbyte.timers': [{ timer_id: 't1', state: 'running', end_time: null }],
    });
    await expect(assertSystemInvariants(baseOpts(sb))).rejects.toThrow(InvariantViolationError);
    try {
      await assertSystemInvariants(baseOpts(sb));
    } catch (e) {
      const err = e as InvariantViolationError;
      const names = err.violations.map((v) => v.name).sort();
      expect(names).toContain('qty_non_negative');
      expect(names).toContain('coachbyte_timer_consistent');
      expect(err.scenarioName).toBe('unit-test-scenario');
    }
  });

  it('returns silently when all invariants are clean', async () => {
    const sb = buildClient({});
    await expect(assertSystemInvariants(baseOpts(sb))).resolves.toBeUndefined();
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
    const sb = buildClient({});
    const sim: PiSimulatorState = {};
    await expect(assertSystemInvariants(baseOpts(sb, { piSimulator: sim }))).resolves.toBeUndefined();
  });
});

// Suppress noisy test output if a predicate console.errors during a
// negative-path test (we don't expect this today, but keep the guard
// so future expansions don't pollute the test stream).
vi.spyOn(console, 'error').mockImplementation(() => {});
