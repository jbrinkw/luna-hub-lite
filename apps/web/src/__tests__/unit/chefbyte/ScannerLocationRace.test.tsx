/**
 * Bug A — Scanner location-race regression test.
 *
 * Reproduces the bug e2e harness scenarios 01-03 worked around: the
 * `handleBarcodeSubmit` useCallback dep array did NOT include
 * `defaultLocationId`. First scan after a fresh page load races: the
 * closure captures the initial value (null) before the location query
 * resolves, then the scan silently fails with "No location configured."
 *
 * The harness scenarios masked this by tapping a keypad button before
 * scanning — that re-render produced a new closure that picked up the
 * resolved `defaultLocationId`. Real users won't do that.
 *
 * Strategy:
 *   1. Render the scanner. The locations query is in-flight (deferred).
 *      Initial render of `handleBarcodeSubmit` closes over
 *      `defaultLocationId = undefined`.
 *   2. Resolve the locations query. With the fix, `defaultLocationId`
 *      is in the useCallback dep array, so `handleBarcodeSubmit` is
 *      recreated and captures `executeAction` referencing the resolved
 *      location id. Without the fix, the dep array does NOT include
 *      `defaultLocationId`, so the original (stale) closure is still
 *      active.
 *   3. Submit a barcode for a known product. The onKeyDown handler in
 *      ScannerPage's JSX reads the *current* `handleBarcodeSubmit` from
 *      the latest render — but a useCallback that hasn't re-run
 *      returns the same memoized reference with stale closure.
 *   4. With fix: a stock_lots row was created at the resolved
 *      location_id, no "No location configured" error.
 *      Without fix: no stock_lots row, queue row in error state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/*  Stub state                                                         */
/* ------------------------------------------------------------------ */

interface StockLotRow {
  lot_id: string;
  user_id: string;
  product_id: string;
  location_id: string;
  qty_containers: number;
  expires_on: string | null;
}

const stockLots: StockLotRow[] = [];

const productKnown = {
  product_id: 'prod-milk',
  name: 'Chocolate Milk',
  barcode: '856312002795',
  is_placeholder: false,
  calories_per_serving: 336,
  protein_per_serving: 16,
  carbs_per_serving: 32,
  fat_per_serving: 12,
  servings_per_container: 6,
  default_shelf_life_days: null,
};

// The deferred-location promise. The mock resolves the locations
// query through this so the test can control WHEN the user-id-keyed
// query lands. Set up fresh per test.
let locationDeferred: {
  resolve: (rows: { location_id: string }[]) => void;
  promise: Promise<{ location_id: string }[]>;
};

