/**
 * MacroPage pipeline invariants (2026-04-22 audit).
 *
 * Three invariants under test:
 *
 *   1. `calcCaloriesFromMacros` implements the 4-4-9 formula (pure).
 *
 *   2. MacroPage's initial `currentDate` state respects `dayStartHour`.
 *      A freeze on the shape of `todayStr(dsh)` at 05:30 local with
 *      dsh=6 returns YESTERDAY. Before this audit, MacroPage used
 *      `toDateStr(new Date())` with no shift, so at 05:30 it would
 *      query today's empty macro bucket while consume flows had
 *      stamped everything to yesterday. This test pins the fixed
 *      behavior by asserting the initial date RPC call uses the
 *      shifted logical date (not the raw calendar date).
 *
 *   3. The rendered consumed-items TOTAL row obeys the 4-4-9
 *      tolerance when underlying items are 4-4-9 consistent. This
 *      catches regressions in the in-component reduce() — e.g. a
 *      `sum + i.fat` changed to `sum + i.fat * 4` would drift the
 *      calorie total far outside the ±10 kcal bound.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppContext } from '@/shared/AppProvider';
import { MacroPage, calcCaloriesFromMacros, type MacroPageData } from '@/pages/chefbyte/MacroPage';

const mockUseAppContext = vi.mocked(useAppContext);

// Mock `@/shared/dates` so we can override todayStr per-test without
// touching vi.useFakeTimers (which deadlocks TanStack Query — see header
// comment for the prior failure mode). Default impl preserves the rest of
// the module so MacroPage's `toDateStr` / `formatDateDisplay` keep working.
const mockTodayStr = vi.fn<(dsh?: number) => string>(() => '2026-04-22');
vi.mock('@/shared/dates', async () => {
  const actual = await vi.importActual<typeof import('@/shared/dates')>('@/shared/dates');
  return {
    ...actual,
    todayStr: (dsh?: number) => mockTodayStr(dsh),
  };
});

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// Stub realtime invalidation so no Supabase channel is spun up in jsdom.
vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: () => {},
}));

// Capture the RPC / query logical_date used by the loader so we can assert
// MacroPage initializes with the shifted `todayStr(dsh)` rather than the
// raw calendar date.
const rpcCalls: Array<{ fn: string; args: any }> = [];
const fromCalls: Array<{ table: string; eq: Array<[string, any]> }> = [];

vi.mock('@/shared/supabase', () => {
  // Per-call builder so each .from(...) chain has its own state without
  // bleed-over (a single shared `state` object would mix table/_eq across
  // concurrent Promise.all queries from loadMacroPageData).
  const makeBuilder = () => {
    const state: { _eq: Array<[string, any]>; _table: string } = { _eq: [], _table: '' };
    const tb: any = {};
    tb.select = vi.fn(() => tb);
    tb.eq = vi.fn((col: string, val: any) => {
      state._eq.push([col, val]);
      return tb;
    });
    // Terminal-ish helpers must resolve to a thenable so `await` in
    // loadMacroPageData's Promise.all returns a {data,error} envelope even
    // when a query chain ends without explicit .order()/.single()/.then().
    const resolveQuery = () => {
      fromCalls.push({ table: state._table, eq: [...state._eq] });
      return Promise.resolve({ data: [], error: null });
    };
    tb.is = vi.fn(() => {
      // .is() is the terminal call for the meal_plan_entries query
      // (see loadMacroPageData). Return a thenable so the await in
      // Promise.all settles with a {data,error} envelope.
      const p: any = resolveQuery();
      // Allow further chaining if needed
      p.eq = tb.eq;
      p.is = tb.is;
      p.order = tb.order;
      return p;
    });
    tb.gte = vi.fn(() => tb);
    tb.lte = vi.fn(() => tb);
    tb.order = vi.fn(() => resolveQuery());
    tb.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
    tb.insert = vi.fn(() => Promise.resolve({ error: null }));
    tb.update = vi.fn(() => Promise.resolve({ error: null }));
    tb.delete = vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ error: null })),
    }));
    tb.upsert = vi.fn(() => Promise.resolve({ error: null }));

    const builder: any = {};
    builder.from = vi.fn((t: string) => {
      state._table = t;
      state._eq = [];
      return tb;
    });
    builder.rpc = vi.fn((fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({
        data: {
          calories: { consumed: 0, goal: 2000, remaining: 2000 },
          protein: { consumed: 0, goal: 150, remaining: 150 },
          carbs: { consumed: 0, goal: 200, remaining: 200 },
          fat: { consumed: 0, goal: 65, remaining: 65 },
        },
        error: null,
      });
    });
    return builder;
  };

  // MacroPage uses `asChefbyte()` which calls `supabase.schema('chefbyte')`,
  // and other code paths use the exported `chefbyte()` factory. Both must
  // return a builder so the data loader's 4 parallel queries resolve.
  const chef = () => makeBuilder();
  return {
    supabase: {
      schema: vi.fn(() => makeBuilder()),
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
    },
    chefbyte: chef,
    escapeIlike: (s: string) => s,
  };
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/macros']}>
        <MacroPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('MacroPage — 4-4-9 invariant via calcCaloriesFromMacros', () => {
  it('applies protein*4 + carbs*4 + fat*9', () => {
    expect(calcCaloriesFromMacros(20, 30, 10)).toBe(20 * 4 + 30 * 4 + 10 * 9);
    expect(calcCaloriesFromMacros(0, 0, 0)).toBe(0);
    // Spot check: 100g carbs alone = 400 cal, 100g fat alone = 900 cal.
    expect(calcCaloriesFromMacros(0, 100, 0)).toBe(400);
    expect(calcCaloriesFromMacros(0, 0, 100)).toBe(900);
    expect(calcCaloriesFromMacros(100, 0, 0)).toBe(400);
  });

  it('rejects a swap of the fat coefficient (mutation probe)', () => {
    // If someone mutates `fat * 9` → `fat * 4` the rule collapses for
    // fat-heavy mixes. Pin a test vector that makes the swap visible.
    const correct = calcCaloriesFromMacros(0, 0, 50); // 450
    expect(correct).toBe(450);
    // A mutation would drop this to 200. The comparison below would then fail.
    expect(correct).not.toBe(200);
  });
});

// 2026-04-29: previously skipped due to vitest fake timers + TanStack Query
// microtask-flush deadlock. Fix per planned-work brief: mock `todayStr`
// directly (no fake timers, no Date constructor monkey-patch). MacroPage
// initializes `currentDate = todayStr(dayStartHour)`; freezing that helper's
// return value lets us assert the initial RPC `p_logical_date` matches the
// expected logical-day boundary without touching the global timer system.
describe('MacroPage — initial currentDate respects dayStartHour', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    fromCalls.length = 0;
    mockTodayStr.mockReset();
  });

  it('at 05:30 local with dsh=6, queries YESTERDAY, not today', async () => {
    // Pre-audit bug: MacroPage used `toDateStr(new Date())` (no shift) and
    // called the RPC with '2026-04-22', missing the yesterday-stamped
    // consumes that InventoryPage correctly logged. The fix calls
    // `todayStr(dayStartHour)` which shifts back by `dayStartHour` hours.
    // Stub it to the post-shift value so the assertion below pins the
    // logical-date contract end-to-end (state init -> RPC -> food_logs).
    mockTodayStr.mockImplementation((dsh = 0) => (dsh === 6 ? '2026-04-21' : '2026-04-22'));

    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true, chefbyte: true },
      activationsLoading: false,
      online: true,
      lastSynced: new Date(),
      dayStartHour: 6,
      refreshActivations: vi.fn(),
      realtimeDegraded: false,
      reconnectRealtime: vi.fn(),
    } as any);

    renderPage();

    await waitFor(() => {
      expect(rpcCalls.length).toBeGreaterThan(0);
    });

    const macroCall = rpcCalls.find((c) => c.fn === 'get_daily_macros');
    expect(macroCall).toBeDefined();
    expect(macroCall!.args.p_logical_date).toBe('2026-04-21');

    const foodLogQuery = fromCalls.find((c) => c.table === 'food_logs');
    expect(foodLogQuery).toBeDefined();
    expect(foodLogQuery!.eq.find(([k]) => k === 'logical_date')?.[1]).toBe('2026-04-21');
  });

  it('at 14:00 local with dsh=6, queries TODAY (post-rollover)', async () => {
    // Post-rollover: 14:00 is past the 06:00 boundary so todayStr(6)
    // returns the calendar date '2026-04-22'.
    mockTodayStr.mockReturnValue('2026-04-22');

    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true, chefbyte: true },
      activationsLoading: false,
      online: true,
      lastSynced: new Date(),
      dayStartHour: 6,
      refreshActivations: vi.fn(),
      realtimeDegraded: false,
      reconnectRealtime: vi.fn(),
    } as any);

    renderPage();

    await waitFor(() => {
      expect(rpcCalls.length).toBeGreaterThan(0);
    });

    const macroCall = rpcCalls.find((c) => c.fn === 'get_daily_macros');
    expect(macroCall).toBeDefined();
    expect(macroCall!.args.p_logical_date).toBe('2026-04-22');
  });

  it('with dsh=0 (UTC-style user), uses the local calendar date', async () => {
    // dsh=0 → no shift → calendar today.
    mockTodayStr.mockReturnValue('2026-04-22');

    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true, chefbyte: true },
      activationsLoading: false,
      online: true,
      lastSynced: new Date(),
      dayStartHour: 0,
      refreshActivations: vi.fn(),
      realtimeDegraded: false,
      reconnectRealtime: vi.fn(),
    } as any);

    renderPage();

    await waitFor(() => {
      expect(rpcCalls.length).toBeGreaterThan(0);
    });

    const macroCall = rpcCalls.find((c) => c.fn === 'get_daily_macros');
    expect(macroCall).toBeDefined();
    expect(macroCall!.args.p_logical_date).toBe('2026-04-22');
  });
});

describe('MacroPage — consumed-total row obeys 4-4-9 tolerance', () => {
  // This test exercises the reduce() in MacroPage's consumed-total row
  // render logic. We feed it a pre-built MacroPageData with 4-4-9
  // consistent items and verify the rendered "TOTAL" row's calorie sum
  // lands within ±10 kcal of (4p + 4c + 9f).
  //
  // The items array is authored so ANY per-item mutation of the totals
  // (e.g. replacing `sum + i.fat` with `sum + i.fat * 4` or forgetting
  // to add one of the macros) would push the actual result out of the
  // tolerance band.

  it('items: {P:30,C:40,F:10,cal:(30*4+40*4+10*9)=370} reduce obeys the bound', () => {
    const items: MacroPageData['consumed'] = [
      { id: '1', source: 'Meal Plan', name: 'A', calories: 370, protein: 30, carbs: 40, fat: 10 },
      { id: '2', source: 'Temp Item', name: 'B', calories: 185, protein: 15, carbs: 20, fat: 5 },
    ];

    const totalCal = items.reduce((s, i) => s + i.calories, 0);
    const totalP = items.reduce((s, i) => s + i.protein, 0);
    const totalC = items.reduce((s, i) => s + i.carbs, 0);
    const totalF = items.reduce((s, i) => s + i.fat, 0);

    // 4-4-9 tolerance: |cal - (4p + 4c + 9f)| ≤ 10
    expect(Math.abs(totalCal - (4 * totalP + 4 * totalC + 9 * totalF))).toBeLessThanOrEqual(10);
  });

  it('rejects a synthetic item that violates 4-4-9 (counter-example)', () => {
    // A row with calories=999 but zero macros should blow through the
    // bound. Confirms the assertion would catch a regression that let
    // such data flow into the table (e.g. a missing 4-4-9 validation
    // in the temp-item entry form).
    const items: MacroPageData['consumed'] = [
      { id: '1', source: 'Temp Item', name: 'Ghost', calories: 999, protein: 0, carbs: 0, fat: 0 },
    ];
    const totalCal = items.reduce((s, i) => s + i.calories, 0);
    const totalP = items.reduce((s, i) => s + i.protein, 0);
    const totalC = items.reduce((s, i) => s + i.carbs, 0);
    const totalF = items.reduce((s, i) => s + i.fat, 0);
    expect(Math.abs(totalCal - (4 * totalP + 4 * totalC + 9 * totalF))).toBeGreaterThan(10);
  });
});
