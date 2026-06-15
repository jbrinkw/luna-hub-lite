/**
 * Spec-vs-implementation tests — CoachByte
 *
 * Each test pins one spec claim from docs/apps/coachbyte.md and drives a REAL
 * imported production symbol so the assertion can turn RED when that symbol
 * regresses. Claims with no web-side production hook (DB-enforced behaviour)
 * are intentionally NOT faked here — they are exercised by pgTAP, and a
 * tautological re-implementation in this suite would only give a false sense
 * of coverage. See the per-claim notes below.
 *
 * Spec claims covered:
 *   1. Epley 1RM: 1-rep sets use actual weight (not formula)  → epley1RM
 *   2. Epley 1RM: 0-rep (failed) sets → 0                      → epley1RM
 *   3. Epley 1RM: multi-rep sets use load × (1 + reps/30)      → epley1RM
 *   4. Keyset pagination: DESC by plan_date, cursor = last row → loadHistoryPage
 *   5. History per-day completed_count rollup (drives the     → loadHistoryPage
 *      "empty days filtered out" UI rule, spec line 73/101)
 *
 * DB-only behaviours (NOT pinned here — no falsifiable web symbol exists; the
 * audit proved a re-implemented copy stays green when the real DB function
 * breaks, so these would be fake "tests"):
 *   • Sequential set completion / lowest-order pick — `private.complete_next_set`
 *     (coachbyte.md:15). Covered by supabase/tests/coachbyte/complete_next_set.test.sql.
 *   • Exercise uniqueness `UNIQUE(user_id, LOWER(name))` (coachbyte.md:84) — DB
 *     constraint. Covered by pgTAP.
 *   • `resolvePercentLoad` rounding — lives in @luna-hub/app-tools (MCP plan
 *     materialization); the web app never calls it. Covered by app-tools tests.
 */

import { describe, it, expect } from 'vitest';
import { epley1RM } from '@/shared/epley';
import { loadHistoryPage } from '@/pages/coachbyte/HistoryPage';

// =========================================================================
// 1. Epley: 1-rep sets use ACTUAL WEIGHT (spec + impl agree)
//    spec: "1-rep sets use actual weight (not Epley)"
//    impl: reps === 1 → return load
// =========================================================================

describe('spec: Epley 1RM — 1-rep sets return actual load', () => {
  it('epley1RM(200, 1) = 200 (not 200*(1+1/30))', () => {
    expect(epley1RM(200, 1)).toBe(200);
  });

  it('epley1RM(315, 1) = 315', () => {
    expect(epley1RM(315, 1)).toBe(315);
  });
});

// =========================================================================
// 2. Epley: 0-rep (failed) sets are excluded — returns 0
// =========================================================================

describe('spec: Epley 1RM — 0-rep failed sets return 0', () => {
  it('epley1RM(200, 0) = 0', () => {
    expect(epley1RM(200, 0)).toBe(0);
  });

  it('epley1RM with any load, 0 reps = 0', () => {
    for (const load of [100, 225, 315]) {
      expect(epley1RM(load, 0)).toBe(0);
    }
  });
});

// =========================================================================
// 3. Epley: multi-rep uses load × (1 + reps/30), rounded
// =========================================================================

describe('spec: Epley 1RM formula for multi-rep sets', () => {
  it('5 reps at 225 lb → 263 (225 × 1.1667 rounded)', () => {
    // 225 * (1 + 5/30) = 225 * 1.1667 = 262.5 → rounds to 263
    expect(epley1RM(225, 5)).toBe(263);
  });

  it('10 reps at 185 lb → 247', () => {
    expect(epley1RM(185, 10)).toBe(247);
  });

  it('higher reps produce higher e1RM for same load', () => {
    expect(epley1RM(185, 10)).toBeGreaterThan(epley1RM(185, 5));
  });

  it('0 load → 0 regardless of reps', () => {
    expect(epley1RM(0, 5)).toBe(0);
  });
});

// =========================================================================
// 4 & 5. Keyset pagination + empty-day completed_count rollup
//
// Drives the REAL `loadHistoryPage` loader (the exact queryFn the History
// page runs) through an injected fake PostgREST query builder. We assert the
// production logic, not a copy of it:
//   • cursor is derived as the plan_date of the LAST returned row (claim 4)
//   • `.order('plan_date', { ascending:false })` is requested — DESC (claim 4)
//   • `.lt('plan_date', cursor)` is applied only when a cursor is passed (claim 4)
//   • per-plan completed_count is rolled up from the completed_sets rows, so a
//     plan with zero completed sets reports completed_count:0 — the value the
//     History UI filters on to hide empty days (claim 5, coachbyte.md:73/101)
//
// If loadHistoryPage stops ordering DESC, mis-derives the cursor, or breaks the
// count rollup, these go RED.
// =========================================================================

