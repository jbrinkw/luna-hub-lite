/**
 * ReviewsPage tests (sync-audit finding #5 cloud mirror).
 *
 * CB-WEB-HIGH-3: Fixed drain-as-apply on "Accept removes row" test.
 * The previous test emptied fromSelectResults.rows after the initial render
 * so the post-mutation refetch returned [] — proving nothing about optimistic
 * logic. The new test uses a controlled RPC promise that blocks; it asserts
 * the row is gone from the DOM BEFORE the RPC resolves (true optimistic
 * remove via onMutate → queryClient.setQueryData filter). A rejection path
 * test is also added to verify onError restores the row.
 *
 * Covers:
 *  - Renders the pending review list returned from chefbyte.review_queue.
 *  - Accept button fires resolve_review RPC with status=resolved.
 *  - Reject button fires resolve_review RPC with status=dismissed.
 *  - Optimistic UI: clicking Accept removes the row from the list BEFORE
 *    the RPC resolves (true optimistic, not drain-as-apply).
 *  - Rollback: if the RPC rejects, the row reappears.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReviewsPage, buildPiImageUrl } from '@/pages/chefbyte/ReviewsPage';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 't@t.com' },
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

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const fromSelectResults: { rows: any[]; error: null | Error } = { rows: [], error: null };
const devicesResults: { rows: any[]; error: null | Error } = { rows: [], error: null };

/* CB-WEB-HIGH-3: per-test RPC control gate.
 * When rpcGate is set, the next resolve_review call blocks until
 * rpcGate.resolve() or rpcGate.reject() is called from the test. */
let rpcGate: { resolve: () => void; reject: (e: Error) => void } | null = null;

vi.mock('@/shared/supabase', () => {
  const chef = () => {
    const builder: any = {};
    // The from() factory returns a different terminal handler depending
    // on the table being queried. ``review_queue`` chains
    // ``.select().eq().eq().order()`` and resolves with fromSelectResults.
    // ``live_shelf_devices`` chains ``.select().eq()`` and resolves with
    // devicesResults — there's no .order() in the device query, so the
    // .eq() call is the awaited terminal step.
    builder.from = vi.fn((table: string) => {
      if (table === 'live_shelf_devices') {
        const tb: any = {};
        tb.select = vi.fn(() => tb);
        // Last .eq() in the device chain — must be awaitable.
        tb.eq = vi.fn(() =>
          Object.assign(Promise.resolve({ data: devicesResults.rows, error: devicesResults.error }), tb),
        );
        return tb;
      }
      const tb: any = {};
      tb.select = vi.fn(() => tb);
      tb.eq = vi.fn(() => tb);
      tb.order = vi.fn(() => Promise.resolve({ data: fromSelectResults.rows, error: fromSelectResults.error }));
      return tb;
    });
    builder.rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'resolve_review' && rpcGate) {
        // Block until the test releases the gate.
        return new Promise<{ data: unknown; error: null }>((res, rej) => {
          rpcGate!.resolve = () => res({ data: { review_id: args.p_review_id, status: args.p_status }, error: null });
          rpcGate!.reject = (e: Error) => rej(e);
        });
      }
      return Promise.resolve({ data: { review_id: args.p_review_id, status: args.p_status }, error: null });
    });
    return builder;
  };
  return {
    chefbyte: chef,
    supabase: { functions: { invoke: vi.fn() } },
  };
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/reviews']}>
        <ReviewsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const sampleRow = {
  review_id: 'cloud-rev-1',
  pi_review_id: 'pi-rev-1',
  kind: 'low_confidence',
  status: 'pending',
  proposed: { item_id: 'prod-x', confidence: 0.42 },
  images: ['events/e1/before.jpg'],
  created_at: '2026-04-29T12:00:00.000Z',
  resolved_at: null,
  user_response: null,
  pi_event_id: 'pi-event-1',
};

