/**
 * LiveTrack Import Wizard — OFF-miss is not a fatal error.
 *
 * Bug history (2026-04-28):
 *   When OpenFoodFacts had no record for a barcode, the analyze-product
 *   edge function returned 404. The wizard's `handleBarcode` treated
 *   ANY edge-function error as fatal — dispatched `{type: 'error'}`,
 *   showing the "Start over" prompt. The user could not proceed even
 *   though "OFF doesn't know this barcode" is a NORMAL case (store-brand
 *   items, regional products, recently launched SKUs).
 *
 * The fix:
 *   `handleBarcode` distinguishes the OFF-miss case (efStatus === 404 OR
 *   error message matches /not found in openfoodfacts/i) from real
 *   failures. On OFF-miss it falls through to the product-insert path
 *   (using barcode-stub name + zero macros) and the dispatch carries
 *   `offMiss:true` so the editor renders a neutral hint instead of
 *   looking like a successful prefill.
 *
 * What this test pins:
 *   1. After a 404 from analyze-product, the wizard does NOT enter the
 *      `error` state ("Start over" not shown).
 *   2. The editable form renders with empty fields the user can fill in.
 *   3. A neutral "No OpenFoodFacts data" notice is surfaced.
 *
 * Mutation guard:
 *   Reverting `handleBarcode` to dispatch `{type:'error'}` for every
 *   `efError` (the pre-fix behavior) makes the wizard show
 *   `livetrack-error` instead of `livetrack-product-loaded` — the first
 *   assertion fails. Removing the OFF-miss notice surface makes the
 *   third assertion fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-livetrack-offmiss';
const BARCODE_NEW_PRODUCT = '999999999999';

/* ------------------------------------------------------------------ */
/*  Supabase mock                                                       */
/* ------------------------------------------------------------------ */