/**
 * Minimal chainable PostgREST builder stub. Records the `.order`/`.lt` calls
 * loadHistoryPage makes and resolves to a canned `{ data }` payload keyed by
 * table name. `await`-able (thenable) like a real Supabase query.
 */
function makeFakeCoachbyteClient(tables: Record<string, unknown[]>) {
  const calls = { order: [] as Array<{ col: string; opts: unknown }>, lt: [] as Array<{ col: string; val: unknown }> };
  function builder(table: string) {
    const data = tables[table] ?? [];
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    chain.select = passthrough;
    chain.eq = passthrough;
    chain.in = passthrough;
    chain.limit = passthrough;
    chain.order = (col: string, opts: unknown) => {
      calls.order.push({ col, opts });
      return chain;
    };
    chain.lt = (col: string, val: unknown) => {
      calls.lt.push({ col, val });
      return chain;
    };
    // Thenable: `await query` resolves to { data, error }.
    chain.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data, error: null });
    return chain;
  }
  const client = { schema: () => ({ from: (table: string) => builder(table) }) };
  return { client: client as never, calls };
}

describe('spec: history keyset pagination (loadHistoryPage)', () => {
  it('derives the cursor as the plan_date of the last returned row (DESC)', async () => {
    const { client, calls } = makeFakeCoachbyteClient({
      daily_plans: [
        { plan_id: 'p1', plan_date: '2026-04-30', summary: 'a' },
        { plan_id: 'p2', plan_date: '2026-04-28', summary: 'b' },
        { plan_id: 'p3', plan_date: '2026-04-25', summary: 'c' },
      ],
      planned_sets: [],
      completed_sets: [],
    });

    const page = await loadHistoryPage('u-1', null, client);

    // Cursor MUST be the last row's plan_date — not the first, not a constant.
    expect(page.cursor).toBe('2026-04-25');
    // Ordering is requested DESC (ascending:false). If prod flips to ASC → RED.
    expect(calls.order).toContainEqual({ col: 'plan_date', opts: { ascending: false } });
    // First page (null cursor) must NOT add a .lt() bound.
    expect(calls.lt).toHaveLength(0);
  });

  it('applies .lt(plan_date, cursor) only when a cursor is supplied', async () => {
    const { client, calls } = makeFakeCoachbyteClient({
      daily_plans: [{ plan_id: 'p9', plan_date: '2026-04-20', summary: null }],
      planned_sets: [],
      completed_sets: [],
    });

    await loadHistoryPage('u-1', '2026-04-25', client);

    expect(calls.lt).toContainEqual({ col: 'plan_date', val: '2026-04-25' });
  });

  it('returns null cursor / empty days when there are no plans', async () => {
    const { client } = makeFakeCoachbyteClient({ daily_plans: [], planned_sets: [], completed_sets: [] });
    const page = await loadHistoryPage('u-1', null, client);
    expect(page.days).toEqual([]);
    expect(page.cursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });
});

describe('spec: history per-day completed_count rollup (empty-day filter source)', () => {
  it('rolls completed_sets rows up per plan; a plan with no completed sets reports 0', async () => {
    const { client } = makeFakeCoachbyteClient({
      daily_plans: [
        { plan_id: 'busy', plan_date: '2026-04-30', summary: null },
        { plan_id: 'empty', plan_date: '2026-04-29', summary: null },
      ],
      planned_sets: [{ plan_id: 'busy' }, { plan_id: 'busy' }, { plan_id: 'empty' }],
      // 3 completed rows for 'busy', NONE for 'empty'.
      completed_sets: [{ plan_id: 'busy' }, { plan_id: 'busy' }, { plan_id: 'busy' }],
    });

    const page = await loadHistoryPage('u-1', null, client);
    const busy = page.days.find((d) => d.plan_id === 'busy');
    const empty = page.days.find((d) => d.plan_id === 'empty');

    // The count rollup is the production value the History list filters on
    // (filteredDays = allDays.filter(d => d.completed_count > 0)). If the
    // rollup miscounts, the "empty days hidden" behaviour breaks → RED.
    expect(busy?.completed_count).toBe(3);
    expect(empty?.completed_count).toBe(0);
    expect(busy?.planned_count).toBe(2);
  });
});
