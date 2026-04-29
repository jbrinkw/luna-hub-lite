/**
 * EventViewerPage — cloud image URL fallback chain tests.
 *
 * Spec:
 *   1. Event with before_image_url + after_image_url set → cloud HTTPS URLs
 *      rendered in <img src=…>; NO LAN URL constructed.
 *   2. Event with both URLs null + LAN reachable (lanIp set) → LAN URLs rendered.
 *   3. Event with both URLs null + no lanIp → "Image not available yet" placeholder.
 *
 * We test the pure EventCard component indirectly by rendering EventViewerPage
 * with a mocked Supabase client that returns a single event row, then assert
 * on the rendered <img> src attributes and placeholder testids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EventViewerPage } from '@/pages/chefbyte/EventViewerPage';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-abc', email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/shared/AppProvider', () => ({
  useAppContext: () => ({ online: true, activeApps: ['chefbyte'] }),
}));

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: () => {},
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

// ---------- Supabase mock ----------
// We expose mutable state so each test can configure event rows + devices.
let _eventRows: any[] = [];
let _deviceRows: any[] = [];

vi.mock('@/shared/supabase', () => {
  const makeTableBuilder = (rows: () => any[]) => {
    const b: any = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.limit = vi.fn(() => b);
    b.gte = vi.fn(() => b);
    b.then = (resolve: any, reject?: any) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
    b.catch = (reject: any) => Promise.resolve({ data: rows(), error: null }).catch(reject);
    return b;
  };

  const chef = () => ({
    from: vi.fn((table: string) => {
      if (table === 'live_shelf_devices') return makeTableBuilder(() => _deviceRows);
      // event_viewer queries: shelf_event_log, products, event_overrides all return
      // _eventRows for shelf_event_log, empty arrays for the rest so only the event
      // card renders.
      if (table === 'shelf_event_log') return makeTableBuilder(() => _eventRows);
      return makeTableBuilder(() => []);
    }),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  });

  return {
    chefbyte: chef,
    supabase: { schema: () => ({ rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) }) },
  };
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const CLOUD_BEFORE = 'https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/u/e/before.jpg';
const CLOUD_AFTER = 'https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/u/e/after.jpg';
const LAN_IP = '192.168.0.181';
const PI_EVENT_ID = 'pi-event-uuid-1234';

function baseEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    event_id: 'cloud-event-1',
    client_event_id: 'client-event-1',
    pi_event_id: PI_EVENT_ID,
    applied: true,
    reason: null,
    created_at: '2026-04-29T12:00:00.000Z',
    classifier_status: null,
    classification: null,
    payload: {
      product_id: 'prod-1',
      event_kind: 'consumed',
      delta_g: -100,
      occurred_at: '2026-04-29T12:00:00.000Z',
    },
    before_image_url: null,
    after_image_url: null,
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/events']}>
        <EventViewerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  _eventRows = [];
  _deviceRows = [];
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('EventViewerPage — image URL fallback chain', () => {
  it('renders cloud HTTPS URLs when before_image_url + after_image_url are set', async () => {
    _eventRows = [
      baseEvent({
        before_image_url: CLOUD_BEFORE,
        after_image_url: CLOUD_AFTER,
      }),
    ];
    // No LAN device — cloud should still work without one
    _deviceRows = [];

    renderPage();

    await waitFor(() => {
      const beforeImg = screen.queryByTestId('event-image-before');
      expect(beforeImg).not.toBeNull();
      // Use getAttribute to get the raw src, not the jsdom-resolved href
      expect(beforeImg!.getAttribute('src')).toBe(CLOUD_BEFORE);
    });

    const afterImg = screen.getByTestId('event-image-after');
    expect(afterImg.getAttribute('src')).toBe(CLOUD_AFTER);

    // No placeholder when cloud URLs are present
    expect(screen.queryByTestId('event-image-placeholder')).toBeNull();
  });

  it('renders LAN URL fallback when cloud URLs are null and lanIp is available', async () => {
    _eventRows = [
      baseEvent({
        before_image_url: null,
        after_image_url: null,
      }),
    ];
    _deviceRows = [{ device_id: 'd1', lan_ip: LAN_IP, last_heartbeat_ts: '2026-04-29T12:00:00Z' }];

    renderPage();

    await waitFor(() => {
      const beforeImg = screen.queryByTestId('event-image-before');
      expect(beforeImg).not.toBeNull();
    });

    const beforeSrc = screen.getByTestId('event-image-before').getAttribute('src') ?? '';
    expect(beforeSrc).toContain(LAN_IP);
    expect(beforeSrc).toContain(PI_EVENT_ID);
    expect(beforeSrc).toContain('before.jpg');
    // Must NOT be a Supabase storage URL
    expect(beforeSrc).not.toContain('supabase.co');

    const afterSrc = screen.getByTestId('event-image-after').getAttribute('src') ?? '';
    expect(afterSrc).toContain('after.jpg');
  });

  it('renders placeholder when cloud URLs are null and no lanIp', async () => {
    _eventRows = [
      baseEvent({
        before_image_url: null,
        after_image_url: null,
        pi_event_id: PI_EVENT_ID,
      }),
    ];
    // No device → no lanIp
    _deviceRows = [];

    renderPage();

    await waitFor(() => {
      // Placeholder shown when no cloud URL and no LAN IP
      expect(screen.queryByTestId('event-image-placeholder')).not.toBeNull();
    });

    // No real img elements (only placeholder div)
    expect(screen.queryByTestId('event-image-before')).toBeNull();
    expect(screen.queryByTestId('event-image-after')).toBeNull();
  });

  it('does NOT attempt LAN fetch when cloud URL is populated', async () => {
    // Even if a lanIp is present, cloud URL wins and no LAN URL should appear
    _eventRows = [
      baseEvent({
        before_image_url: CLOUD_BEFORE,
        after_image_url: CLOUD_AFTER,
      }),
    ];
    _deviceRows = [{ device_id: 'd1', lan_ip: LAN_IP, last_heartbeat_ts: '2026-04-29T12:00:00Z' }];

    renderPage();

    await waitFor(() => {
      const before = screen.queryByTestId('event-image-before');
      expect(before).not.toBeNull();
      // src must be the cloud URL, NOT the LAN URL
      const src = before!.getAttribute('src') ?? '';
      expect(src).not.toContain(LAN_IP);
      expect(src).toBe(CLOUD_BEFORE);
    });
  });
});
