/**
 * Unit tests — InventoryPage view-mode toggle.
 *
 * Verifies that:
 *  1. Default view is "grouped" (grouped-view container present, lots-view absent).
 *  2. Clicking "Lots" switches to lots view (lots-view present, grouped-view absent).
 *  3. Clicking "Grouped" switches back to grouped view.
 *  4. In lot view, each stock_lots row renders as a distinct `lot-row-<id>` element.
 *  5. Two lots for the same product appear as TWO separate rows in lot view.
 *
 * Mocking strategy matches the existing InventoryBadges.test.tsx pattern:
 * Supabase transport is stubbed; the page itself is rendered via React Testing
 * Library so the JSX path is exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-toggle-1';

/* ------------------------------------------------------------------ */
/*  Seed data — same product, TWO distinct lots (different expiry)     */
/* ------------------------------------------------------------------ */
const PRODUCTS = [
  {
    product_id: 'prod-milk',
    user_id: USER_ID,
    name: 'Whole Milk',
    barcode: null,
    servings_per_container: 8,
    min_stock_amount: 1,
    tare_weight_g: null,
    certified: false,
  },
  {
    product_id: 'prod-eggs',
    user_id: USER_ID,
    name: 'Large Eggs',
    barcode: null,
    servings_per_container: 12,
    min_stock_amount: 0,
    tare_weight_g: null,
    certified: false,
  },
];

// Two separate lots for milk (different expiry dates) — this is the
// exact scenario the user reported: "2 milk ctn but only 1 row for milk".
// In lot view each must render as its own distinct row.
const LOTS = [
  {
    lot_id: 'lot-milk-a',
    product_id: 'prod-milk',
    qty_containers: 1,
    expires_on: '2026-05-10',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    last_observed_weight_g: null,
    last_observed_at: null,
    locations: { name: 'Fridge' },
    products: { name: 'Whole Milk', servings_per_container: 8 },
  },
  {
    lot_id: 'lot-milk-b',
    product_id: 'prod-milk',
    qty_containers: 1,
    expires_on: '2026-05-17',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    last_observed_weight_g: null,
    last_observed_at: null,
    locations: { name: 'Fridge' },
    products: { name: 'Whole Milk', servings_per_container: 8 },
  },
  {
    lot_id: 'lot-eggs-a',
    product_id: 'prod-eggs',
    qty_containers: 0.5,
    expires_on: '2026-06-01',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    last_observed_weight_g: null,
    last_observed_at: null,
    locations: { name: 'Fridge' },
    products: { name: 'Large Eggs', servings_per_container: 12 },
  },
];

/* ------------------------------------------------------------------ */
/*  Supabase stub (mirrors InventoryBadges.test.tsx pattern)           */
/* ------------------------------------------------------------------ */
vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
      const b: any = {};
      const state: { mode: 'select' | 'update' | 'insert' } = { mode: 'select' };
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.not = vi.fn(() => b);
      b.ilike = vi.fn(() => b);
      b.gt = vi.fn(() => b);
      b.lt = vi.fn(() => b);
      b.update = vi.fn(() => {
        state.mode = 'update';
        return b;
      });
      b.insert = vi.fn(() => {
        state.mode = 'insert';
        return b;
      });
      b.limit = vi.fn(() => {
        if (table === 'locations') {
          return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.order = vi.fn(() => {
        if (table === 'products' && state.mode === 'select') {
          return Promise.resolve({ data: PRODUCTS, error: null });
        }
        if (table === 'locations' && state.mode === 'select') {
          return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.then = (resolve: (v: any) => void) => {
        if (table === 'stock_lots' && state.mode === 'select') {
          resolve({ data: LOTS, error: null });
          return;
        }
        if (table === 'products' && state.mode === 'select') {
          resolve({ data: PRODUCTS, error: null });
          return;
        }
        if (table === 'scale_pairings' && state.mode === 'select') {
          resolve({ data: [], error: null });
          return;
        }
        if (table === 'live_shelf_devices' && state.mode === 'select') {
          resolve({ data: [], error: null });
          return;
        }
        resolve({ data: [], error: null });
      };
      return b;
    });
    builder.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return builder;
  };
  return {
    supabase: {
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn((cb?: (status: string) => void) => {
          setTimeout(() => cb?.('SUBSCRIBED'), 0);
          return { unsubscribe: vi.fn() };
        }),
        unsubscribe: vi.fn(),
      })),
      removeChannel: vi.fn(),
      realtime: {
        stateChangeCallbacks: { close: [] },
        connect: vi.fn(),
      },
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: USER_ID, email: 'test@test.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn(),
}));

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

