// @vitest-environment jsdom
/**
 * Integration tests — InventoryPage lot-view per-row rendering.
 *
 * Uses mocked Supabase (like unit tests) but lives under integration/pages
 * to follow the brief's placement requirement. The @vitest-environment jsdom
 * annotation overrides the integration config's default node environment so
 * React Testing Library can render components.
 *
 * Unlike the unit test (which uses a mocked Supabase transport),
 * this file mirrors the pattern of the existing chef-inventory.test.ts:
 * it mocks Supabase via a stub but exercises the full
 * InventoryPage render including toggle, sortedLots derivation,
 * and the lot-row format (qty + servings, lot_id truncated, [MEAL] badge).
 *
 * Tests assert:
 *   1. Each stock_lots row → one distinct lot-row element.
 *   2. Qty display shows "<X> ctn (<Y> svg)" format.
 *   3. Truncated lot_id shown as "#<first-8-chars>".
 *   4. [MEAL] sentinel lots render a [MEAL] badge.
 *   5. Search filter applies to lot view (non-matching lots hidden).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-lot-view-int-1';

/* ------------------------------------------------------------------ */
/*  Seed data                                                           */
/* ------------------------------------------------------------------ */
const PRODUCTS = [
  {
    product_id: 'prod-chicken',
    user_id: USER_ID,
    name: 'Chicken Breast',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 2,
    tare_weight_g: null,
    certified: false,
  },
  {
    product_id: 'prod-rice',
    user_id: USER_ID,
    name: 'Brown Rice',
    barcode: null,
    servings_per_container: 8,
    min_stock_amount: 1,
    tare_weight_g: null,
    certified: false,
  },
];

// Two chicken lots + one rice lot + one [MEAL] sentinel lot.
const LOT_ID_CHICKEN_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOT_ID_CHICKEN_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const LOT_ID_RICE = 'cccccccc-dddd-eeee-ffff-000000000000';
const LOT_ID_MEAL = 'dddddddd-eeee-ffff-0000-111111111111';

const LOTS = [
  {
    lot_id: LOT_ID_CHICKEN_A,
    product_id: 'prod-chicken',
    qty_containers: 2,
    expires_on: '2026-05-15',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    last_observed_weight_g: null,
    last_observed_at: null,
    locations: { name: 'Freezer' },
    // servings = 2 * 4 = 8.0 svg
    products: { name: 'Chicken Breast', servings_per_container: 4 },
  },
  {
    lot_id: LOT_ID_CHICKEN_B,
    product_id: 'prod-chicken',
    qty_containers: 1,
    expires_on: '2026-05-20',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    last_observed_weight_g: null,
    last_observed_at: null,
    locations: { name: 'Freezer' },
    // servings = 1 * 4 = 4.0 svg
    products: { name: 'Chicken Breast', servings_per_container: 4 },
  },
  {
    lot_id: LOT_ID_RICE,
    product_id: 'prod-rice',
    qty_containers: 0.5,
    expires_on: '2026-12-31',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    last_observed_weight_g: null,
    last_observed_at: null,
    locations: { name: 'Pantry' },
    // servings = 0.5 * 8 = 4.0 svg
    products: { name: 'Brown Rice', servings_per_container: 8 },
  },
  {
    // [MEAL] sentinel — product excluded from grouped view but shown in lot view
    lot_id: LOT_ID_MEAL,
    product_id: 'prod-meal-sentinel',
    qty_containers: 3,
    expires_on: null,
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    last_observed_weight_g: null,
    last_observed_at: null,
    locations: { name: 'Pantry' },
    products: { name: '[MEAL] Chicken & Rice', servings_per_container: 1 },
  },
];

