/**
 * Tests for the distinct-unit scanner changes (2026-04-29):
 *
 *   1. analyze-product failure with no existing placeholder → no INSERT;
 *      queue item shows 'error' status with actionable message.
 *   2. analyze-product success → upgrade-in-place writes is_distinct_unit_item,
 *      default_recipe_unit, and net_weight_g alongside the existing fields.
 *
 * These tests exercise the scanner's handleBarcodeSubmit logic via a
 * shallow render (no real DB, no real network). The mock captures
 * products.insert calls so we can assert zero mints on failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/*  Hoisted mocks                                                      */
/* ------------------------------------------------------------------ */

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(() => Promise.resolve({ data: null, error: { message: 'analyze-product failed' } })),
}));

/* ------------------------------------------------------------------ */
/*  Mock state                                                         */
/* ------------------------------------------------------------------ */

interface MockState {
  productsInserts: number;
  lastInsertPayload: any;
  lastUpdatePayload: any;
  productsUpdates: Array<{ patch: any; filters: Record<string, unknown> }>;
}

const mockState: MockState = {
  productsInserts: 0,
  lastInsertPayload: null,
  lastUpdatePayload: null,
  productsUpdates: [],
};

/* ------------------------------------------------------------------ */
/*  Supabase mock                                                      */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const root: any = {};
    root.from = vi.fn((table: string) => {
      const builder: any = {};
      const state: {
        op: 'select' | 'update' | 'insert' | 'delete';
        patch: any;
        filters: Record<string, unknown>;
      } = { op: 'select', patch: null, filters: {} };

      builder.select = vi.fn(() => builder);
      builder.update = vi.fn((patch: any) => {
        state.op = 'update';
        state.patch = patch;
        mockState.lastUpdatePayload = patch;
        if (table === 'products') {
          mockState.productsUpdates.push({ patch, filters: { ...state.filters } });
        }
        return builder;
      });
      builder.insert = vi.fn((payload: any) => {
        state.op = 'insert';
        if (table === 'products') {
          mockState.productsInserts++;
          mockState.lastInsertPayload = payload;
        }
        return builder;
      });
      builder.delete = vi.fn(() => {
        state.op = 'delete';
        return builder;
      });
      builder.upsert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.eq = vi.fn((col: string, val: unknown) => {
        state.filters[col] = val;
        return builder;
      });
      builder.is = vi.fn(() => builder);
      builder.not = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null }));
      builder.in = vi.fn(() => builder);

      builder.maybeSingle = vi.fn(() => {
        // Unknown barcode → no existing product
        if (table === 'products') return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: null });
      });

      builder.single = vi.fn(() => {
        if (table === 'stock_lots' && state.op === 'insert') {
          return Promise.resolve({ data: { lot_id: 'lot-new' }, error: null });
        }
        if (table === 'products' && state.op === 'insert') {
          return Promise.resolve({
            data: { product_id: 'prod-new', name: 'New AI Product' },
            error: null,
          });
        }
        if (table === 'products' && state.op === 'update') {
          return Promise.resolve({
            data: {
              product_id: 'prod-updated',
              name: 'Updated AI Product',
              is_placeholder: false,
              is_distinct_unit_item: true,
              default_recipe_unit: 'serving',
              net_weight_g: null,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      builder.then = (resolve: (v: unknown) => void) => {
        if (state.op === 'update' && table === 'products') {
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: null, error: null });
      };

      return builder;
    });
    root.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return root;
  };

  return {
    supabase: { functions: { invoke: invokeMock } },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-scanner-test', email: 't@t.com' },
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function renderScanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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

beforeEach(() => {
  mockState.productsInserts = 0;
  mockState.lastInsertPayload = null;
  mockState.lastUpdatePayload = null;
  mockState.productsUpdates.length = 0;
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ data: null, error: { message: 'analyze-product failed' } });
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ScannerPage — no-placeholder fallback removal + distinct-unit wiring', () => {
  it('analyze-product failure → no placeholder INSERT; queue shows error status', async () => {
    // invokeMock already returns a failure by default.
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '1234567890');

    // Queue item appears
    await waitFor(() => {
      expect(screen.getAllByTestId(/^queue-item-/).length).toBeGreaterThan(0);
    });

    // No products INSERT should have been attempted
    expect(mockState.productsInserts).toBe(0);

    // Queue row should show error styling (bg-danger-subtle)
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^queue-item-/);
      const errorRow = rows.find((r) => r.className.includes('bg-danger-subtle'));
      expect(errorRow).toBeDefined();
    });
  });

  it('analyze-product failure message references Settings', async () => {
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '9999888877');

    await waitFor(() => {
      const texts = screen.getAllByText(/Create the product manually in Settings/);
      expect(texts.length).toBeGreaterThan(0);
    });
  });

  it('analyze-product success → upgrade writes is_distinct_unit_item + default_recipe_unit + net_weight_g', async () => {
    // Mock analyze-product to return a distinct-unit product (12-pack eggs)
    (invokeMock as any).mockResolvedValueOnce({
      data: {
        suggestion: {
          name: 'Large Brown Eggs',
          calories_per_serving: 70,
          protein_per_serving: 6,
          carbs_per_serving: 0,
          fat_per_serving: 5,
          servings_per_container: 12,
          default_shelf_life_days: 45,
          is_distinct_unit_item: true,
          default_recipe_unit: 'serving',
          net_weight_g: null,
        },
        source: 'ai',
        ai_degraded: false,
        matched_placeholder_id: null,
      },
      error: null,
    });

    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '4040600043');

    // Queue item appears (success or error from execute action — either way
    // the product INSERT/UPDATE was attempted)
    await waitFor(() => {
      expect(screen.getAllByTestId(/^queue-item-/).length).toBeGreaterThan(0);
    });

    // A products INSERT (new product) must have included the new fields
    await waitFor(() => {
      const insertOrUpdate = mockState.productsInserts > 0 || mockState.productsUpdates.length > 0;
      expect(insertOrUpdate).toBe(true);
    });

    // Check the payload — either insert or update should include is_distinct_unit_item
    const payload = mockState.lastInsertPayload ?? mockState.productsUpdates[0]?.patch ?? null;
    expect(payload).not.toBeNull();
    expect(payload.is_distinct_unit_item).toBe(true);
    expect(payload.default_recipe_unit).toBe('serving');
    expect(payload.net_weight_g).toBeNull();
  });
});