import { InventoryPage } from '@/pages/chefbyte/InventoryPage';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/inventory']}>
        <InventoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('InventoryPage — view-mode toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('default view is grouped: grouped-view present, lots-view absent', async () => {
    renderPage();
    await screen.findByTestId('inventory-view-toggle');

    expect(screen.getByTestId('grouped-view')).toBeInTheDocument();
    expect(screen.queryByTestId('lots-view')).toBeNull();
  });

  it('clicking Lots switches to lots view; grouped view is absent', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');

    await user.click(screen.getByRole('button', { name: 'Lots' }));

    await waitFor(() => {
      expect(screen.getByTestId('lots-view')).toBeInTheDocument();
      expect(screen.queryByTestId('grouped-view')).toBeNull();
    });
  });

  it('clicking Grouped from lots view returns to grouped view', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');

    await user.click(screen.getByRole('button', { name: 'Lots' }));
    await waitFor(() => expect(screen.getByTestId('lots-view')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    await waitFor(() => {
      expect(screen.getByTestId('grouped-view')).toBeInTheDocument();
      expect(screen.queryByTestId('lots-view')).toBeNull();
    });
  });

  it('lot view renders one row per stock_lots row (3 lots → 3 rows)', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');

    await user.click(screen.getByRole('button', { name: 'Lots' }));
    await waitFor(() => expect(screen.getByTestId('lots-view')).toBeInTheDocument());

    // Three distinct lots in the seed — each must produce its own row.
    // Both mobile card list and desktop table render lot-row-<id>, so
    // getAllByTestId returns 2 elements per lot (one per layout). At least
    // one element must be present for each lot_id.
    expect(screen.getAllByTestId('lot-row-lot-milk-a').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('lot-row-lot-milk-b').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('lot-row-lot-eggs-a').length).toBeGreaterThanOrEqual(1);
  });

  it('two lots for the same product produce two separate rows in lot view', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');

    await user.click(screen.getByRole('button', { name: 'Lots' }));
    await waitFor(() => expect(screen.getByTestId('lots-view')).toBeInTheDocument());

    // Both milk lots must appear individually — this is the user's reported bug:
    // "2 milk ctn but only 1 row for milk." The lot view must NOT collapse them.
    // (Both mobile card and desktop table render each lot-row, so ≥1 per ID.)
    expect(screen.getAllByTestId('lot-row-lot-milk-a').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId('lot-row-lot-milk-b').length).toBeGreaterThanOrEqual(1);

    // The two lots render as distinct testid groups — lot-milk-a and lot-milk-b
    // are independent, not merged into one element.
    const rowsA = screen.getAllByTestId('lot-row-lot-milk-a');
    const rowsB = screen.getAllByTestId('lot-row-lot-milk-b');
    // No element of rowsA is the same DOM node as any element of rowsB.
    for (const a of rowsA) {
      for (const b of rowsB) {
        expect(a).not.toBe(b);
      }
    }
  });

  it('grouped view collapses same-product lots into one product row', async () => {
    renderPage();
    // Default is grouped — wait for load.
    await waitFor(() => expect(screen.getByTestId('grouped-view')).toBeInTheDocument());

    // Only one product row per unique product_id in grouped view.
    expect(screen.getByTestId('inv-product-prod-milk')).toBeInTheDocument();
    expect(screen.getByTestId('inv-product-prod-eggs')).toBeInTheDocument();

    // There are no lot-row elements in grouped view.
    expect(screen.queryByTestId('lot-row-lot-milk-a')).toBeNull();
    expect(screen.queryByTestId('lot-row-lot-milk-b')).toBeNull();
  });
});
