/**
 * onError rollback — ReviewsPage resolveMutation (REAL component).
 *
 * Drives the SHIPPED `ReviewsPage` optimistic resolve, not an in-file
 * copy. We render the real page, let its `useQuery` load two pending
 * reviews, click Accept on the first, and force the `resolve_review`
 * RPC to reject.
 *
 * Production onMutate optimistically removes the review from the pending
 * list. Production onError must restore `context.previous` (re-insert it).
 *
 * The `onSettled` invalidation refetch is gated by the test so the
 * synchronous onError rollback is the ONLY path that can re-insert the
 * review within the assertion window. Deleting the production rollback
 * leaves the review gone → this test goes RED.
 *
 * (Note: the old test asserted against a fabricated `['reviews','u1',
 * 'pending']` key and an in-file handler copy. The real page uses
 * `['chef-reviews', userId]` and the shipped resolveMutation — this
 * rewrite exercises that real code.)
 *
 * Only the Supabase transport is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-reviews-rollback';

interface ReviewRow {
  review_id: string;
  pi_review_id: string;
  kind: string;
  status: string;
  proposed: null;
  images: null;
  created_at: string;
  resolved_at: null;
  user_response: null;
  pi_event_id: null;
  before_image_url: null;
  after_image_url: null;
}

function makeReview(id: string): ReviewRow {
  return {
    review_id: id,
    pi_review_id: `pi-${id}`,
    kind: 'low_confidence',
    status: 'pending',
    proposed: null,
    images: null,
    created_at: '2026-04-30T10:00:00Z',
    resolved_at: null,
    user_response: null,
    pi_event_id: null,
    before_image_url: null,
    after_image_url: null,
  };
}

let serverReviews: ReviewRow[] = [];
function resetServer() {
  serverReviews = [makeReview('r1'), makeReview('r2')];
}

let resolveShouldFail = false;

// Refetch gate — blocks the onSettled refetch of the review_queue so it
// can't mask a missing onError rollback. See hub-tools-toggle for rationale.
let reviewSelectCount = 0;
let releaseRefetch!: (rows: ReviewRow[]) => void;
let refetchGate: Promise<ReviewRow[]>;
function armRefetchGate() {
  refetchGate = new Promise((resolve) => {
    releaseRefetch = resolve;
  });
}

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const root: any = {};
    root.rpc = vi.fn((name: string) => {
      if (name === 'resolve_review') {
        if (resolveShouldFail) {
          return Promise.resolve({ data: null, error: { message: 'resolve_review failed' } });
        }
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    root.from = vi.fn((table: string) => {
      // Fully-chainable thenable builder: any filter/modifier method returns
      // the same builder; awaiting it resolves the table's data. Using a
      // Proxy keeps the mock robust against ChefLayout/useSettingsAlerts
      // queries (shelf_event_log, products) that chain .is()/.gt()/etc.
      const resolveFor = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        if (table === 'review_queue') {
          reviewSelectCount += 1;
          if (reviewSelectCount === 1) {
            resolve({ data: serverReviews.filter((r) => r.status === 'pending'), error: null, count: null });
          } else {
            refetchGate.then((rows) => resolve({ data: rows, error: null, count: null })).catch(reject);
          }
          return;
        }
        // Everything else (live_shelf_devices, shelf_event_log, products,
        // count-head queries) resolves empty/zero.
        resolve({ data: [], error: null, count: 0 });
      };
      const b: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: any) => void, reject?: (e: unknown) => void) => resolveFor(resolve, reject);
            }
            // Any other accessed property is a chainable method returning b.
            return () => b;
          },
        },
      );
      return b;
    });
    return root;
  };
  return {
    supabase: {
      channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn(), unsubscribe: vi.fn() })),
      removeChannel: vi.fn(),
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID, email: 't@t.com' }, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

import { ReviewsPage } from '@/pages/chefbyte/ReviewsPage';
import { ThemeProvider } from '@/shared/ThemeProvider';

function renderReviews(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/chef/reviews']}>
          <ReviewsPage />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function makeQc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function pendingRows(): ReviewRow[] {
  return serverReviews.filter((r) => r.status === 'pending');
}

describe('ReviewsPage resolveMutation — onError rollback (real component)', () => {
  beforeEach(() => {
    resetServer();
    resolveShouldFail = false;
    reviewSelectCount = 0;
    armRefetchGate();
  });

  afterEach(() => {
    releaseRefetch?.(pendingRows());
    vi.clearAllMocks();
  });

  it('restores the removed review when the resolve_review RPC rejects', async () => {
    resolveShouldFail = true;
    const qc = makeQc();
    const user = userEvent.setup();
    renderReviews(qc);

    // Both review rows visible.
    await screen.findByTestId('review-row-r1');
    expect(screen.getByTestId('review-row-r2')).toBeInTheDocument();

    // Accept r1 → optimistic remove, RPC rejects, onError restores.
    await user.click(screen.getByTestId('review-accept-r1'));

    // Refetch BLOCKED → rollback is the only restorer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Rolled back: r1 is back.
    await waitFor(() => {
      expect(screen.getByTestId('review-row-r1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('review-row-r2')).toBeInTheDocument();

    // Release gated refetch — list stays consistent.
    releaseRefetch(pendingRows());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId('review-row-r1')).toBeInTheDocument();
  });

  it('does NOT restore when the RPC succeeds (success-path control)', async () => {
    resolveShouldFail = false;
    const qc = makeQc();
    const user = userEvent.setup();
    renderReviews(qc);

    await screen.findByTestId('review-row-r1');

    await user.click(screen.getByTestId('review-accept-r1'));

    // On success the server marks r1 resolved; release the refetch with that.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      serverReviews = serverReviews.map((r) => (r.review_id === 'r1' ? { ...r, status: 'resolved' } : r));
      releaseRefetch(pendingRows());
      await new Promise((r) => setTimeout(r, 20));
    });

    // r1 stays gone, r2 remains.
    await waitFor(() => {
      expect(screen.queryByTestId('review-row-r1')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('review-row-r2')).toBeInTheDocument();
  });

  it('Reject path also rolls back on RPC failure', async () => {
    // The Reject button routes through the same resolveMutation with
    // status='dismissed'. Same rollback contract.
    resolveShouldFail = true;
    const qc = makeQc();
    const user = userEvent.setup();
    renderReviews(qc);

    await screen.findByTestId('review-row-r2');
    await user.click(screen.getByTestId('review-reject-r2'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(screen.getByTestId('review-row-r2')).toBeInTheDocument();
    });
  });
});
