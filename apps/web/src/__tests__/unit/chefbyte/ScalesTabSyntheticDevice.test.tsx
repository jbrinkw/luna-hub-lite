/**
 * H-22 / A6-01 — `ScalesTab` must NOT surface the alarming "Your Pi key was
 * deactivated" banner for the synthetic close-in-flight device.
 *
 * Background (the bug this pins):
 *   When a user closes an orphaned in-flight lot via `CloseInFlightModal`, the
 *   `close_in_flight_lot` RPC mints a throwaway audit-only device:
 *     device_name        = 'manual'
 *     import_key_hash     = 'manual_close_in_flight_<uid>'
 *     is_active           = false
 *   (migration 20260427110000:263-285). This device can never post shelf
 *   events and its "Reactivate" is a no-op (the sentinel hash is not a real
 *   SHA-256 the edge fn matches).
 *
 *   ScalesTab's devices query did `.select('*')` with no synthetic filter, and
 *   `silentRevokeDevice` fires whenever `devices.length === 1` and the sole
 *   device is inactive — so a user whose ONLY remaining device is this
 *   synthetic one saw a scary red "Pi key was deactivated" banner for a device
 *   that isn't real.
 *
 * The fix excludes `import_key_hash LIKE 'manual_close_in_flight_%'` devices
 * from BOTH the devices query AND `silentRevokeDevice`.
 *
 * Tests:
 *   A) ONLY a synthetic 'manual' device present → NO banner, and the synthetic
 *      device is not rendered in the device list. (Pre-fix: banner shows → RED.)
 *   B) ONLY a real inactive device present → banner STILL shows (guards against
 *      an over-broad filter that would suppress the legitimate alert).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-scales-synth-1';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID } }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: () => {},
}));

// Mutable per-test result sets.
const devicesResult: { rows: any[] } = { rows: [] };
const pairingsResult: { rows: any[] } = { rows: [] };
const productsResult: { rows: any[] } = { rows: [] };

vi.mock('@/shared/supabase', () => {
  const chef = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
      const tb: any = {};
      tb.select = vi.fn(() => tb);
      tb.eq = vi.fn(() => tb);
      tb.not = vi.fn(() => tb);
      // All three ScalesTab queries terminate at `.order(...)`.
      tb.order = vi.fn(() => {
        if (table === 'live_shelf_devices') {
          return Promise.resolve({ data: devicesResult.rows, error: null });
        }
        if (table === 'scale_pairings') {
          return Promise.resolve({ data: pairingsResult.rows, error: null });
        }
        if (table === 'products') {
          return Promise.resolve({ data: productsResult.rows, error: null });
        }
        throw new Error(`unexpected table ${table} in ScalesTab synthetic-device test`);
      });
      return tb;
    });
    return builder;
  };
  return {
    chefbyte: chef,
    supabase: {},
  };
});

import { ScalesTab } from '@/components/chefbyte/ScalesTab';

/* ------------------------------------------------------------------ */
/*  Device fixtures                                                    */
/* ------------------------------------------------------------------ */

function makeDevice(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    device_id: 'dev-1',
    user_id: USER_ID,
    device_name: 'Kitchen Pi',
    import_key_hash: 'a'.repeat(64), // a real-looking SHA-256
    is_active: true,
    last_heartbeat_ts: null,
    pending_review_count: 0,
    lan_ip: null,
    created_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

const SYNTHETIC_DEVICE = makeDevice({
  device_id: 'dev-synth',
  device_name: 'manual',
  import_key_hash: `manual_close_in_flight_${USER_ID}`,
  is_active: false,
});

/* ------------------------------------------------------------------ */
/*  Harness                                                            */
/* ------------------------------------------------------------------ */

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScalesTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  devicesResult.rows = [];
  pairingsResult.rows = [];
  productsResult.rows = [];
  vi.clearAllMocks();
});

describe('H-22 ScalesTab — synthetic close-in-flight device', () => {
  it('does NOT show the "Pi key deactivated" banner when the only device is the synthetic manual one', async () => {
    devicesResult.rows = [SYNTHETIC_DEVICE];

    renderTab();

    // Wait for the query to settle (device list / empty-state appears).
    await waitFor(() => {
      expect(screen.getByTestId('scales-tab')).toBeInTheDocument();
    });
    // Give the devices query a tick to resolve and re-render.
    await waitFor(() => {
      // The synthetic device must be filtered out, so the empty-state shows.
      expect(screen.queryByTestId('no-shelf-devices')).toBeInTheDocument();
    });

    // The alarming banner must NOT be present for a throwaway audit device.
    expect(screen.queryByTestId('scales-silent-revoke-banner')).not.toBeInTheDocument();
    // And the synthetic device card must not be rendered.
    expect(screen.queryByTestId('shelf-device-dev-synth')).not.toBeInTheDocument();
  });

  it('STILL shows the banner when the only device is a real inactive device', async () => {
    devicesResult.rows = [makeDevice({ device_id: 'dev-real', is_active: false, device_name: 'Real Pi' })];

    renderTab();

    // The legitimate silent-revoke alert must surface so the filter is not
    // over-broad.
    await waitFor(() => {
      expect(screen.getByTestId('scales-silent-revoke-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('scales-silent-revoke-banner').textContent).toMatch(/Real Pi/);
  });
});
