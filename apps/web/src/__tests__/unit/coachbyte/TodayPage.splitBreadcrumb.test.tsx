/**
 * TodayPage — split breadcrumb hint (CoachByte FLAG F7).
 *
 * The header now renders "· from {Weekday} split" under the date so
 * the user can orient against the source split row. Implementation is
 * a client-side weekday heuristic against `today` (already
 * day_start_hour-aware).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const PLAN_ID = 'plan-fixture-breadcrumb';

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
        if (table === 'daily_plans') return Promise.resolve({ data: { summary: '', notes: '' }, error: null });
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
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn(() => ({ state: 'SUBSCRIBED' })) })),
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

vi.mock('@/hooks/useTimerAudio', () => ({
  fireTimerExpiredCue: vi.fn(),
  firePrCelebrationCue: vi.fn(),
  vibrateSetCompleted: vi.fn(),
  vibratePr: vi.fn(),
  requestNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  useScreenWakeLock: vi.fn(),
  installAudioUnlockOnFirstGesture: vi.fn(),
  unlockAudioContextNow: vi.fn(),
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

describe('TodayPage — split breadcrumb (FLAG F7)', () => {
  it('renders the split breadcrumb naming SOME source weekday', async () => {
    renderToday();
    await waitFor(() => expect(screen.getByTestId('split-breadcrumb')).toBeInTheDocument(), { timeout: 3000 });
    const breadcrumb = screen.getByTestId('split-breadcrumb');
    // The exact weekday depends on the test runner's clock; what we
    // pin is the SHAPE — "from {Weekday} split" with one of the seven
    // long names.
    expect(breadcrumb.textContent).toMatch(/from (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) split/);
  });
});
