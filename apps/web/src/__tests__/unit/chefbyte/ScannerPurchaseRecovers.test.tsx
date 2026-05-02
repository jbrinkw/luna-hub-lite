/**
 * Reproduces and locks in the fix for the user-reported bug:
 *
 *   "I scanned chocolate milk in Purchase mode to introduce a lot for the
 *    LiveTrack scale to match against. The scanner showed it scanned, but
 *    the lot never appeared in the inventory page."
 *
 * Root cause: a prior `discarded` shelf event had set the existing lot's
 * `qty_containers` to 0. The scanner's Purchase-mode merge SELECTED the
 * zero-qty lot, ran an UPDATE to bump `qty_containers = 0 + 1 = 1`, and
 * RETURNED — but the cache invalidation that drives the Inventory page's
 * refresh sat AFTER the switch (line 754 pre-fix) and was unreachable
 * because the Purchase branch returned inside its case. The DB write went
 * through silently, but the Inventory tab never re-fetched, so the user
 * thought no lot was created.
 *
 * Defense in depth: the post-fix code also surfaces the supabase-js
 * `.error` field as a queue row error so a real silent failure (RLS / 4xx /
 * network) can no longer hide behind status:'success'. This test exercises
 * the happy path; ScannerPurchaseSilentFailure.test would exercise the
 * error path.
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
const stockLotUpdates: Array<{ lot_id: string; patch: Record<string, unknown> }> = [];
const cacheInvalidations: Array<readonly unknown[]> = [];

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

function resetState() {
  stockLots.length = 0;
  stockLotUpdates.length = 0;
  cacheInvalidations.length = 0;
}

function seedDiscardedLot(lot: StockLotRow) {
  stockLots.push(lot);
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
      builder.limit = vi.fn(() => Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null }));

      const resolveStockLotsSelect = () => {
        // Match by user_id + product_id + location_id + (expires_on null).
        const rows = stockLots.filter((l) => {
          if (state.filters.user_id && l.user_id !== state.filters.user_id) return false;
          if (state.filters.product_id && l.product_id !== state.filters.product_id) return false;
          if (state.filters.location_id && l.location_id !== state.filters.location_id) return false;
          if (state.expiresOnIsNull && l.expires_on !== null) return false;
          return true;
        });
        return rows;
      };

      const finishUpdate = () => {
        // Apply the patch to matching rows, log it, return the first.
        const rows = stockLots.filter((l) => state.filters.lot_id && l.lot_id === state.filters.lot_id);
        for (const row of rows) {
          stockLotUpdates.push({ lot_id: row.lot_id, patch: { ...state.patch! } });
          Object.assign(row, state.patch!);
        }
        return rows[0]
          ? { data: { lot_id: rows[0].lot_id }, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'no row matched' } };
      };

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
          // Real PostgREST: maybeSingle returns null+null on 0 rows
          // (no PGRST116). Mirror that so the scanner's null-handling
          // branch exercises correctly.
          return Promise.resolve({
            data: state.filters.barcode === productKnown.barcode ? productKnown : null,
            error: null,
          });
        }
        if (table === 'stock_lots' && state.op === 'select') {
          const rows = resolveStockLotsSelect();
          return Promise.resolve({ data: rows[0] ?? null, error: null });
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
        if (table === 'products' && state.filters.product_id != null) {
          return Promise.resolve({
            data: state.filters.product_id === productKnown.product_id ? productKnown : null,
            error: null,
          });
        }
        if (table === 'stock_lots' && state.op === 'update') {
          return Promise.resolve(finishUpdate());
        }
        if (table === 'stock_lots' && state.op === 'insert') {
          return Promise.resolve(finishInsert());
        }
        return Promise.resolve({ data: null, error: null });
      });
      // Awaitable on .update(...).eq(...) — a few callers await without
      // .single(); resolve to no-op success.
      builder.then = (resolve: (v: unknown) => void) => {
        if (state.op === 'update' && table === 'stock_lots') {
          resolve(finishUpdate());
        } else if (state.op === 'update' && table === 'products') {
          // products.update on this mock isn't authoritative — the test
          // doesn't simulate the products table state; just acknowledge
          // success so the scanner's nutrition push-back path doesn't
          // surface a bogus "Nutrition update failed".
          resolve({ data: null, error: null });
        } else {
          resolve({ data: null, error: null });
        }
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

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

import { ScannerPage } from '@/pages/chefbyte/ScannerPage';

function renderScanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Spy on invalidations so we can assert the Inventory page would refresh.
  const origInvalidate = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = vi.fn((arg: any) => {
    if (arg?.queryKey) cacheInvalidations.push(arg.queryKey);
    return origInvalidate(arg);
  }) as any;
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('Scanner Purchase mode — recover from zero-qty lot (Bug A)', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('merges into an existing zero-qty discarded lot and bumps qty_containers', async () => {
    // Seed: prior discard zeroed the lot. expires_on null (matches user's
    // chocolate-milk product which has default_shelf_life_days = null).
    seedDiscardedLot({
      lot_id: 'lot-existing',
      user_id: 'user-1',
      product_id: 'prod-milk',
      location_id: 'loc-1',
      qty_containers: 0,
      expires_on: null,
    });

    const user = userEvent.setup();
    renderScanner();
    await scanBarcode(user, productKnown.barcode);

    await waitFor(() => {
      // The existing lot must now be at qty=1 (0 + 1 from default screenValue).
      const lot = stockLots.find((l) => l.lot_id === 'lot-existing');
      expect(lot?.qty_containers).toBe(1);
    });

    // No duplicate lot was created.
    expect(stockLots.length).toBe(1);

    // Cache invalidation MUST have fired so the Inventory page refreshes.
    // Pre-fix this never happened for Purchase mode (return ran before
    // the switch's tail invalidation). Without the invalidation the user
    // sees "scanned properly but the lot never showed up in inventory".
    const stockLotsKey = cacheInvalidations.find((k) => Array.isArray(k) && k[0] === 'stock-lots');
    expect(stockLotsKey).toBeDefined();
  });

  it('inserts a new lot when no merge candidate exists', async () => {
    // Empty seed → SELECT returns null → INSERT path.
    const user = userEvent.setup();
    renderScanner();
    await scanBarcode(user, productKnown.barcode);

    await waitFor(() => {
      expect(stockLots.length).toBe(1);
      expect(stockLots[0].qty_containers).toBe(1);
      expect(stockLots[0].product_id).toBe('prod-milk');
    });
  });

  it('queue row reflects known-product confirmed (green) state on successful scan', async () => {
    // The user-visible side of Bug B: a known product must NOT light up red.
    // Auto-confirm sets the row's bg to bg-success-subtle (green) instead
    // of bg-danger-subtle (red).
    seedDiscardedLot({
      lot_id: 'lot-existing',
      user_id: 'user-1',
      product_id: 'prod-milk',
      location_id: 'loc-1',
      qty_containers: 0,
      expires_on: null,
    });
    const user = userEvent.setup();
    renderScanner();
    await scanBarcode(user, productKnown.barcode);

    // Find the queue row and inspect its className. The component sets
    // 'bg-success-subtle' when confirmed, 'bg-danger-subtle' when not.
    await waitFor(() => {
      const row = screen.getAllByTestId(/^queue-item-/)[0] as HTMLElement;
      // Known product → confirmed=true → green bg.
      expect(row.className).toContain('bg-success-subtle');
      expect(row.className).not.toContain('bg-danger-subtle');
    });

    // The [!NEW] badge must not be rendered for the known product.
    expect(screen.queryByText('[!NEW]')).toBeNull();
  });
});
