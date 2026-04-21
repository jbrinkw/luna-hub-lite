/**
 * Reproduces the owner-reported bug: "scan 3 items, edit s/c=5.5 on one,
 * click through the other two, all three end up with s/c=5.5 in the DB."
 *
 * Strategy: mock chefbyte() such that every `from('products').update({...})
 * .eq('product_id', id)` is captured. We drive three scans + one keypad
 * edit + two queue-row clicks, then assert that update() was never called
 * against product_ids other than the one we actually edited with those
 * specific values.
 *
 * If this test fails, the bug is real. If it passes, the deploy is lagging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/*  Capture every update() against products                            */
/* ------------------------------------------------------------------ */

interface ProductUpdate {
  productId: string;
  patch: Record<string, unknown>;
}

const productsById: Record<string, {
  product_id: string;
  barcode: string;
  name: string;
  is_placeholder: boolean;
  servings_per_container: number;
  calories_per_serving: number;
  protein_per_serving: number;
  carbs_per_serving: number;
  fat_per_serving: number;
  default_shelf_life_days: number | null;
}> = {};

const productUpdates: ProductUpdate[] = [];

function resetProducts() {
  Object.keys(productsById).forEach((k) => delete productsById[k]);
  productUpdates.length = 0;
}

function addProduct(p: { product_id: string; barcode: string; name: string; servings_per_container: number }) {
  productsById[p.product_id] = {
    is_placeholder: false,
    calories_per_serving: 100,
    protein_per_serving: 10,
    carbs_per_serving: 15,
    fat_per_serving: 5,
    default_shelf_life_days: null,
    ...p, // spreads product_id, barcode, name, servings_per_container
  };
}

/* Stub that returns a chefbyte()-like builder, enough to satisfy the
   scanner's .from('products').select().eq(...).single() pattern plus
   .from('products').update(patch).eq('product_id', id). */
vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const rootBuilder: any = {};
    rootBuilder.from = vi.fn((table: string) => {
      const b: any = {};
      const state: { mode: 'select' | 'update'; patch: Record<string, unknown> | null; filters: Record<string, unknown> } = {
        mode: 'select',
        patch: null,
        filters: {},
      };
      b.select = vi.fn(() => b);
      b.update = vi.fn((patch: Record<string, unknown>) => {
        state.mode = 'update';
        state.patch = patch;
        return b;
      });
      b.insert = vi.fn(() => b);
      b.eq = vi.fn((col: string, val: unknown) => {
        state.filters[col] = val;
        if (state.mode === 'update' && table === 'products' && col === 'product_id') {
          productUpdates.push({ productId: String(val), patch: state.patch! });
          state.mode = 'select';
        }
        return b;
      });
      b.is = vi.fn(() => b);
      b.order = vi.fn(() => b);
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
      b.single = vi.fn(() => {
        if (table === 'products' && state.filters.barcode != null) {
          const barcode = String(state.filters.barcode);
          const hit = Object.values(productsById).find((p) => p.barcode === barcode);
          return Promise.resolve({ data: hit ?? null, error: hit ? null : { code: 'PGRST116' } });
        }
        if (table === 'products' && state.filters.product_id != null) {
          const id = String(state.filters.product_id);
          return Promise.resolve({ data: productsById[id] ?? null, error: null });
        }
        if (table === 'stock_lots') {
          return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
        }
        return Promise.resolve({ data: null, error: null });
      });
      b.then = (resolve: (v: unknown) => void) => {
        resolve({ data: null, error: null });
      };
      return b;
    });
    rootBuilder.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return rootBuilder;
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
  // Let scan-side async resolve
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe('Scanner cross-contamination', () => {
  beforeEach(() => {
    resetProducts();
    addProduct({ product_id: 'p1', barcode: 'BC1', name: 'Product 1', servings_per_container: 1 });
    addProduct({ product_id: 'p2', barcode: 'BC2', name: 'Product 2', servings_per_container: 2 });
    addProduct({ product_id: 'p3', barcode: 'BC3', name: 'Product 3', servings_per_container: 3 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('editing s/c on product 3 does NOT propagate to product 1 or 2 when clicking their queue rows', async () => {
    const user = userEvent.setup();
    renderScanner();

    // 1. Scan three known barcodes.
    await scanBarcode(user, 'BC1');
    await scanBarcode(user, 'BC2');
    await scanBarcode(user, 'BC3');

    // After 3 scans, activeItemId should be the most-recent (BC3 / p3).
    // Wait for the post-scan activeProductId → load effect cycle to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Clear the historical update log so the assertion focuses on
    // post-edit + post-click writes only.
    productUpdates.length = 0;

    // 2. User types "5.5" on the keypad targeting servings-per-container.
    // The scan handler auto-focuses this field on scan, so pressing digits
    // routes there without clicking first.
    const key5 = screen.getByTestId('key-5');
    const keyDot = screen.getByTestId('key-.');
    await user.click(key5);
    await user.click(keyDot);
    await user.click(key5);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    // 3. Click the item-1 queue row and then item-2 queue row. Need to find
    //    them by their productId — the queue-item testid uses the local
    //    tempId, not product_id, so scan them out by text.
    const queueRows = screen.getAllByTestId(/^queue-item-/);
    // Order: newest first, so BC3=row[0], BC2=row[1], BC1=row[2]
    const row_item1 = queueRows[2];
    const row_item2 = queueRows[1];

    await user.click(row_item1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(row_item2);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // 4. Assert: product 1 and product 2 must NOT have received a
    //    servings_per_container=5.5 write. Product 3 MUST have been
    //    written with 5.5 (that's the user's intentional edit).
    const writesToP1 = productUpdates.filter((u) => u.productId === 'p1' && u.patch.servings_per_container === 5.5);
    const writesToP2 = productUpdates.filter((u) => u.productId === 'p2' && u.patch.servings_per_container === 5.5);
    const writesToP3 = productUpdates.filter((u) => u.productId === 'p3' && u.patch.servings_per_container === 5.5);

    expect({
      p1_got_5_5: writesToP1.length,
      p2_got_5_5: writesToP2.length,
      p3_got_5_5: writesToP3.length,
      allUpdates: productUpdates,
    }).toEqual({
      p1_got_5_5: 0,
      p2_got_5_5: 0,
      p3_got_5_5: expect.any(Number), // allow any positive number (each keystroke = 1 write)
      allUpdates: expect.any(Array),
    });
    expect(writesToP3.length).toBeGreaterThan(0);
  });
});