beforeEach(() => {
  rpcCalls.length = 0;
  fromSelectResults.rows = [];
  fromSelectResults.error = null;
  devicesResults.rows = [];
  devicesResults.error = null;
  rpcGate = null;
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ReviewsPage', () => {
  it('renders pending reviews from chefbyte.review_queue', async () => {
    fromSelectResults.rows = [sampleRow];
    renderPage();

    // Header always visible.
    expect(screen.getByRole('heading', { name: /pending reviews/i })).toBeInTheDocument();

    // Row appears after the query resolves.
    await waitFor(() => {
      expect(screen.getByTestId('review-row-cloud-rev-1')).toBeInTheDocument();
    });

    // Kind label is human-readable.
    expect(screen.getByText('Low-confidence classifier')).toBeInTheDocument();

    // Proposed JSON is rendered.
    const proposed = screen.getByTestId('review-proposed-cloud-rev-1');
    expect(proposed.textContent).toContain('prod-x');
  });

  it('shows the empty state when there are no pending reviews', async () => {
    fromSelectResults.rows = [];
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('reviews-empty')).toBeInTheDocument();
    });
  });

  /**
   * CB-WEB-HIGH-3: True optimistic remove — row must disappear BEFORE
   * the RPC resolves. The rpcGate blocks resolve_review so we can assert
   * on the intermediate DOM state. If onMutate's optimistic filter is
   * removed, the row stays visible while the RPC is in-flight and this
   * test fails.
   */
  it('CB-WEB-HIGH-3: Accept optimistically removes the row BEFORE the RPC resolves', async () => {
    fromSelectResults.rows = [sampleRow];
    // Install gate — resolve_review will block until we release it.
    rpcGate = { resolve: () => {}, reject: () => {} };

    renderPage();
    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));

    const user = userEvent.setup();
    // Fire the click — onMutate runs synchronously removing the row from
    // the cache; the RPC is still pending (blocked by rpcGate).
    await act(async () => {
      await user.click(screen.getByTestId('review-accept-cloud-rev-1'));
    });

    // Row must be gone BEFORE the RPC resolves. This is what proves the
    // optimistic remove fires — not a drain-as-apply pattern.
    expect(screen.queryByTestId('review-row-cloud-rev-1')).not.toBeInTheDocument();

    // RPC was dispatched with correct args.
    const call = rpcCalls.find((c) => c.fn === 'resolve_review');
    expect(call).toBeDefined();
    expect(call!.args.p_review_id).toBe('cloud-rev-1');
    expect(call!.args.p_status).toBe('resolved');
    expect(call!.args.p_user_response).toEqual({ decision: 'accept' });

    // Release the gate so the test can clean up without hanging promises.
    await act(async () => {
      rpcGate!.resolve();
    });
  });

  /**
   * CB-WEB-HIGH-3 rollback: if resolve_review rejects, the row must
   * reappear via onError's queryClient.setQueryData(queryKey, context.previous).
   * If onError is removed or calls setQueryData with the wrong key, this fails.
   */
  it('CB-WEB-HIGH-3: rollback — row reappears when resolve_review rejects', async () => {
    fromSelectResults.rows = [sampleRow];
    rpcGate = { resolve: () => {}, reject: () => {} };

    renderPage();
    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));

    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByTestId('review-accept-cloud-rev-1'));
    });

    // Row is optimistically removed.
    expect(screen.queryByTestId('review-row-cloud-rev-1')).not.toBeInTheDocument();

    // Now reject the RPC — onError should restore the previous cache snapshot.
    await act(async () => {
      rpcGate!.reject(new Error('network error'));
    });

    // Row must reappear after rollback.
    await waitFor(() => {
      expect(screen.getByTestId('review-row-cloud-rev-1')).toBeInTheDocument();
    });
  });

  it('Reject button calls resolve_review RPC with status=dismissed', async () => {
    fromSelectResults.rows = [sampleRow];
    renderPage();
    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));

    const user = userEvent.setup();
    await user.click(screen.getByTestId('review-reject-cloud-rev-1'));

    await waitFor(() => {
      const call = rpcCalls.find((c) => c.fn === 'resolve_review');
      expect(call).toBeDefined();
      expect(call!.args.p_status).toBe('dismissed');
      expect(call!.args.p_user_response).toEqual({ decision: 'reject' });
    });
  });

  it('Accept with override text passes the override into user_response', async () => {
    fromSelectResults.rows = [sampleRow];
    renderPage();
    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));

    const user = userEvent.setup();
    const input = screen.getByTestId('review-override-cloud-rev-1') as HTMLInputElement;
    await user.type(input, 'use prod-correct');
    await user.click(screen.getByTestId('review-accept-cloud-rev-1'));

    await waitFor(() => {
      const call = rpcCalls.find((c) => c.fn === 'resolve_review');
      expect(call).toBeDefined();
      expect(call!.args.p_user_response).toEqual({ decision: 'accept', override: 'use prod-correct' });
    });
  });

  /* ---------------- Image rendering (approach (a) — LAN fetch) ---------------- */

  it('renders <img> tags for images[] when a Pi LAN IP is on file', async () => {
    fromSelectResults.rows = [
      {
        ...sampleRow,
        images: ['events/event-99/before.jpg', 'events/event-99/after.jpg'],
      },
    ];
    devicesResults.rows = [{ device_id: 'dev-1', lan_ip: '192.168.0.181', last_heartbeat_ts: '2026-04-29T12:00:00Z' }];
    renderPage();

    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));

    // Wait for the device query to resolve and render imgs
    const before = await screen.findByTestId('review-image-cloud-rev-1-0');
    const after = screen.getByTestId('review-image-cloud-rev-1-1');

    expect(before).toBeInTheDocument();
    expect(after).toBeInTheDocument();
    expect((before as HTMLImageElement).src).toBe('http://192.168.0.181:8000/event/event-99/before.jpg');
    expect((after as HTMLImageElement).src).toBe('http://192.168.0.181:8000/event/event-99/after.jpg');
    // alt text matches the filename suffix
    expect((before as HTMLImageElement).alt).toBe('Before');
    expect((after as HTMLImageElement).alt).toBe('After');
  });

  it('falls back to a placeholder when no Pi LAN IP is on file', async () => {
    fromSelectResults.rows = [
      {
        ...sampleRow,
        images: ['events/event-99/before.jpg', 'events/event-99/after.jpg'],
      },
    ];
    devicesResults.rows = []; // no device → no lan_ip → no image URL
    renderPage();

    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));

    // Placeholders, not <img>s
    expect(await screen.findByTestId('review-image-placeholder-cloud-rev-1-0')).toBeInTheDocument();
    expect(screen.getByTestId('review-image-placeholder-cloud-rev-1-1')).toBeInTheDocument();
    expect(screen.queryByTestId('review-image-cloud-rev-1-0')).not.toBeInTheDocument();
  });

  it('flips an image to a placeholder when its onError fires (off-LAN graceful fallback)', async () => {
    fromSelectResults.rows = [
      {
        ...sampleRow,
        images: ['events/event-99/before.jpg'],
      },
    ];
    devicesResults.rows = [{ device_id: 'dev-1', lan_ip: '192.168.0.181', last_heartbeat_ts: '2026-04-29T12:00:00Z' }];
    renderPage();

    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));
    const img = await screen.findByTestId('review-image-cloud-rev-1-0');

    // Simulate the off-LAN failure path. Wrap in act() — onError flips
    // React state, and tests want that update to be flushed before we
    // assert on the resulting placeholder.
    await act(async () => {
      (img as HTMLImageElement).dispatchEvent(new Event('error'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('review-image-cloud-rev-1-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('review-image-placeholder-cloud-rev-1-0')).toBeInTheDocument();
    });
  });

  it('rejects invalid lan_ip values and renders placeholders (XSS fence)', async () => {
    fromSelectResults.rows = [
      {
        ...sampleRow,
        images: ['events/event-99/before.jpg'],
      },
    ];
    // ``javascript://`` would be lethal interpolated into href/src — the
    // validation gate must reject it. Empty/null already covered above;
    // here we explicitly assert on a malicious value.
    devicesResults.rows = [
      { device_id: 'dev-1', lan_ip: 'javascript:alert(1)//', last_heartbeat_ts: '2026-04-29T12:00:00Z' },
    ];
    renderPage();

    await waitFor(() => screen.getByTestId('review-row-cloud-rev-1'));
    expect(await screen.findByTestId('review-image-placeholder-cloud-rev-1-0')).toBeInTheDocument();
    expect(screen.queryByTestId('review-image-cloud-rev-1-0')).not.toBeInTheDocument();
  });
});

