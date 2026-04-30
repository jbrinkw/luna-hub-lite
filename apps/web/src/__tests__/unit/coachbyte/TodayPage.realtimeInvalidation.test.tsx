/**
 * W-11: TodayPage useRealtimeInvalidation query key contract.
 *
 * TodayPage mocks useRealtimeInvalidation as vi.fn() in every other unit
 * test — a complete no-op. This means no test verified that the correct
 * query keys are wired to the correct tables. If the wrong key is passed
 * (e.g. queryKeys.splits instead of queryKeys.dailyPlan for completed_sets)
 * the Today page would never refresh after a remote set completion.
 *
 * This test spies on the useRealtimeInvalidation import to capture the
 * subscription config TodayPage passes, and asserts:
 *   - completed_sets changes invalidate queryKeys.dailyPlan
 *   - planned_sets changes invalidate queryKeys.dailyPlan
 *   - timers changes invalidate queryKeys.timer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ── queryKeys (production) ──────────────────────────────────────────────────
import { queryKeys } from '@/shared/queryKeys';

// ── Capture useRealtimeInvalidation calls (partial mock — spy on calls) ─────
// We replace the module with a spy that captures arguments but does NOT wire
// any actual Supabase channels. This lets us assert on the subscription config
// without needing a live WS connection or triggering Realtime events.
const realtimeInvalidationSpy = vi.fn();

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: (...args: unknown[]) => realtimeInvalidationSpy(...args),
}));

// ── Supabase mock ────────────────────────────────────────────────────────────
vi.mock('@/shared/supabase', () => {
  const buildSchemaClient = () => {
    const root: any = {};
    root.rpc = vi.fn((name: string) => {
      if (name === 'ensure_daily_plan') {
        return Promise.resolve({ data: { plan_id: 'plan-w11', status: 'created' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    root.from = vi.fn((table: string) => {
      const builder: any = {};
      builder.select = vi.fn(() => builder);
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
        if (table === 'planned_sets') resolve({ data: [], error: null });
        else if (table === 'completed_sets') resolve({ data: [], error: null });
        else resolve({ data: null, error: null });
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
    user: { id: 'user-w11', email: 'w11@test.com' },
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

const USER_ID = 'user-w11';

describe('TodayPage — useRealtimeInvalidation query key contract (W-11)', () => {
  beforeEach(() => {
    realtimeInvalidationSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers useRealtimeInvalidation with the "coach-today" channel name', async () => {
    renderToday();

    await waitFor(() => {
      expect(realtimeInvalidationSpy).toHaveBeenCalledTimes(1);
    });

    const [channelName] = realtimeInvalidationSpy.mock.calls[0];
    expect(channelName).toBe('coach-today');
  });

  it('wires completed_sets changes to queryKeys.dailyPlan (not a wrong key)', async () => {
    renderToday();

    await waitFor(() => {
      expect(realtimeInvalidationSpy).toHaveBeenCalledTimes(1);
    });

    const [, subscriptions] = realtimeInvalidationSpy.mock.calls[0] as [string, any[]];

    const completedSetsSub = subscriptions.find((s: any) => s.schema === 'coachbyte' && s.table === 'completed_sets');
    expect(completedSetsSub).toBeDefined();

    // The invalidated key must be dailyPlan — not splits, prs, timer, or
    // any other key. A wrong key here means the Today page never refreshes
    // after a remote set completion.
    const key = completedSetsSub.queryKeys[0];
    expect(key).toEqual(queryKeys.dailyPlan(USER_ID, expect.any(String)));
  });

  it('wires planned_sets changes to queryKeys.dailyPlan', async () => {
    renderToday();

    await waitFor(() => {
      expect(realtimeInvalidationSpy).toHaveBeenCalledTimes(1);
    });

    const [, subscriptions] = realtimeInvalidationSpy.mock.calls[0] as [string, any[]];

    const plannedSetsSub = subscriptions.find((s: any) => s.schema === 'coachbyte' && s.table === 'planned_sets');
    expect(plannedSetsSub).toBeDefined();
    expect(plannedSetsSub.queryKeys[0]).toEqual(queryKeys.dailyPlan(USER_ID, expect.any(String)));
  });

  it('wires timers changes to queryKeys.timer (not dailyPlan)', async () => {
    renderToday();

    await waitFor(() => {
      expect(realtimeInvalidationSpy).toHaveBeenCalledTimes(1);
    });

    const [, subscriptions] = realtimeInvalidationSpy.mock.calls[0] as [string, any[]];

    const timerSub = subscriptions.find((s: any) => s.schema === 'coachbyte' && s.table === 'timers');
    expect(timerSub).toBeDefined();

    // Timer events must invalidate queryKeys.timer — using dailyPlan here
    // would cause unnecessary plan refetches on every timer tick.
    const key = timerSub.queryKeys[0];
    expect(key).toEqual(queryKeys.timer(USER_ID));

    // And must NOT invalidate dailyPlan (a regression that added dailyPlan
    // here would over-refetch on every timer second).
    expect(timerSub.queryKeys).not.toContainEqual(queryKeys.dailyPlan(USER_ID, expect.any(String)));
  });
});
