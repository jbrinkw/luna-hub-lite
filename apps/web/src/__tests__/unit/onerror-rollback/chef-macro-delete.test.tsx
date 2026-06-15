/**
 * onError rollback — MacroPage deleteMutation + editQtyMutation (REAL component).
 *
 * Drives the SHIPPED `MacroPage` optimistic mutations, not in-file copies.
 * We render the real page, let its `useQuery` (via `loadMacroPageData`)
 * load a single consumed food-log row, and:
 *   - deleteMutation: click the row's delete button, force the `food_logs`
 *     DELETE to reject, assert the row is restored.
 *   - editQtyMutation: open the inline qty editor, save a new qty, force
 *     the `update_food_log_qty` RPC to reject, assert the original qty is
 *     restored.
 *
 * Production onMutate optimistically removes / rescales the row; onError
 * must restore `context.previous` (the full snapshot).
 *
 * The `onSettled` invalidation refetch is gated by the test so the
 * synchronous onError rollback is the ONLY path that can restore within
 * the assertion window. Deleting the production rollback leaves the row
 * gone / rescaled → these tests go RED.
 *
 * Only the Supabase transport is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-macro-rollback';
const LOG_ID = 'log-1';

interface FoodLogRow {
  log_id: string;
  product_id: string;
  qty_consumed: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  products: {
    name: string;
    servings_per_container: number;
    visual_unit_label: null;
    visual_units_per_serving: null;
    display_by_weight: false;
    net_weight_g: null;
  };
}

let serverFoodLogs: FoodLogRow[] = [];
function resetServer() {
  serverFoodLogs = [
    {
      log_id: LOG_ID,
      product_id: 'prod-1',
      qty_consumed: 2,
      unit: 'serving',
      calories: 300,
      protein: 20,
      carbs: 30,
      fat: 10,
      products: {
        name: 'Test Oats',
        servings_per_container: 1,
        visual_unit_label: null,
        visual_units_per_serving: null,
        display_by_weight: false,
        net_weight_g: null,
      },
    },
  ];
}

let deleteShouldFail = false;
let editRpcShouldFail = false;

// Refetch gate on the food_logs read (the macro page's `useQuery`). Blocks
// the onSettled refetch so it can't mask a missing onError rollback.
let foodLogSelectCount = 0;
let releaseRefetch!: (rows: FoodLogRow[]) => void;
let refetchGate: Promise<FoodLogRow[]>;
function armRefetchGate() {
  refetchGate = new Promise((resolve) => {
    releaseRefetch = resolve;
  });
}

vi.mock('@/shared/supabase', () => {
  const buildClient = () => {
    const root: any = {};
    root.rpc = vi.fn((name: string) => {
      if (name === 'get_daily_macros') {
        return Promise.resolve({
          data: {
            calories: { consumed: 300, goal: 2000, remaining: 1700 },
            protein: { consumed: 20, goal: 150, remaining: 130 },
            carbs: { consumed: 30, goal: 200, remaining: 170 },
            fat: { consumed: 10, goal: 65, remaining: 55 },
          },
          error: null,
        });
      }
      if (name === 'update_food_log_qty') {
        if (editRpcShouldFail) {
          return Promise.resolve({ data: null, error: { message: 'update_food_log_qty failed' } });
        }
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    root.from = vi.fn((table: string) => {
      let isDelete = false;
      const resolveFor = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        if (table === 'food_logs' && isDelete) {
          if (deleteShouldFail) {
            resolve({ data: null, error: { message: 'delete failed' } });
          } else {
            serverFoodLogs = serverFoodLogs.filter((r) => r.log_id !== LOG_ID);
            resolve({ data: null, error: null });
          }
          return;
        }
        if (table === 'food_logs') {
          foodLogSelectCount += 1;
          if (foodLogSelectCount === 1) {
            resolve({ data: serverFoodLogs, error: null });
          } else {
            refetchGate.then((rows) => resolve({ data: rows, error: null })).catch(reject);
          }
          return;
        }
        // temp_items, meal_plan_entries, products, shelf_event_log → empty.
        resolve({ data: [], error: null, count: 0 });
      };
      const b: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: any) => void, reject?: (e: unknown) => void) => resolveFor(resolve, reject);
            }
            if (prop === 'delete') {
              return () => {
                isDelete = true;
                return b;
              };
            }
            return () => b;
          },
        },
      );
      return b;
    });
    return root;
  };
  // MacroPage's loadMacroPageData reads via `supabase.schema('chefbyte')`
  // directly (not the chefbyte() export), and useUnitSystem reads via
  // `supabase.schema('hub')`. Route every schema() through the same
  // table-driven client; unknown tables resolve empty.
  const supabase: any = {
    schema: vi.fn(() => buildClient()),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn(), unsubscribe: vi.fn() })),
    removeChannel: vi.fn(),
  };
  return {
    supabase,
    chefbyte: () => buildClient(),
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID, email: 't@t.com' }, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

import { MacroPage } from '@/pages/chefbyte/MacroPage';
import { ThemeProvider } from '@/shared/ThemeProvider';

function renderMacro(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/chef/macros']}>
          <MacroPage />
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

describe('MacroPage deleteMutation/editQtyMutation — onError rollback (real component)', () => {
  beforeEach(() => {
    resetServer();
    deleteShouldFail = false;
    editRpcShouldFail = false;
    foodLogSelectCount = 0;
    armRefetchGate();
  });

  afterEach(() => {
    releaseRefetch?.(serverFoodLogs);
    vi.clearAllMocks();
  });

  it('deleteMutation: restores the consumed row when the DELETE rejects', async () => {
    deleteShouldFail = true;
    const qc = makeQc();
    const user = userEvent.setup();
    renderMacro(qc);

    // Consumed row present.
    await screen.findByTestId(`consumed-row-${LOG_ID}`);
    expect(screen.getByText('Test Oats')).toBeInTheDocument();

    // Click delete → optimistic remove, DELETE rejects, onError restores.
    await user.click(screen.getByTestId(`delete-consumed-${LOG_ID}`));

    // Refetch BLOCKED → rollback is the only restorer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Rolled back: row is back.
    await waitFor(() => {
      expect(screen.getByTestId(`consumed-row-${LOG_ID}`)).toBeInTheDocument();
    });

    // Server never deleted it.
    expect(serverFoodLogs.some((r) => r.log_id === LOG_ID)).toBe(true);

    releaseRefetch(serverFoodLogs);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId(`consumed-row-${LOG_ID}`)).toBeInTheDocument();
  });

  it('deleteMutation: success removes the row (success-path control)', async () => {
    deleteShouldFail = false;
    const qc = makeQc();
    const user = userEvent.setup();
    renderMacro(qc);

    await screen.findByTestId(`consumed-row-${LOG_ID}`);

    await user.click(screen.getByTestId(`delete-consumed-${LOG_ID}`));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      releaseRefetch(serverFoodLogs); // now empty
      await new Promise((r) => setTimeout(r, 20));
    });

    // Row stays gone.
    await waitFor(() => {
      expect(screen.queryByTestId(`consumed-row-${LOG_ID}`)).not.toBeInTheDocument();
    });
    expect(serverFoodLogs.some((r) => r.log_id === LOG_ID)).toBe(false);
  });

  it('editQtyMutation: restores the original qty when update_food_log_qty rejects', async () => {
    editRpcShouldFail = true;
    const qc = makeQc();
    const user = userEvent.setup();
    renderMacro(qc);

    await screen.findByTestId(`consumed-row-${LOG_ID}`);
    // Original qty shown.
    expect(screen.getByTestId(`consumed-qty-${LOG_ID}`)).toBeInTheDocument();

    // Open the inline editor.
    await user.click(screen.getByTestId(`edit-consumed-${LOG_ID}`));
    const input = (await screen.findByTestId(`edit-qty-input-${LOG_ID}`)) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '6');
    await user.click(screen.getByTestId(`edit-qty-save-${LOG_ID}`));

    // onMutate rescales optimistically, RPC rejects, onError restores.
    // Refetch BLOCKED → rollback is the only restorer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Rolled back: the row's qty display is back to the original (2). The
    // editor closed (editingId cleared in onMutate), and onError restored
    // the cache, so the original qty badge is shown again.
    await waitFor(() => {
      expect(screen.getByTestId(`consumed-qty-${LOG_ID}`)).toHaveTextContent('2');
    });

    releaseRefetch(serverFoodLogs);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId(`consumed-qty-${LOG_ID}`)).toHaveTextContent('2');
  });
});