describe('buildPiImageUrl (pure helper)', () => {
  it('builds a canonical Pi event URL for a valid lan_ip + relative path', () => {
    expect(buildPiImageUrl('192.168.0.181', 'events/abc/before.jpg')).toBe(
      'http://192.168.0.181:8000/event/abc/before.jpg',
    );
    expect(buildPiImageUrl('192.168.0.181', 'events/abc/after.jpg')).toBe(
      'http://192.168.0.181:8000/event/abc/after.jpg',
    );
  });

  it('returns null when lan_ip is missing or invalid', () => {
    expect(buildPiImageUrl(null, 'events/abc/before.jpg')).toBeNull();
    expect(buildPiImageUrl('', 'events/abc/before.jpg')).toBeNull();
    expect(buildPiImageUrl('javascript:alert(1)//', 'events/abc/before.jpg')).toBeNull();
    expect(buildPiImageUrl('999.999.999.999', 'events/abc/before.jpg')).toBeNull();
    expect(buildPiImageUrl('http://evil.com', 'events/abc/before.jpg')).toBeNull();
  });

  it('returns null when relative path is missing or shaped wrong', () => {
    expect(buildPiImageUrl('192.168.0.181', null)).toBeNull();
    expect(buildPiImageUrl('192.168.0.181', '')).toBeNull();
    // path traversal guard
    expect(buildPiImageUrl('192.168.0.181', 'events/../../etc/passwd')).toBeNull();
    // wrong prefix
    expect(buildPiImageUrl('192.168.0.181', 'foo/abc/before.jpg')).toBeNull();
    // missing filename
    expect(buildPiImageUrl('192.168.0.181', 'events/abc')).toBeNull();
    // absolute URL injection
    expect(buildPiImageUrl('192.168.0.181', 'http://evil.com/x.jpg')).toBeNull();
  });
});
