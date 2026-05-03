/**
 * Unit guards for the InventoryPage badge model
 * (2026-04-27 lot-level scale_pairings refactor).
 *
 * After the structural refactor, the page renders THREE INDEPENDENT
 * badges per the user spec:
 *
 *   ✓ Certified — `products.certified === true`. Per-product.
 *   ⚖ On Scale — `EXISTS scale_pairings WHERE lot_id = lot.lot_id`
 *                AND `lot.in_flight_since IS NULL`. Per-lot.
 *   ✋ In Flight — `lot.in_flight_since IS NOT NULL`. Per-lot.
 *
 * Each badge has its own predicate. None of them is allowed to bleed
 * into another:
 *
 *   - A lot whose pairing.lot_id points at it but is currently in-flight
 *     MUST NOT show On Scale (the bottle is physically elsewhere).
 *   - A non-paired lot must NEVER show On Scale, regardless of source tag.
 *   - Certified is independent of paired/in-flight; uncertified
 *     products NEVER show Certified, even if On Scale or In Flight.
 *   - In Flight is independent of paired/certified.
 *
 * The test mounts the real InventoryPage against a mocked Supabase
 * transport so the JSX path is exercised end-to-end. Pure helpers are
 * also exercised directly via ``isLotOnScale``.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-1';

/* ------------------------------------------------------------------ */
/*  Seed data — four products × distinct lot/pairing states            */
/* ------------------------------------------------------------------ */
//  prod-cert-on-scale  → certified=true  + lot paired + not in-flight
//                        → ✓ Certified + ⚖ On Scale, NO In Flight.
//  prod-cert-in-flight → certified=true  + lot paired + IN FLIGHT
//                        → ✓ Certified + ✋ In Flight, NO On Scale.
//  prod-paired-uncert  → certified=false + lot paired + not in-flight
//                        → ⚖ On Scale, NO Certified, NO In Flight.
//  prod-uncert-bare    → certified=false + NOT paired + not in-flight
//                        → no badges at all (the negative-control case).

const PRODUCTS = [
  {
    product_id: 'prod-cert-on-scale',
    user_id: USER_ID,
    name: 'Certified On-Scale Product',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: 25,
    certified: true,
  },
  {
    product_id: 'prod-cert-in-flight',
    user_id: USER_ID,
    name: 'Certified In-Flight Product',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: 25,
    certified: true,
  },
  {
    product_id: 'prod-paired-uncert',
    user_id: USER_ID,
    name: 'Paired Uncertified Product',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: null,
    certified: false,
  },
  {
    product_id: 'prod-uncert-bare',
    user_id: USER_ID,
    name: 'Bare Uncertified Product',
    barcode: null,
    servings_per_container: 4,
    min_stock_amount: 0,
    tare_weight_g: null,
    certified: false,
  },
];

const LOTS = [
  {
    lot_id: 'lot-cert-on-scale',
    product_id: 'prod-cert-on-scale',
    qty_containers: 1,
    expires_on: '2026-06-01',
    last_update_source: 'live_scale' as const,
    last_update_ts: '2026-04-27T10:00:00.000Z',
    in_flight_since: null,
    locations: { name: 'Counter' },
  },
  {
    lot_id: 'lot-cert-in-flight',
    product_id: 'prod-cert-in-flight',
    qty_containers: 0,
    expires_on: '2026-06-01',
    last_update_source: 'live_scale' as const,
    last_update_ts: '2026-04-27T10:00:00.000Z',
    in_flight_since: '2026-04-27T10:05:00.000Z',
    locations: { name: 'Counter' },
  },
  {
    lot_id: 'lot-paired-uncert',
    product_id: 'prod-paired-uncert',
    qty_containers: 2,
    expires_on: '2026-07-01',
    last_update_source: 'live_scale' as const,
    last_update_ts: '2026-04-27T10:00:00.000Z',
    in_flight_since: null,
    locations: { name: 'Counter' },
  },
  {
    lot_id: 'lot-uncert-bare',
    product_id: 'prod-uncert-bare',
    qty_containers: 1,
    expires_on: '2026-08-01',
    last_update_source: 'manual' as const,
    last_update_ts: null,
    in_flight_since: null,
    locations: { name: 'Pantry' },
  },
];

