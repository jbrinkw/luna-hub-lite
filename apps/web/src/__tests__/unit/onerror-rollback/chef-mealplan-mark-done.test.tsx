/**
 * onError rollback — MealPlanPage markDone/unmarkDone mutations (REAL component).
 *
 * Drives the SHIPPED `MealPlanPage` optimistic mark-done / undo-done
 * mutations, not in-file copies. We render the real page, let its
 * `useQuery` load a week of meals (one per weekday so whichever day the
 * page auto-selects has a meal), and:
 *   - markDone: click "Mark Done", force the `mark_meal_done` RPC to
 *     reject, assert the "Done" badge reverts (meal returns to pending).
 *   - unmarkDone: start from a completed meal, click "Undo", force the
 *     `unmark_meal_done` RPC to reject, assert the meal stays completed.
 *
 * Production onMutate flips `completed_at` AND seeds/removes a synthetic
 * food_log; onError must restore the whole `context.previous` snapshot.
 *
 * The `onSettled` invalidation refetch is gated by the test so the
 * synchronous onError rollback is the ONLY path that can revert within
 * the assertion window. Deleting the production rollback leaves the meal
 * stuck in the optimistic state → these tests go RED.
 *
 * Only the Supabase transport is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-mealplan-rollback';

interface MealRow {
  meal_id: string;
  user_id: string;
  recipe_id: string | null;
  product_id: string | null;
  logical_date: string;
  servings: number;
  meal_prep: boolean;
  meal_type: string | null;
  completed_at: string | null;
  recipes: null;
  products: {
    name: string;
    calories_per_serving: number;
    carbs_per_serving: number;
    protein_per_serving: number;
    fat_per_serving: number;
  };
}

function makeMeal(id: string, logicalDate: string, completed: boolean): MealRow {
  return {
    meal_id: id,
    user_id: USER_ID,
    recipe_id: null,
    product_id: 'prod-1',
    logical_date: logicalDate,
    servings: 1,
    meal_prep: false,
    meal_type: 'dinner',
    completed_at: completed ? '2026-04-30T18:00:00Z' : null,
    recipes: null,
    products: {
      name: 'Test Chicken',
      calories_per_serving: 200,
      carbs_per_serving: 0,
      protein_per_serving: 40,
      fat_per_serving: 5,
    },
  };
}

// Server state, keyed by meal_id.
let serverMeals: MealRow[] = [];

let rpcShouldFail = false;
let failingRpc: 'mark_meal_done' | 'unmark_meal_done' | null = null;

// Refetch gate on the meal_plan_entries week query.
let mealSelectCount = 0;
let releaseRefetch!: (rows: MealRow[]) => void;
let refetchGate: Promise<MealRow[]>;
function armRefetchGate() {
  refetchGate = new Promise((resolve) => {
    releaseRefetch = resolve;
  });
}

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const root: any = {};
    root.rpc = vi.fn((name: string) => {
      if ((name === 'mark_meal_done' || name === 'unmark_meal_done') && rpcShouldFail && name === failingRpc) {
        return Promise.resolve({ data: null, error: { message: `${name} failed` } });
      }
      if (name === 'mark_meal_done') {
        return Promise.resolve({ data: { partials: [] }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    root.from = vi.fn((table: string) => {
      const resolveFor = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        if (table === 'meal_plan_entries') {
          mealSelectCount += 1;
          if (mealSelectCount === 1) {
            resolve({ data: serverMeals, error: null });
          } else {
            refetchGate.then((rows) => resolve({ data: rows, error: null })).catch(reject);
          }
          return;
        }
        // food_logs, temp_items, user_config, shelf_event_log, products → empty.
        resolve({ data: [], error: null, count: 0 });
      };
      const b: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: any) => void, reject?: (e: unknown) => void) => resolveFor(resolve, reject);
            }
            return () => b;
          },
        },
      );
      return b;
    });
    return root;
  };
  return {
    supabase: {
      channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn(), unsubscribe: vi.fn() })),
      removeChannel: vi.fn(),
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID, email: 't@t.com' }, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

import { MealPlanPage } from '@/pages/chefbyte/MealPlanPage';
import { getMonday } from '@/pages/chefbyte/MealPlanPage';
import { toDateStr } from '@/shared/dates';
import { ThemeProvider } from '@/shared/ThemeProvider';

/** The 7 day-strings the page computes for the current displayed week. We
 *  seed a meal on EACH so whichever day the page auto-selects (today's
 *  logical date) renders one — making the test independent of the host
 *  timezone vs NY-profile week boundary. */