function makeDeferred(): typeof locationDeferred {
  let resolve: (rows: { location_id: string }[]) => void = () => {};
  const promise = new Promise<{ location_id: string }[]>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function resetState() {
  stockLots.length = 0;
  locationDeferred = makeDeferred();
}

/* ------------------------------------------------------------------ */
/*  Supabase + chefbyte mock                                           */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const root: any = {};
    root.from = vi.fn((table: string) => {
      const builder: any = {};
      const state: {
        op: 'select' | 'update' | 'insert';
        patch: Record<string, unknown> | null;
        insertRow: Record<string, unknown> | null;
        filters: Record<string, unknown>;
        expiresOnIsNull: boolean;
      } = {
        op: 'select',
        patch: null,
        insertRow: null,
        filters: {},
        expiresOnIsNull: false,
      };

      builder.select = vi.fn(() => builder);
      builder.update = vi.fn((patch: Record<string, unknown>) => {
        state.op = 'update';
        state.patch = patch;
        return builder;
      });
      builder.insert = vi.fn((row: Record<string, unknown>) => {
        state.op = 'insert';
        state.insertRow = row;
        return builder;
      });
      builder.eq = vi.fn((col: string, val: unknown) => {
        state.filters[col] = val;
        return builder;
      });
      builder.is = vi.fn((col: string, val: unknown) => {
        if (col === 'expires_on' && val === null) state.expiresOnIsNull = true;
        return builder;
      });
      builder.not = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      // The locations queryFn ends in `.limit(1)` (no .single() / .maybeSingle()).
      // For the `locations` table we resolve through the deferred so the test
      // can simulate a slow first-fetch. Other tables (none use limit here)
      // get an empty resolution.
      builder.limit = vi.fn(() => {
        if (table === 'locations') {
          return locationDeferred.promise.then((rows) => ({ data: rows, error: null }));
        }
        return Promise.resolve({ data: [], error: null });
      });

      const finishInsert = () => {
        if (table === 'stock_lots') {
          const newLot: StockLotRow = {
            lot_id: `lot-new-${stockLots.length + 1}`,
            user_id: state.insertRow!.user_id as string,
            product_id: state.insertRow!.product_id as string,
            location_id: state.insertRow!.location_id as string,
            qty_containers: Number(state.insertRow!.qty_containers ?? 0),
            expires_on: (state.insertRow!.expires_on as string | null) ?? null,
          };
          stockLots.push(newLot);
          return { data: { lot_id: newLot.lot_id }, error: null };
        }
        return { data: null, error: null };
      };

      builder.maybeSingle = vi.fn(() => {
        if (table === 'products' && state.filters.barcode != null) {
          // PostgREST maybeSingle returns null+null on 0 rows (no PGRST116).
          return Promise.resolve({
            data: state.filters.barcode === productKnown.barcode ? productKnown : null,
            error: null,
          });
        }
        if (table === 'stock_lots' && state.op === 'select') {
          // No existing lot — insert path.
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.single = vi.fn(() => {
        if (table === 'products' && state.filters.barcode != null) {
          return Promise.resolve({
            data: state.filters.barcode === productKnown.barcode ? productKnown : null,
            error: state.filters.barcode === productKnown.barcode ? null : { code: 'PGRST116' },
          });
        }
        if (table === 'stock_lots' && state.op === 'insert') {
          return Promise.resolve(finishInsert());
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.then = (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: null });
      };
      return builder;
    });
    root.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return root;
  };
  return {
    supabase: { functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) } },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

// Stable references — useCallback dep arrays compare by Object.is, so a
// mock that returns a fresh `user` object every render would re-create
// the memoized handler on EVERY render and accidentally paper over the
// dep-array bug. Pin the references to mimic real provider behavior.
const STABLE_USER = { id: 'user-1', email: 't@t.com' };
const STABLE_AUTH = {
  user: STABLE_USER,
  loading: false,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
};

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => STABLE_AUTH,
}));

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

import { ScannerPage } from '@/pages/chefbyte/ScannerPage';

function renderScanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/scanner']}>
        <ScannerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function scanBarcode(user: ReturnType<typeof userEvent.setup>, barcode: string) {
  const input = screen.getByTestId('barcode-input') as HTMLInputElement;
  await user.clear(input);
  await user.type(input, barcode);
  await user.keyboard('{Enter}');
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('Scanner — first-scan location-race (Bug A)', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('scan after locations resolve picks up locationId via re-memoized useCallback', async () => {
    const user = userEvent.setup();
    renderScanner();

    // Initial render: useQuery for locations is in-flight (locationDeferred
    // unresolved). The first `handleBarcodeSubmit` useCallback creation
    // closes over `defaultLocationId === undefined`.

    // Resolve the locations query. React Query's data transitions from
    // undefined → 'loc-1' on the next tick, and the component re-renders.
    // With the dep-array fix, the new render's useCallback sees
    // `defaultLocationId` change and recreates `handleBarcodeSubmit`
    // closing over the latest `executeAction` (which references
    // 'loc-1'). Without the fix, the useCallback's deps don't include
    // `defaultLocationId`, so the SAME memoized handler is returned —
    // referencing the stale `executeAction` from the first render.
    await act(async () => {
      locationDeferred.resolve([{ location_id: 'loc-1' }]);
      // Allow React Query's promise → setState → re-render to flush.
      await new Promise((r) => setTimeout(r, 50));
    });

    // Now scan. Without the fix, the closure has `defaultLocationId =
    // undefined` and the Purchase branch returns
    //   { error: 'No location configured. Add one in Settings.' }
    // surfaced on the queue row. No stock_lots row is created.
    // With the fix, the closure has 'loc-1' and the insert happens.
    await scanBarcode(user, productKnown.barcode);

    // Wait for the async product-lookup → executeAction → insert path.
    await waitFor(
      () => {
        expect(stockLots.length).toBe(1);
      },
      { timeout: 2000 },
    );

    expect(stockLots[0].product_id).toBe('prod-milk');
    expect(stockLots[0].location_id).toBe('loc-1');

    // The queue row must NOT be in the error state with the "No location
    // configured" message — that's the user-visible symptom of the bug.
    const rows = screen.getAllByTestId(/^queue-item-/);
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.queryByText(/No location configured/i)).toBeNull();
  });
});