// Capture-able mock for analyze-product. Each test rewires this to drive
// the OFF-miss path / happy path / hard-error path without touching the
// rest of the chefbyte mock.
const invokeMock = vi.fn();

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((_table: string) => {
      const b: any = {};
      const state: { mode: 'select' | 'update' | 'insert' } = { mode: 'select' };
      // Build a thenable terminal — the wizard chains
      // `.update(...).eq(...).then(...)` for the unmount-close flow,
      // so .eq() must be Promise-compatible after .update().
      function makeThenable(): any {
        const t: any = {};
        t.eq = vi.fn(() => t);
        t.then = (resolve: any) => {
          resolve({ data: null, error: null });
          return Promise.resolve({ data: null, error: null });
        };
        return t;
      }
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.not = vi.fn(() => b);
      b.gt = vi.fn(() => b);
      b.lt = vi.fn(() => b);
      b.order = vi.fn(() => {
        if (_table === 'locations') {
          return Promise.resolve({ data: [{ location_id: 'loc-default' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.limit = vi.fn(() => {
        if (_table === 'locations') {
          return Promise.resolve({ data: [{ location_id: 'loc-default' }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });
      b.update = vi.fn(() => {
        state.mode = 'update';
        return makeThenable();
      });
      b.insert = vi.fn((row: any) => {
        state.mode = 'insert';
        // Synthesize a created product row from the insert payload.
        const created = {
          product_id: 'prod-newly-created',
          ...row,
        };
        return {
          select: () => ({ single: () => Promise.resolve({ data: created, error: null }) }),
        };
      });
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.then = (resolve: (v: any) => void) => {
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
      realtime: { stateChangeCallbacks: { close: [] }, connect: vi.fn() },
      functions: {
        invoke: (...args: unknown[]) => invokeMock(...args),
      },
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

/* ------------------------------------------------------------------ */
/*  Other shared mocks                                                  */
/* ------------------------------------------------------------------ */

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

vi.mock('@/hooks/useScannerDetection', () => ({
  useScannerDetection: vi.fn(),
}));

// Stub session helpers so the wizard skips network for /create + /load
// and goes straight to waiting_barcode with a fresh device.
vi.mock('@/pages/chefbyte/livetrackSession', async () => {
  const actual: any = await vi.importActual('@/pages/chefbyte/livetrackSession');
  return {
    ...actual,
    loadFreshLiveShelfDevice: vi.fn(async () => ({
      device_id: 'dev-1',
      device_name: 'kitchen-pi',
      // Heartbeat ts in the future would have produced "-1s ago" pre-fix —
      // include this in a separate test below for the heartbeat clamp.
      last_heartbeat_ts: new Date().toISOString(),
      is_active: true,
    })),
    isDeviceFresh: () => true,
    createLiveTrackSession: vi.fn(async () => ({
      session_id: 'sess-1',
      user_id: USER_ID,
      device_id: 'dev-1',
      scale_id: 'scale-02',
      state: 'waiting_barcode' as const,
      current_barcode: null,
      current_product_id: null,
      scale_reading_g: null,
      scale_reading_ts: null,
      ai_tare_product_form: null,
      ai_tare_g: null,
      ai_tare_confidence: null,
      ai_tare_reasoning: null,
      last_error: null,
      created_at: '2026-04-28T12:00:00.000Z',
      updated_at: '2026-04-28T12:00:00.000Z',
      expires_at: '2026-04-28T12:10:00.000Z',
    })),
    loadLiveTrackSession: vi.fn(async () => null),
    patchLiveTrackSession: vi.fn(async () => ({
      session_id: 'sess-1',
      user_id: USER_ID,
      device_id: 'dev-1',
      scale_id: 'scale-02',
      state: 'waiting_scale' as const,
      current_barcode: BARCODE_NEW_PRODUCT,
      current_product_id: 'prod-newly-created',
      scale_reading_g: null,
      scale_reading_ts: null,
      ai_tare_product_form: null,
      ai_tare_g: null,
      ai_tare_confidence: null,
      ai_tare_reasoning: null,
      last_error: null,
      created_at: '2026-04-28T12:00:00.000Z',
      updated_at: '2026-04-28T12:00:00.000Z',
      expires_at: '2026-04-28T12:10:00.000Z',
    })),
  };
});

import { LiveTrackImportPage } from '@/pages/chefbyte/LiveTrackImportPage';

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/livetrack-import']}>
        <LiveTrackImportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Type a barcode + press Enter in the wizard's barcode input.
 */
async function typeBarcode(user: ReturnType<typeof userEvent.setup>, barcode: string) {
  const input = await screen.findByTestId('livetrack-barcode-input');
  await user.click(input);
  await user.type(input, `${barcode}{Enter}`);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('LiveTrackImportPage — OFF-miss is a NORMAL case, not a fatal error', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('404 from analyze-product surfaces the editable form (NOT the error / Start over panel)', async () => {
    // Wire the edge function to return the OFF-miss 404 shape that the
    // real analyze-product produces (jsonResponse({error: 'Product not
    // found in OpenFoodFacts'}, 404)).
    //
    // supabase-js wraps non-2xx as FunctionsHttpError with a `context`
    // object that exposes `status` + an async `json()` body reader.
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: 'FunctionsHttpError',
        context: {
          status: 404,
          json: async () => ({ error: 'Product not found in OpenFoodFacts' }),
        },
      },
    });

    const user = userEvent.setup();
    renderPage();

    // Wait for the wizard to settle into waiting_barcode (auto-create
    // session fires on mount with the fresh device mock).
    await screen.findByTestId('livetrack-waiting-barcode');

    await act(async () => {
      await typeBarcode(user, BARCODE_NEW_PRODUCT);
    });

    // 1. The wizard MUST land on `livetrack-product-loaded`, not
    //    `livetrack-error`. Pre-fix, the 404 dispatched
    //    `{type: 'error'}` and rendered the red "Start over" panel.
    await waitFor(() => {
      expect(screen.queryByTestId('livetrack-error')).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId('livetrack-product-loaded')).toBeInTheDocument();

    // 2. The "Start over" button is the error panel's affordance. Its
    //    absence is the negative control for the regression.
    expect(screen.queryByTestId('livetrack-error-reset')).not.toBeInTheDocument();

    // 3. The OFF-miss neutral notice is surfaced.
    const notice = await screen.findByTestId('livetrack-off-miss-notice');
    expect(notice.textContent).toMatch(/no openfoodfacts data/i);

    // 4. All product fields are visible AND empty (so the user can type).
    //    The fields exist because they were always rendered; the
    //    OFF-miss-specific guarantee is that they start blank instead of
    //    inheriting OFF prefill garbage.
    const nameInput = screen.getByTestId('livetrack-field-name') as HTMLInputElement;
    expect(nameInput).toBeInTheDocument();
    expect(nameInput.value).toBe('');

    const fields = ['srvctn', 'calories', 'carbs', 'fat', 'protein', 'servingwtg', 'netwtg', 'tarewtg'];
    for (const f of fields) {
      const el = screen.getByTestId(`livetrack-field-${f}`) as HTMLInputElement;
      expect(el).toBeInTheDocument();
      expect(el.value).toBe('');
    }
  });

  it('happy path (200 with OFF data) prefills + does NOT show the OFF-miss notice', async () => {
    // Symmetry control: when OFF actually has data, the wizard prefills
    // and skips the OFF-miss notice. A mutation that always rendered the
    // notice (or always blanked the form) would fail this test.
    invokeMock.mockResolvedValue({
      data: {
        source: 'ai',
        suggestion: {
          name: 'Real OFF Product',
          servings_per_container: 4,
          calories_per_serving: 120,
          carbs_per_serving: 15,
          fat_per_serving: 3,
          protein_per_serving: 8,
          default_shelf_life_days: 365,
        },
        ai_degraded: false,
        ai_reason: null,
        off: {
          product_name: 'Real OFF Product',
          product_quantity: 500,
          serving_size: '125 g',
          nutriments: {},
        },
      },
      error: null,
    });

    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('livetrack-waiting-barcode');

    await act(async () => {
      await typeBarcode(user, '111111111111');
    });

    await screen.findByTestId('livetrack-product-loaded');

    // No OFF-miss notice on the happy path.
    expect(screen.queryByTestId('livetrack-off-miss-notice')).not.toBeInTheDocument();

    // Name prefilled from AI suggestion (also editable — input element).
    const nameInput = screen.getByTestId('livetrack-field-name') as HTMLInputElement;
    expect(nameInput.value).toBe('Real OFF Product');
    expect(nameInput.tagName).toBe('INPUT');
    expect(nameInput.readOnly).toBe(false);
    expect(nameInput.disabled).toBe(false);

    // Macros prefilled from AI suggestion.
    expect((screen.getByTestId('livetrack-field-calories') as HTMLInputElement).value).toBe('120');
    expect((screen.getByTestId('livetrack-field-protein') as HTMLInputElement).value).toBe('8');
  });

  it('hard error (500 from analyze-product) STILL shows the error panel — only OFF-miss is graceful', async () => {
    // Negative control: a non-OFF-miss error MUST still show the error
    // panel. A mutation that broadened the OFF-miss branch to swallow
    // EVERY error would silently degrade the failure-handling UX.
    invokeMock.mockResolvedValue({
      data: null,
      error: {
        message: 'Internal server error',
        context: {
          status: 500,
          json: async () => ({ error: 'Internal server error' }),
        },
      },
    });

    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId('livetrack-waiting-barcode');

    await act(async () => {
      await typeBarcode(user, '777777777777');
    });

    // 500 stays fatal — error panel renders, product editor does NOT.
    await screen.findByTestId('livetrack-error');
    expect(screen.queryByTestId('livetrack-product-loaded')).not.toBeInTheDocument();
    expect(screen.queryByTestId('livetrack-off-miss-notice')).not.toBeInTheDocument();
  });
});

describe('LiveTrackImportPage — every product field is visible + mutable', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('after OFF prefill, all 9 product fields are still editable inputs (not read-only displays)', async () => {
    // Coverage for the "field-mutability" requirement: even when OFF
    // prefilled the values, the user must be able to edit any of them
    // without an explicit "Edit" click.
    invokeMock.mockResolvedValue({
      data: {
        source: 'ai',
        suggestion: {
          name: 'Editable After Prefill',
          servings_per_container: 2,
          calories_per_serving: 100,
          carbs_per_serving: 10,
          fat_per_serving: 5,
          protein_per_serving: 4,
          default_shelf_life_days: 90,
        },
        ai_degraded: false,
        ai_reason: null,
        off: {
          product_name: 'Editable After Prefill',
          product_quantity: 250,
          serving_size: '125 g',
          nutriments: {},
        },
      },
      error: null,
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('livetrack-waiting-barcode');
    await act(async () => {
      await typeBarcode(user, '222222222222');
    });
    await screen.findByTestId('livetrack-product-loaded');

    const fieldIds = [
      'livetrack-field-name',
      'livetrack-field-srvctn',
      'livetrack-field-calories',
      'livetrack-field-carbs',
      'livetrack-field-fat',
      'livetrack-field-protein',
      'livetrack-field-servingwtg',
      'livetrack-field-netwtg',
      'livetrack-field-tarewtg',
    ];

    for (const id of fieldIds) {
      const el = screen.getByTestId(id) as HTMLInputElement;
      expect(el, `${id} is missing`).toBeInTheDocument();
      expect(el.tagName, `${id} is not an <input>`).toBe('INPUT');
      expect(el.readOnly, `${id} is readOnly`).toBe(false);
      expect(el.disabled, `${id} is disabled`).toBe(false);
    }

    // Sanity: actually editing the name field updates its DOM value.
    const nameInput = screen.getByTestId('livetrack-field-name') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'User Override');
    expect(nameInput.value).toBe('User Override');

    // And the tare field — the regression guard for "tare was previously
    // surfaced only as read-only review text".
    const tareInput = screen.getByTestId('livetrack-field-tarewtg') as HTMLInputElement;
    await user.clear(tareInput);
    await user.type(tareInput, '42');
    expect(tareInput.value).toBe('42');
  });
});