// scale_pairings rows pin lot_id explicitly — three of the four products
// have a pairing; ``prod-uncert-bare`` does NOT (negative control).
const PAIRINGS = [
  { product_id: 'prod-cert-on-scale', lot_id: 'lot-cert-on-scale', kind: 'live_scale' },
  { product_id: 'prod-cert-in-flight', lot_id: 'lot-cert-in-flight', kind: 'live_scale' },
  { product_id: 'prod-paired-uncert', lot_id: 'lot-paired-uncert', kind: 'live_scale' },
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
          return Promise.resolve({ data: PRODUCTS, error: null });
        }
        if (table === 'locations' && state.mode === 'select') {
          return Promise.resolve({ data: [{ location_id: 'loc-1' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      // Make the builder thenable so a raw `await chefbyte().from(...)
      // .select(...).eq(...)` (no trailing .order/.limit) resolves.
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
          resolve({ data: PAIRINGS, error: null });
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

import { InventoryPage, isLotOnScale } from '@/pages/chefbyte/InventoryPage';

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

describe('InventoryPage — three-badge model (Certified / On Scale / In Flight)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isLotOnScale (pure)', () => {
    it('true when lot.lot_id is in pairedLotIds AND in_flight_since is null', () => {
      const paired = new Set(['lot-A']);
      expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null }, paired)).toBe(true);
    });

    it('false when lot.lot_id is in pairedLotIds BUT in_flight_since is set', () => {
      // The bottle is physically off the shelf; "On Scale" must NOT bleed
      // into "In Flight". This is the load-bearing independence guard.
      const paired = new Set(['lot-A']);
      expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: '2026-04-27T10:00:00Z' }, paired)).toBe(false);
    });

    it('false when lot.lot_id is NOT in pairedLotIds, regardless of in_flight state', () => {
      const paired = new Set(['lot-A']);
      expect(isLotOnScale({ lot_id: 'lot-other', in_flight_since: null }, paired)).toBe(false);
      expect(isLotOnScale({ lot_id: 'lot-other', in_flight_since: '2026-04-27T10:00:00Z' }, paired)).toBe(false);
    });

    it('false on an empty pairedLotIds set (no pairings at all)', () => {
      expect(isLotOnScale({ lot_id: 'lot-A', in_flight_since: null }, new Set())).toBe(false);
    });
  });

  describe('grouped view — per-product badges', () => {
    it('certified + on-scale product: shows Certified + On Scale, NO In Flight', async () => {
      renderPage();
      await screen.findByTestId('inv-product-prod-cert-on-scale');

      expect(screen.getByTestId('livetrack-tag-prod-cert-on-scale')).toBeInTheDocument();
      expect(screen.getByTestId('on-scale-badge-prod-cert-on-scale')).toBeInTheDocument();
      // The product row should NOT carry an inflight-badge in its subtree.
      const row = screen.getByTestId('inv-product-prod-cert-on-scale');
      expect(within(row).queryByTestId('inflight-badge')).toBeNull();
    });

    it('certified + in-flight product: shows Certified + In Flight, NO On Scale', async () => {
      // The in-flight independence guard: when the paired bottle is off
      // the shelf, On Scale must drop out — the lot is physically
      // somewhere else. This is THE load-bearing test for the badge
      // refactor.
      renderPage();
      await screen.findByTestId('inv-product-prod-cert-in-flight');

      const row = screen.getByTestId('inv-product-prod-cert-in-flight');
      expect(within(row).getByTestId('livetrack-tag-prod-cert-in-flight')).toBeInTheDocument();
      expect(within(row).getByTestId('inflight-badge')).toBeInTheDocument();
      expect(within(row).queryByTestId('on-scale-badge-prod-cert-in-flight')).toBeNull();
    });

    it('uncertified + paired product: shows On Scale, NO Certified, NO In Flight', async () => {
      renderPage();
      await screen.findByTestId('inv-product-prod-paired-uncert');

      const row = screen.getByTestId('inv-product-prod-paired-uncert');
      expect(within(row).getByTestId('on-scale-badge-prod-paired-uncert')).toBeInTheDocument();
      expect(within(row).queryByTestId('livetrack-tag-prod-paired-uncert')).toBeNull();
      expect(within(row).queryByTestId('inflight-badge')).toBeNull();
    });

    it('uncertified + unpaired product (negative control): shows none of the three badges', async () => {
      renderPage();
      await screen.findByTestId('inv-product-prod-uncert-bare');

      const row = screen.getByTestId('inv-product-prod-uncert-bare');
      expect(within(row).queryByTestId('livetrack-tag-prod-uncert-bare')).toBeNull();
      expect(within(row).queryByTestId('on-scale-badge-prod-uncert-bare')).toBeNull();
      expect(within(row).queryByTestId('inflight-badge')).toBeNull();
    });
  });

  describe('lots view — per-lot badges', () => {
    it('lot-cert-on-scale: shows Certified + On Scale, NO In Flight', async () => {
      renderPage();
      const user = userEvent.setup();
      await screen.findByTestId('inv-product-prod-cert-on-scale');
      await user.click(within(screen.getByTestId('inventory-view-toggle')).getByRole('button', { name: /lots/i }));

      const rows = await screen.findAllByTestId('lot-row-lot-cert-on-scale');
      // jsdom renders both mobile + desktop layouts; assert the badges
      // are present in at least one of them.
      const certBadges = screen.getAllByTestId('lot-livetrack-tag-lot-cert-on-scale');
      const onScaleBadges = screen.getAllByTestId('lot-on-scale-badge-lot-cert-on-scale');
      expect(certBadges.length).toBeGreaterThan(0);
      expect(onScaleBadges.length).toBeGreaterThan(0);
      expect(rows.length).toBeGreaterThan(0);
      expect(screen.queryAllByTestId('lot-inflight-badge-lot-cert-on-scale').length).toBe(0);
    });

    it('lot-cert-in-flight: shows Certified + In Flight, NO On Scale', async () => {
      // Per-lot precision: the load-bearing test that an in-flight
      // paired lot does NOT show On Scale. If a regression flips the
      // predicate to "paired alone" this fails immediately.
      renderPage();
      const user = userEvent.setup();
      await screen.findByTestId('inv-product-prod-cert-in-flight');
      await user.click(within(screen.getByTestId('inventory-view-toggle')).getByRole('button', { name: /lots/i }));

      await screen.findAllByTestId('lot-row-lot-cert-in-flight');
      expect(screen.getAllByTestId('lot-livetrack-tag-lot-cert-in-flight').length).toBeGreaterThan(0);
      expect(screen.getAllByTestId('lot-inflight-badge-lot-cert-in-flight').length).toBeGreaterThan(0);
      expect(screen.queryAllByTestId('lot-on-scale-badge-lot-cert-in-flight').length).toBe(0);
    });

    it('lot-paired-uncert: shows On Scale, NO Certified, NO In Flight', async () => {
      renderPage();
      const user = userEvent.setup();
      await screen.findByTestId('inv-product-prod-paired-uncert');
      await user.click(within(screen.getByTestId('inventory-view-toggle')).getByRole('button', { name: /lots/i }));

      await screen.findAllByTestId('lot-row-lot-paired-uncert');
      expect(screen.getAllByTestId('lot-on-scale-badge-lot-paired-uncert').length).toBeGreaterThan(0);
      expect(screen.queryAllByTestId('lot-livetrack-tag-lot-paired-uncert').length).toBe(0);
      expect(screen.queryAllByTestId('lot-inflight-badge-lot-paired-uncert').length).toBe(0);
    });

    it('lot-uncert-bare: no badges at all (negative control)', async () => {
      renderPage();
      const user = userEvent.setup();
      await screen.findByTestId('inv-product-prod-uncert-bare');
      await user.click(within(screen.getByTestId('inventory-view-toggle')).getByRole('button', { name: /lots/i }));

      await screen.findAllByTestId('lot-row-lot-uncert-bare');
      expect(screen.queryAllByTestId('lot-on-scale-badge-lot-uncert-bare').length).toBe(0);
      expect(screen.queryAllByTestId('lot-livetrack-tag-lot-uncert-bare').length).toBe(0);
      expect(screen.queryAllByTestId('lot-inflight-badge-lot-uncert-bare').length).toBe(0);
    });
  });
});
