/**
 * SplitPage — passive hint banner on today's weekday (CoachByte FLAG F5).
 *
 * The audit's stated suggestion: "add the passive hint banner to
 * SplitPage when the day being edited matches today's weekday." The
 * hint clarifies that in-place edits don't propagate to today's
 * already-bootstrapped plan.
 *
 * The active "apply to today" affordance was deferred (touches the
 * bootstrap-once-per-day spec). This test pins the passive-hint
 * shape — the only thing that lands in this batch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const SPLIT_FIXTURE = [
  {
    split_id: 's-1',
    weekday: 1,
    template_sets: [
      {
        exercise_id: 'ex-1',
        exercise_name: 'Squat',
        target_reps: 5,
        target_load: 225,
        target_load_percentage: null,
        rest_seconds: 90,
        order: 1,
      },
    ],
    split_notes: '',
  },
];

vi.mock('@/shared/supabase', () => {
  const buildSchemaClient = () => {
    const root: any = {};
    root.from = vi.fn((table: string) => {
      const builder: any = {};
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.or = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.update = vi.fn(() => builder);
      builder.insert = vi.fn(() => builder);
      builder.delete = vi.fn(() => builder);
      builder.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.then = (resolve: (v: unknown) => void) => {
        if (table === 'splits') {
          resolve({ data: SPLIT_FIXTURE, error: null });
        } else if (table === 'exercises') {
          resolve({ data: [{ exercise_id: 'ex-1', name: 'Squat' }], error: null });
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

import { SplitPage } from '@/pages/coachbyte/SplitPage';

function renderSplit() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/coach/split']}>
        <SplitPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SplitPage — Today badge + passive hint (FLAG F5)', () => {
  beforeEach(() => {
    // Pin "today" to a Tuesday — weekday=2. Locks the test against
    // calendar drift so CI runs deterministically.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00Z')); // Tuesday
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the "Today" badge on the day matching today\'s weekday', async () => {
    renderSplit();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    // Tuesday = weekday 2.
    expect(screen.getByTestId('day-2-today-badge')).toBeInTheDocument();
    // Other days don't get the badge.
    expect(screen.queryByTestId('day-1-today-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('day-3-today-badge')).not.toBeInTheDocument();
  });

  it('renders the passive hint banner explaining the propagation rule', async () => {
    renderSplit();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    // Tuesday is rest-day in fixture (no template_sets) — but the hint
    // banner still renders when the day is expanded. Default-collapse
    // for rest days hides it. Let's instead assert structure: the
    // weekday-2 row has the badge, and SOME hint exists when the day
    // expands. To keep the test deterministic, click the toggle to
    // expand if needed.
    const toggle = screen.getByTestId('day-2-toggle');
    // Rest days are collapsed by default; click to expand.
    if (!screen.queryByTestId('day-2-today-hint')) {
      const { fireEvent } = await import('@testing-library/react');
      fireEvent.click(toggle);
    }
    const hint = screen.queryByTestId('day-2-today-hint');
    expect(hint).toBeInTheDocument();
    expect(hint?.textContent).toMatch(/next Tuesday/i);
    expect(hint?.textContent).toMatch(/Today page|Reset Plan/i);
  });
});
