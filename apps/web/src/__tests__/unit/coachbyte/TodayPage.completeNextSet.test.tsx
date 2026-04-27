/**
 * Bug B — TodayPage `complete_next_set` RPC arg-name regression test.
 *
 * The deployed `coachbyte.complete_next_set` function (migration
 * 20260422030000_complete_next_set_completed_flag.sql) accepts:
 *   p_plan_id, p_actual_reps, p_actual_load
 *
 * Pre-fix the UI mutation in TodayPage.tsx (~line 320) was sending
 * p_reps / p_load. PostgREST resolves the function by exact arg-name
 * match, so the call would 404 (PGRST202) at the API layer and the
 * "Complete Set" button would surface a generic error instead of
 * progressing the queue.
 *
 * Phase 2 e2e scenario 09 dodged the bug by calling the RPC directly
 * with the canonical names — the integration was tested but the
 * UI->RPC contract was not. This test pins the canonical contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/*  Capture every rpc('complete_next_set', args)                       */
/* ------------------------------------------------------------------ */

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

const rpcCalls: RpcCall[] = [];

function resetState() {
  rpcCalls.length = 0;
}

const PLAN_ID = 'plan-fixture-1';

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

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/supabase', () => {
  const buildSchemaClient = () => {
    const root: any = {};

    root.rpc = vi.fn((name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });

      if (name === 'ensure_daily_plan') {
        return Promise.resolve({ data: { plan_id: PLAN_ID, status: 'created' }, error: null });
      }
      if (name === 'complete_next_set') {
        // Mirror the real RPC's success shape (rest_seconds + completed).
        return Promise.resolve({ data: [{ rest_seconds: 90, completed: true }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    root.from = vi.fn((table: string) => {
      const builder: any = {};
      const state: { filters: Record<string, unknown>; orderArg: string | null } = { filters: {}, orderArg: null };

      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn((col: string, val: unknown) => {
        state.filters[col] = val;
        return builder;
      });
      builder.is = vi.fn(() => builder);
      builder.or = vi.fn(() => builder);
      builder.order = vi.fn((arg: string) => {
        state.orderArg = arg;
        return builder;
      });
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

      // Awaitable builder for select().eq().order() chains.
      builder.then = (resolve: (v: unknown) => void) => {
        if (table === 'planned_sets') {
          resolve({ data: plannedSetsFixture, error: null });
        } else if (table === 'completed_sets') {
          resolve({ data: [], error: null });
        } else if (table === 'exercises') {
          resolve({ data: [], error: null });
        } else if (table === 'timers') {
          resolve({ data: null, error: null });
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

import { TodayPage } from '@/pages/coachbyte/TodayPage';

function renderToday() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/coach/today']}>
        <TodayPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('TodayPage — complete_next_set RPC contract (Bug B)', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls coachbyte.complete_next_set with canonical p_actual_reps/p_actual_load arg names', async () => {
    const user = userEvent.setup();
    renderToday();

    // Wait for the daily-plan query to load and reveal the SetQueue.
    await waitFor(() => {
      expect(screen.getByTestId('next-in-queue')).toBeInTheDocument();
    });

    // Click the "Complete Set" button — pre-filled with target_reps=5,
    // target_load=225 from the fixture. This dispatches completeSetMutation
    // which calls coachbyte().rpc('complete_next_set', { ... }).
    await user.click(screen.getByTestId('complete-set-btn'));

    // Allow mutation + onSuccess callback to flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const completeCalls = rpcCalls.filter((c) => c.name === 'complete_next_set');
    expect(completeCalls.length).toBeGreaterThan(0);

    const args = completeCalls[0].args;

    // Canonical arg names — what the deployed migration accepts.
    expect(args).toHaveProperty('p_plan_id', PLAN_ID);
    expect(args).toHaveProperty('p_actual_reps', 5);
    expect(args).toHaveProperty('p_actual_load', 225);

    // Pre-fix arg names — these must NOT be present, otherwise PostgREST
    // would 404 (PGRST202: function not found in schema cache).
    expect(args).not.toHaveProperty('p_reps');
    expect(args).not.toHaveProperty('p_load');
  });
});
