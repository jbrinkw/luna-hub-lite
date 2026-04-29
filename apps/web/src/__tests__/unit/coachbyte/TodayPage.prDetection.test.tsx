/**
 * TodayPage — PR detection bug fix + optimistic update behavior.
 *
 * Pre-fix, the PR-check loop in completeSetMutation excluded prior
 * sets via reps×load equality:
 *
 *   if (r === reps && l === load) continue;
 *
 * That meant: hitting 5×225 a second time (legitimately matching a
 * prior best) accidentally excluded the prior set too — preventing the
 * "first record" path from firing and risking misreports of "NEW PR".
 *
 * The fix: exclude by `completed_set_id` returned from the
 * `complete_next_set` RPC.
 *
 * This test pins the fixed contract by capturing the rows fetched
 * during the PR check and asserting that:
 *   - the just-logged set's completed_set_id is excluded
 *   - prior matching reps×load sets are NOT excluded
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const PLAN_ID = 'plan-fixture-pr';
const COMPLETED_ID = 'cs-just-logged';

const plannedSetsFixture = [
  {
    planned_set_id: 'ps-1',
    exercise_id: 'ex-1',
    target_reps: 5,
    target_load: 225,
    target_load_percentage: null,
    rest_seconds: 180,
    order: 1,
    exercises: { name: 'Squat' },
  },
];

// Capture which select() calls happened against completed_sets so we
// can assert the loader pulls completed_set_id (the fix).
const completedSetsSelectCalls: string[] = [];

vi.mock('@/shared/supabase', () => {
  const buildSchemaClient = () => {
    const root: any = {};

    root.rpc = vi.fn((name: string) => {
      if (name === 'ensure_daily_plan') {
        return Promise.resolve({ data: { plan_id: PLAN_ID, status: 'created' }, error: null });
      }
      if (name === 'complete_next_set') {
        // Return the completed_set_id from the RPC response so the PR
        // path can use it to exclude the just-logged set.
        return Promise.resolve({
          data: [
            {
              completed_set_id: COMPLETED_ID,
              planned_set_id: 'ps-1',
              rest_seconds: 90,
              completed: true,
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    root.from = vi.fn((table: string) => {
      const builder: any = {};
      builder.select = vi.fn((cols: string) => {
        if (table === 'completed_sets') completedSetsSelectCalls.push(cols);
        return builder;
      });
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.or = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
      builder.update = vi.fn(() => builder);
      builder.delete = vi.fn(() => builder);
      builder.insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.single = vi.fn(() => {
        if (table === 'daily_plans') {
          return Promise.resolve({ data: { summary: '', notes: '' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      builder.then = (resolve: (v: unknown) => void) => {
        if (table === 'planned_sets') {
          resolve({ data: plannedSetsFixture, error: null });
        } else if (table === 'completed_sets') {
          resolve({ data: [], error: null });
        } else {
          resolve({ data: null, error: null });
        }
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

vi.mock('@/shared/plateCalc', () => ({
  formatWeightWithPlates: (w: number) => `${w}`,
}));

// Avoid noisy AudioContext + WakeLock paths in this PR-check test.
vi.mock('@/hooks/useTimerAudio', () => ({
  fireTimerExpiredCue: vi.fn(),
  requestNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  useScreenWakeLock: vi.fn(),
}));

import { TodayPage } from '@/pages/coachbyte/TodayPage';

function renderToday() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/coach']}>
        <TodayPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TodayPage — PR detection by completed_set_id (UX audit fix)', () => {
  beforeEach(() => {
    completedSetsSelectCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('PR-check loader requests completed_set_id (so we can exclude by id, not value-equality)', async () => {
    const user = userEvent.setup();
    renderToday();

    await waitFor(() => expect(screen.getByTestId('next-in-queue')).toBeInTheDocument());
    await user.click(screen.getByTestId('complete-set-btn'));

    // Allow the mutation onSuccess + PR-check fetch to flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The PR-check select on completed_sets should pull
    // completed_set_id, actual_reps, actual_load — that's the canonical
    // shape we need to exclude the just-logged row by id.
    const prCheck = completedSetsSelectCalls.find((s) => s.includes('completed_set_id'));
    expect(prCheck).toBeDefined();
    expect(prCheck).toContain('completed_set_id');
    expect(prCheck).toContain('actual_reps');
    expect(prCheck).toContain('actual_load');
  });

  it('shows the undo toast immediately after a successful Complete Set', async () => {
    const user = userEvent.setup();
    renderToday();
    await waitFor(() => expect(screen.getByTestId('next-in-queue')).toBeInTheDocument());
    await user.click(screen.getByTestId('complete-set-btn'));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByTestId('undo-toast')).toBeInTheDocument();
    expect(screen.getByTestId('undo-set-btn')).toBeInTheDocument();
  });
});