function weekDayStrings(): string[] {
  const weekStart = getMonday(new Date());
  return Array.from({ length: 7 }, (_, i) => toDateStr(new Date(weekStart.getTime() + i * 86400000)));
}

function renderMealPlan(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/chef/meal-plan']}>
          <MealPlanPage />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function makeQc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/** Find the single rendered meal_id by locating whichever mark-done or
 *  undo-done button exists in the auto-selected day. */
function findRenderedMealId(prefix: 'mark-done-' | 'undo-done-'): string {
  const btns = screen.getAllByTestId(new RegExp(`^${prefix}`));
  const id = btns[0].getAttribute('data-testid')!.slice(prefix.length);
  return id;
}

describe('MealPlanPage markDone/unmarkDone — onError rollback (real component)', () => {
  beforeEach(() => {
    rpcShouldFail = false;
    failingRpc = null;
    mealSelectCount = 0;
    armRefetchGate();
  });

  afterEach(() => {
    releaseRefetch?.(serverMeals);
    vi.clearAllMocks();
  });

  it('markDone: reverts the Done badge when mark_meal_done RPC rejects', async () => {
    // Seed one pending meal per weekday.
    serverMeals = weekDayStrings().map((d, i) => makeMeal(`pend-${i}`, d, false));
    rpcShouldFail = true;
    failingRpc = 'mark_meal_done';

    const qc = makeQc();
    const user = userEvent.setup();
    renderMealPlan(qc);

    // Wait for a Mark Done button to appear in the auto-selected day.
    await waitFor(() => {
      expect(screen.getAllByTestId(/^mark-done-/).length).toBeGreaterThan(0);
    });
    const mealId = findRenderedMealId('mark-done-');

    // No "Done" badge before.
    expect(screen.queryByTestId(`done-badge-${mealId}`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`mark-done-${mealId}`));

    // onMutate flips completed_at (Done badge appears), RPC rejects, onError
    // reverts. Refetch BLOCKED → rollback is the only restorer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Rolled back: the meal is pending again (Mark Done button present, no Done badge).
    await waitFor(() => {
      expect(screen.getByTestId(`mark-done-${mealId}`)).toBeInTheDocument();
    });
    expect(screen.queryByTestId(`done-badge-${mealId}`)).not.toBeInTheDocument();

    releaseRefetch(serverMeals);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId(`mark-done-${mealId}`)).toBeInTheDocument();
  });

  it('markDone: success keeps the meal done (success-path control)', async () => {
    serverMeals = weekDayStrings().map((d, i) => makeMeal(`pend-${i}`, d, false));
    rpcShouldFail = false;

    const qc = makeQc();
    const user = userEvent.setup();
    renderMealPlan(qc);

    await waitFor(() => {
      expect(screen.getAllByTestId(/^mark-done-/).length).toBeGreaterThan(0);
    });
    const mealId = findRenderedMealId('mark-done-');

    await user.click(screen.getByTestId(`mark-done-${mealId}`));

    // Reflect the completion server-side, then release the refetch.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      serverMeals = serverMeals.map((m) => (m.meal_id === mealId ? { ...m, completed_at: '2026-04-30T18:00:00Z' } : m));
      releaseRefetch(serverMeals);
      await new Promise((r) => setTimeout(r, 20));
    });

    // Stays done: the Undo button is present.
    await waitFor(() => {
      expect(screen.getByTestId(`undo-done-${mealId}`)).toBeInTheDocument();
    });
  });

  it('unmarkDone: reverts to completed when unmark_meal_done RPC rejects', async () => {
    // Seed one COMPLETED meal per weekday.
    serverMeals = weekDayStrings().map((d, i) => makeMeal(`done-${i}`, d, true));
    rpcShouldFail = true;
    failingRpc = 'unmark_meal_done';

    const qc = makeQc();
    const user = userEvent.setup();
    renderMealPlan(qc);

    await waitFor(() => {
      expect(screen.getAllByTestId(/^undo-done-/).length).toBeGreaterThan(0);
    });
    const mealId = findRenderedMealId('undo-done-');

    // Done badge present before.
    expect(screen.getByTestId(`done-badge-${mealId}`)).toBeInTheDocument();

    await user.click(screen.getByTestId(`undo-done-${mealId}`));

    // onMutate clears completed_at (Undo→Mark Done), RPC rejects, onError reverts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Rolled back: meal completed again (Undo button + Done badge present).
    await waitFor(() => {
      expect(screen.getByTestId(`undo-done-${mealId}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId(`done-badge-${mealId}`)).toBeInTheDocument();
  });
});
