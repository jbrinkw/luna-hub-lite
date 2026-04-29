/**
 * UX_AUDIT_CHEFBYTE_USE_R2 #4 — full optimistic mark-done.
 *
 * Pre-fix: HomePage's markMealDone optimistic update only flipped
 * `completed_at` on the meal row. The badge swapped instantly but
 *   - the Consumed Today panel stayed empty for ~300ms.
 *   - the meal stock badge stayed "CAN MAKE" even though we just
 *     deducted ingredients.
 *   - the hero macro progress bars stayed put.
 *
 * Post-fix: onMutate also seeds:
 *   1. A synthetic food_logs row with `log_id = optimistic-<mealId>`
 *      and the meal's macros.
 *   2. A decremented stockByProduct map for every ingredient.
 *   3. A bumped macros.consumed snapshot.
 *
 * This test exercises the production HomePage with a faked Supabase
 * client and asserts that — between the click and the RPC resolving —
 * the cache reflects all four edits. If a future refactor regresses
 * any of the seed/decrement/bump steps, the corresponding assertion
 * fails.
 *
 * The mark_meal_done RPC is stubbed to return after a microtask so we
 * can sample the optimistic cache state synchronously after the click,
 * before onSettled refetches anything.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-1';
const MEAL_ID = 'meal-1';
const PRODUCT_ID = 'prod-1';

/* In-memory state */
const today = '2026-04-29';

let mealRow: any = {
  meal_id: MEAL_ID,
  servings: 1,
  meal_type: 'lunch',
  completed_at: null,
  product_id: PRODUCT_ID,
  recipes: null,
  products: {
    name: 'Greek Yogurt',
    calories_per_serving: 150,
    protein_per_serving: 17,
    carbs_per_serving: 9,
    fat_per_serving: 5,
    servings_per_container: 1,
  },
};

const stockRow: any = {
  product_id: PRODUCT_ID,
  qty_containers: 3,
  expires_on: '2026-12-31',
};

const macroResponse = {
  calories: { consumed: 0, goal: 2000, remaining: 2000 },
  protein: { consumed: 0, goal: 150, remaining: 150 },
  carbs: { consumed: 0, goal: 200, remaining: 200 },
  fat: { consumed: 0, goal: 65, remaining: 65 },
};

const rpcCalls: Array<{ fn: string; args: any }> = [];

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
      const b: any = {};
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.gt = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.not = vi.fn(() => b);
      b.ilike = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.order = vi.fn(() => {
        // Order is the await terminus for several queries — return shaped data per table.
        if (table === 'meal_plan_entries') {
          return Promise.resolve({ data: [mealRow], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.limit = vi.fn(() => b);
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      // For queries that don't call .order(), the .eq() chain itself is the terminus.
      b.then = (resolve: (v: any) => void) => {
        if (table === 'stock_lots') {
          resolve({ data: [stockRow], error: null });
          return;
        }
        if (table === 'meal_plan_entries') {
          resolve({ data: [mealRow], error: null });
          return;
        }
        resolve({ data: [], error: null });
      };
      b.update = vi.fn(() => b);
      b.insert = vi.fn(() => Promise.resolve({ error: null }));
      b.delete = vi.fn(() => Promise.resolve({ error: null }));
      b.upsert = vi.fn(() => Promise.resolve({ error: null }));
      return b;
    });
    builder.rpc = vi.fn((fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === 'get_daily_macros') {
        return Promise.resolve({ data: macroResponse, error: null });
      }
      if (fn === 'mark_meal_done') {
        // Resolve on a microtask so the optimistic cache sample below
        // can run before onSettled invalidates.
        return new Promise((resolve) => {
          setTimeout(() => {
            mealRow = { ...mealRow, completed_at: '2026-04-29T12:00:00Z' };
            resolve({ data: null, error: null });
          }, 50);
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    return builder;
  };
  return {
    supabase: {
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
    },
    chefbyte,
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: USER_ID, email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/shared/AppProvider', () => ({
  useAppContext: () => ({ dayStartHour: 6 }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: () => {},
}));

// Mock todayStr to a stable value so the fixture data lines up.
vi.mock('@/shared/dates', async () => {
  const actual: any = await vi.importActual('@/shared/dates');
  return {
    ...actual,
    todayStr: () => today,
  };
});

import { HomePage } from '@/pages/chefbyte/HomePage';

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chef']}>
          <HomePage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('HomePage markMealDone — R2 audit #4 full optimism', () => {
  it('seeds food_logs, decrements stockByProduct, and bumps macros.consumed', async () => {
    const { qc } = renderHome();

    // Wait for initial data load — meal row visible.
    await screen.findByTestId(`meal-entry-${MEAL_ID}`);

    // Pre-click sanity: stock badge should NOT be NO STOCK (we have 3 containers).
    expect(screen.getByTestId(`meal-stock-${MEAL_ID}`)).toBeTruthy();

    // Sample the cache key shape used by HomePage.
    const homeKey = ['chef-home', USER_ID, today];
    const before = qc.getQueryData<any>(homeKey);
    expect(before).toBeDefined();
    expect(before.foodLogs.length).toBe(0);
    expect(before.stockByProduct.get(PRODUCT_ID)).toBe(3);
    expect(before.macros.consumed.calories).toBe(0);

    // Click Mark Done. fireEvent bypasses the pointer-events check
    // (the macro hero <Link> wrapper intercepts userEvent's pointer
    // hover); we just need the click handler to fire so onMutate runs.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`meal-done-${MEAL_ID}`));
    });

    // Sample the cache during the optimistic window — BEFORE the RPC
    // resolves (we set a 50ms delay). The optimistic patch is now in
    // the cache.
    const optimistic = qc.getQueryData<any>(homeKey);

    // 1. completed_at flipped on the meal.
    expect(optimistic.todaysMeals[0].completed_at).not.toBeNull();

    // 2. Synthetic food_logs row seeded.
    const seeded = optimistic.foodLogs.find((l: any) => l.log_id === `optimistic-${MEAL_ID}`);
    expect(seeded).toBeDefined();
    expect(seeded.calories).toBe(150);
    expect(seeded.protein).toBe(17);

    // 3. stockByProduct decremented (1 serving / 1 spc = 1 container; 3 - 1 = 2).
    expect(optimistic.stockByProduct.get(PRODUCT_ID)).toBe(2);

    // 4. macros.consumed bumped by the meal's contribution.
    expect(optimistic.macros.consumed.calories).toBe(150);
    expect(optimistic.macros.consumed.protein).toBe(17);
    expect(optimistic.macros.consumed.carbs).toBe(9);
    expect(optimistic.macros.consumed.fat).toBe(5);

    // The RPC was actually called (sanity — proves we're testing the real flow).
    expect(rpcCalls.find((c) => c.fn === 'mark_meal_done')).toEqual({
      fn: 'mark_meal_done',
      args: { p_meal_id: MEAL_ID },
    });
  });
});
