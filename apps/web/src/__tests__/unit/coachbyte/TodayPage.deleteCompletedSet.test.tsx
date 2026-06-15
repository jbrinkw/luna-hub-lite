/**
 * A2-10 — deleteCompletedSet optimistic reopen targets the RIGHT planned set.
 *
 * Bug: the optimistic update in `deleteCompletedSet` matched the planned set
 * to reopen by `exercise_name`. With two completed sets of the SAME exercise,
 * `findIndex(s => s.completed && s.exercise_name === removed.exercise_name)`
 * always returns the FIRST match — so deleting the SECOND set's completion
 * visibly reopened the FIRST set (wrong load/targets) until the server
 * invalidation reconciled.
 *
 * Fix: `CompletedSet` now carries `planned_set_id` (the completed_sets query
 * already selected it; the type + mapper dropped it). The optimistic reopen
 * matches by `planned_set_id`, falling back to `exercise_name` only for legacy
 * rows with a null link.
 *
 * This test drives the SHIPPED `TodayPage`:
 *   - Plan with two "Bench" sets — ps-1 @ 135, ps-2 @ 185 — BOTH completed,
 *     plus one different un-completed exercise so the queue card has a stable
 *     baseline. Actually we make ALL sets completed so the reopened set is
 *     unambiguously the FIRST incomplete one (= the new "Next in Queue").
 *   - Delete the completion linked to ps-2 (the 185 set).
 *   - The refetch is GATED so only the optimistic update can have acted within
 *     the assertion window.
 *   - Assert the reopened "Next in Queue" set shows the ps-2 targets (185),
 *     NOT ps-1's (135). The pre-fix code reopened ps-1 → would show 135.
 *
 * Only the Supabase transport is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const PLAN_ID = 'plan-a210';

// Two Bench sets with DISTINCT loads so the reopened set is identifiable by
// its targets, plus a trailing different exercise. order drives queue sort.
const plannedSetsFixture = [
  {
    planned_set_id: 'ps-1',
    exercise_id: 'ex-bench',
    target_reps: 5,
    target_load: 135,
    target_load_percentage: null,
    rest_seconds: 120,
    order: 1,
    exercises: { name: 'Bench' },
  },
  {
    planned_set_id: 'ps-2',
    exercise_id: 'ex-bench',
    target_reps: 3,
    target_load: 185,
    target_load_percentage: null,
    rest_seconds: 120,
    order: 2,
    exercises: { name: 'Bench' },
  },
];

// Both Bench sets completed. completed_at ascending → row #1 = ps-1, #2 = ps-2.
// Each completion carries planned_set_id (the column the query selects).
const completedSetsFixture = [
  {
    completed_set_id: 'cs-1',
    planned_set_id: 'ps-1',
    actual_reps: 5,
    actual_load: 135,
    completed_at: '2026-06-15T10:00:00Z',
    exercises: { name: 'Bench' },
  },
  {
    completed_set_id: 'cs-2',
    planned_set_id: 'ps-2',
    actual_reps: 3,
    actual_load: 185,
    completed_at: '2026-06-15T10:05:00Z',
    exercises: { name: 'Bench' },
  },
];

let deleteError: { message: string } | null = null;

// Refetch gate on the completed_sets/planned_sets reads. The first read of
// each table returns the initial (all-completed) fixture; subsequent reads
// (the onSettled invalidation refetch) block on this gate so the optimistic
// reopen is the ONLY thing that can have changed the UI when we assert.
let plannedReadCount = 0;
let completedReadCount = 0;
let releaseRefetch!: () => void;
let refetchGate: Promise<void>;
function armRefetchGate() {
  refetchGate = new Promise((resolve) => {
    releaseRefetch = resolve;
  });
}

function resetState() {
  deleteError = null;
  plannedReadCount = 0;
  completedReadCount = 0;
  armRefetchGate();
}

vi.mock('@/shared/supabase', () => {
  const buildSchemaClient = () => {
    const root: any = {};

    root.rpc = vi.fn((name: string) => {
      if (name === 'ensure_daily_plan') {
        return Promise.resolve({ data: { plan_id: PLAN_ID, status: 'created' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    root.from = vi.fn((table: string) => {
      const builder: any = {};
      let isDelete = false;

      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.or = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
      builder.update = vi.fn(() => builder);
      builder.insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.single = vi.fn(() => {
        if (table === 'daily_plans') {
          return Promise.resolve({ data: { summary: '', notes: '' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      builder.delete = vi.fn(() => {
        isDelete = true;
        return builder;
      });

      // The completed_sets DELETE resolves through .eq() returning a thenable.
      // For reads, .then() resolves the table fixture, gating the refetch.
      builder.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        if (table === 'completed_sets' && isDelete) {
          resolve({ data: null, error: deleteError });
          return;
        }
        if (table === 'planned_sets') {
          plannedReadCount += 1;
          if (plannedReadCount === 1) {
            resolve({ data: plannedSetsFixture, error: null });
          } else {
            refetchGate.then(() => resolve({ data: plannedSetsFixture, error: null })).catch(reject);
          }
          return;
        }
        if (table === 'completed_sets') {
          completedReadCount += 1;
          if (completedReadCount === 1) {
            resolve({ data: completedSetsFixture, error: null });
          } else {
            refetchGate.then(() => resolve({ data: completedSetsFixture, error: null })).catch(reject);
          }
          return;
        }
        if (table === 'exercises') {
          resolve({ data: [], error: null });
          return;
        }
        resolve({ data: null, error: null });
      };

      return builder;
    });

    return root;
  };

  const supabase: any = {
    schema: vi.fn(() => buildSchemaClient()),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(() => ({ state: 'SUBSCRIBED' })),
    })),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
  };

  return {
    supabase,
    chefbyte: () => buildSchemaClient(),
    coachbyte: () => buildSchemaClient(),
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

vi.mock('@/shared/AppProvider', () => ({
  useAppContext: () => ({
    activations: {},
    activationsLoading: false,
    online: true,
    lastSynced: null,
    dayStartHour: 0,
    refreshActivations: vi.fn(),
    realtimeDegraded: false,
    reconnectRealtime: vi.fn(),
  }),
  AppProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn(),
}));

// Raw-number plate formatting so we can assert on the exact target load.
vi.mock('@/shared/plateCalc', () => ({
  formatWeightWithPlates: (w: number) => `${w}`,
}));

import { TodayPage } from '@/pages/coachbyte/TodayPage';

function renderToday() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/coach/today']}>
        <TodayPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TodayPage — deleteCompletedSet reopens the correct planned set (A2-10)', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    releaseRefetch?.();
    vi.clearAllMocks();
  });

  it('deleting the 2nd Bench completion reopens ps-2 (185), not ps-1 (135)', async () => {
    const user = userEvent.setup();
    renderToday();

    // Both sets completed → "Next in Queue" shows the all-done state.
    await waitFor(() => {
      expect(screen.getByText('All sets completed!')).toBeInTheDocument();
    });

    // Reveal the completed table (collapsed by default).
    await user.click(screen.getByTestId('toggle-completed'));

    // Row #2 corresponds to cs-2 (ps-2, the 185 set) — completed_at order.
    const row2 = await screen.findByTestId('completed-row-2');
    // Sanity: row #2 really is the 185 set.
    expect(within(row2).getByText(/185/)).toBeInTheDocument();

    // Delete needs a confirm — first click arms, second click commits.
    const delBtn = screen.getByTestId('delete-completed-2');
    await user.click(delBtn);
    await user.click(screen.getByTestId('delete-completed-2'));

    // Let the optimistic update flush. Refetch is GATED, so whatever the
    // queue shows now is purely the optimistic reopen.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The reopened set becomes the "Next in Queue". It MUST be ps-2 (3 reps
    // @ 185), the set whose completion we deleted — NOT ps-1 (5 reps @ 135).
    const nextCard = await screen.findByTestId('next-exercise');
    await waitFor(() => {
      expect(within(nextCard).getByText(/185/)).toBeInTheDocument();
    });
    expect(within(nextCard).getByText(/3 reps/)).toBeInTheDocument();
    // The WRONG set (ps-1) must NOT be the one reopened.
    expect(within(nextCard).queryByText(/135/)).not.toBeInTheDocument();
    expect(within(nextCard).queryByText(/5 reps/)).not.toBeInTheDocument();

    // Release the gated refetch — final reconciliation keeps things stable.
    releaseRefetch();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  });
});
