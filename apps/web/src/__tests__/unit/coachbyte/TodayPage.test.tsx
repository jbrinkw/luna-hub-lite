import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TodayPage } from '@/pages/coachbyte/TodayPage';

const mockUser = { id: 'u1' };
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: mockUser, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const PLAN_ID = 'plan-abc';

const mockPlannedSets = [
  {
    planned_set_id: 'ps-1',
    exercise_id: 'ex-1',
    target_reps: 5,
    target_load: '225',
    target_load_percentage: null,
    rest_seconds: 180,
    order: 1,
    exercises: { name: 'Squat' },
  },
  {
    planned_set_id: 'ps-2',
    exercise_id: 'ex-2',
    target_reps: 8,
    target_load: '185',
    target_load_percentage: null,
    rest_seconds: 120,
    order: 2,
    exercises: { name: 'Bench Press' },
  },
];

const mockCompletedSets = [
  {
    completed_set_id: 'cs-1',
    planned_set_id: 'ps-1',
    actual_reps: 5,
    actual_load: '225',
    completed_at: '2026-03-03T10:00:00Z',
    exercises: { name: 'Squat' },
  },
];

const mockExercises = [
  { exercise_id: 'ex-1', name: 'Squat' },
  { exercise_id: 'ex-2', name: 'Bench Press' },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock — per-call chain with table+rpc routing              */
/* ------------------------------------------------------------------ */

let plannedSetsData: any[] | null = mockPlannedSets;
let completedSetsData: any[] | null = mockCompletedSets;
let rpcResult: any = { data: { plan_id: PLAN_ID, status: 'open' }, error: null };
let completeNextSetResult: any = { data: [{ rest_seconds: 90 }], error: null };

function getDataForTable(table: string) {
  if (table === 'planned_sets') return plannedSetsData;
  if (table === 'completed_sets') return completedSetsData;
  if (table === 'daily_plans') return { summary: 'Push day' };
  if (table === 'exercises') return mockExercises;
  if (table === 'timers') return null;
  return null;
}

function makeChain(table: string) {
  const chain: any = {};
  const methods = [
    'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
    'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt', 'upsert',
  ];
  methods.forEach(m => { chain[m] = vi.fn(() => chain); });
  chain.then = (resolve: any, _reject?: any) => {
    const data = getDataForTable(table);
    return resolve({ data, error: null });
  };
  // single() returns the raw data (not array), used by daily_plans and timers
  chain.single = vi.fn(() => {
    const data = getDataForTable(table);
    return { data, error: null };
  });
  return chain;
}

const mockRpc = vi.fn((fnName: string, _params?: any) => {
  if (fnName === 'ensure_daily_plan') return rpcResult;
  if (fnName === 'complete_next_set') return completeNextSetResult;
  return { data: null, error: null };
});

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: (fn: string, params?: any) => mockRpc(fn, params),
    }),
    channel: () => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() }),
    removeChannel: vi.fn(),
  },
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/coach']}>
      <TodayPage />
    </MemoryRouter>,
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('TodayPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    plannedSetsData = mockPlannedSets;
    completedSetsData = mockCompletedSets;
    rpcResult = { data: { plan_id: PLAN_ID, status: 'open' }, error: null };
    completeNextSetResult = { data: [{ rest_seconds: 90 }], error: null };
  });

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByLabelText('loading')).toBeInTheDocument();
  });

  it('renders "TODAY\'S WORKOUT" heading after data loads', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/TODAY'S WORKOUT/)).toBeInTheDocument();
    });
  });

  it('shows planned sets via SetQueue after ensure_daily_plan RPC succeeds', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/TODAY'S WORKOUT/)).toBeInTheDocument();
    });
    // The SetQueue should render with the next-in-queue card
    // ps-1 is completed (in completedSets), so next should be ps-2 (Bench Press)
    expect(screen.getByTestId('next-in-queue')).toBeInTheDocument();
    expect(screen.getByTestId('next-exercise')).toHaveTextContent('Bench Press');
  });

  it('shows "No workout planned" when plan has no sets', async () => {
    plannedSetsData = [];
    completedSetsData = [];
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/no workout planned/i)).toBeInTheDocument();
    });
  });

  it('shows completed sets table when sets are completed', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/TODAY'S WORKOUT/)).toBeInTheDocument();
    });
    // The COMPLETED SETS card should render with our mock completed set
    expect(screen.getByText('COMPLETED SETS')).toBeInTheDocument();
    expect(screen.getByTestId('completed-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('completed-row-1')).toHaveTextContent('Squat');
    expect(screen.getByTestId('completed-row-1')).toHaveTextContent('5');
    expect(screen.getByTestId('completed-row-1')).toHaveTextContent('225');
  });

  it('calls complete_next_set RPC when Complete button is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('complete-set-btn')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('complete-set-btn'));

    // Next-in-queue is ps-2 (Bench Press): target_reps=8, target_load='185'
    // SetQueue initializes its reps/load inputs from the next set's targets
    expect(mockRpc).toHaveBeenCalledWith('complete_next_set', {
      p_plan_id: PLAN_ID,
      p_reps: 8,
      p_load: 185,
    });
  });

  it('shows ad-hoc set form when ad-hoc button is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('adhoc-btn')).toBeInTheDocument();
    });

    // Ad-hoc form should NOT be visible initially
    expect(screen.queryByTestId('adhoc-form')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('adhoc-btn'));

    // After clicking, the AdHocSetForm should appear
    expect(screen.getByTestId('adhoc-form')).toBeInTheDocument();
  });
});