/* ------------------------------------------------------------------ */
/*  Supabase stub                                                       */
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
          // useChefbyteProducts returns only non-[MEAL] products
          return Promise.resolve({ data: PRODUCTS, error: null });
        }
        if (table === 'locations' && state.mode === 'select') {
          return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.then = (resolve: (v: any) => void) => {
        if (table === 'stock_lots' && state.mode === 'select') {
          // Raw lots query includes ALL lots (including [MEAL] sentinel)
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

/** Switch to lot view and wait for it to render */
async function switchToLotView(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Lots' }));
  await waitFor(() => expect(screen.getByTestId('lots-view')).toBeInTheDocument());
}

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

describe('InventoryPage — lot-view per-row rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // NOTE: The lot view renders each lot in both a mobile card list and a
  // desktop table (one hidden via CSS). Both nodes share the same data-testid,
  // so we use getAllByTestId(...)[0] or queryAllByTestId to avoid the
  // "multiple elements" error from getByTestId.

  it('each stock_lots row appears as a distinct lot-row element', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    // Each lot must produce at least one lot-row element (mobile or desktop).
    expect(screen.getAllByTestId(`lot-row-${LOT_ID_CHICKEN_A}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId(`lot-row-${LOT_ID_CHICKEN_B}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId(`lot-row-${LOT_ID_RICE}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId(`lot-row-${LOT_ID_MEAL}`).length).toBeGreaterThanOrEqual(1);
  });

  it('two chicken lots render as two separate rows (not collapsed)', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    // Both chicken lots must be present — they must not be merged.
    const rowsA = screen.getAllByTestId(`lot-row-${LOT_ID_CHICKEN_A}`);
    const rowsB = screen.getAllByTestId(`lot-row-${LOT_ID_CHICKEN_B}`);
    expect(rowsA.length).toBeGreaterThanOrEqual(1);
    expect(rowsB.length).toBeGreaterThanOrEqual(1);
    // No node is shared between the two groups — they're distinct lot rows.
    for (const a of rowsA) {
      for (const b of rowsB) {
        expect(a).not.toBe(b);
      }
    }
  });

  it('qty display shows "<ctn> ctn (<svg> svg)" format', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    // Use the first rendered qty element (mobile card list).
    // Chicken lot A: 2 ctn × 4 svg/ctn = 8 svg
    const qtyA = screen.getAllByTestId(`lot-qty-${LOT_ID_CHICKEN_A}`)[0];
    expect(qtyA.textContent).toContain('2.0 ctn');
    expect(qtyA.textContent).toContain('8.0 svg');

    // Chicken lot B: 1 ctn × 4 = 4 svg
    const qtyB = screen.getAllByTestId(`lot-qty-${LOT_ID_CHICKEN_B}`)[0];
    expect(qtyB.textContent).toContain('1.0 ctn');
    expect(qtyB.textContent).toContain('4.0 svg');

    // Rice lot: 0.5 ctn × 8 = 4 svg
    const qtyRice = screen.getAllByTestId(`lot-qty-${LOT_ID_RICE}`)[0];
    expect(qtyRice.textContent).toContain('0.5 ctn');
    expect(qtyRice.textContent).toContain('4.0 svg');
  });

  it('truncated lot_id shown as "#<first-8-chars>"', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    // Use the first lot-id-short element (mobile card renders first in DOM).
    const shortIdEls = screen.getAllByTestId(`lot-id-short-${LOT_ID_CHICKEN_A}`);
    expect(shortIdEls.length).toBeGreaterThanOrEqual(1);
    const shortIdEl = shortIdEls[0];
    // First 8 chars of LOT_ID_CHICKEN_A = 'aaaaaaaa'
    expect(shortIdEl.textContent).toContain('aaaaaaaa');
    // title attribute carries the full UUID for hover
    expect(shortIdEl).toHaveAttribute('title', LOT_ID_CHICKEN_A);
  });

  it('[MEAL] sentinel lot renders a [MEAL] badge', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    // The [MEAL] badge renders once per layout (mobile card + desktop table),
    // so getAllByTestId is correct. At least one must be present.
    const mealBadges = screen.getAllByTestId(`lot-meal-badge-${LOT_ID_MEAL}`);
    expect(mealBadges.length).toBeGreaterThanOrEqual(1);
    expect(mealBadges[0].textContent).toBe('[MEAL]');
  });

  it('non-[MEAL] lots do NOT show a [MEAL] badge', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    expect(screen.queryByTestId(`lot-meal-badge-${LOT_ID_CHICKEN_A}`)).toBeNull();
    expect(screen.queryByTestId(`lot-meal-badge-${LOT_ID_RICE}`)).toBeNull();
  });

  it('search filter in lot view hides non-matching lots', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    // Type "rice" in the search box
    const searchInput = screen.getByTestId('inventory-search');
    await user.type(searchInput, 'rice');

    await waitFor(() => {
      // Rice lot stays — at least one DOM element per layout.
      expect(screen.getAllByTestId(`lot-row-${LOT_ID_RICE}`).length).toBeGreaterThanOrEqual(1);
      // Chicken lots are hidden — zero elements.
      expect(screen.queryAllByTestId(`lot-row-${LOT_ID_CHICKEN_A}`)).toHaveLength(0);
      expect(screen.queryAllByTestId(`lot-row-${LOT_ID_CHICKEN_B}`)).toHaveLength(0);
    });
  });

  it('clearing search in lot view restores all lots', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByTestId('inventory-view-toggle');
    await switchToLotView(user);

    const searchInput = screen.getByTestId('inventory-search');
    await user.type(searchInput, 'chicken');
    await waitFor(() => expect(screen.queryAllByTestId(`lot-row-${LOT_ID_RICE}`)).toHaveLength(0));

    await user.clear(searchInput);
    await waitFor(() => {
      expect(screen.getAllByTestId(`lot-row-${LOT_ID_CHICKEN_A}`).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId(`lot-row-${LOT_ID_CHICKEN_B}`).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId(`lot-row-${LOT_ID_RICE}`).length).toBeGreaterThanOrEqual(1);
    });
  });
});
