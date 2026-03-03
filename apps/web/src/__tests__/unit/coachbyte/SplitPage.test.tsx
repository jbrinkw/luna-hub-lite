import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SplitPage } from '@/pages/coachbyte/SplitPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockSplits = [
  {
    split_id: 'sp-1',
    weekday: 1, // Monday
    template_sets: [
      { exercise_id: 'ex-1', exercise_name: 'Squat', reps: 5, load: 225, load_percentage: null, rest_seconds: 180, order: 1 },
      { exercise_id: 'ex-2', exercise_name: 'Bench Press', reps: 8, load: 185, load_percentage: null, rest_seconds: 120, order: 2 },
    ],
    split_notes: 'Push day',
  },
  {
    split_id: 'sp-2',
    weekday: 3, // Wednesday
    template_sets: [
      { exercise_id: 'ex-3', exercise_name: 'Deadlift', reps: 3, load: 315, load_percentage: null, rest_seconds: 300, order: 1 },
    ],
    split_notes: '',
  },
];

const mockExercises = [
  { exercise_id: 'ex-1', name: 'Squat' },
  { exercise_id: 'ex-2', name: 'Bench Press' },
  { exercise_id: 'ex-3', name: 'Deadlift' },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock — per-call chain objects                             */
/* ------------------------------------------------------------------ */

function getDataForTable(table: string) {
  if (table === 'exercises') return mockExercises;
  if (table === 'splits') return mockSplits;
  return null;
}

function makeChain(table: string) {
  const chain: any = {};
  const methods = ['select', 'eq', 'neq', 'order', 'or', 'single', 'update', 'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt'];
  methods.forEach(m => { chain[m] = vi.fn(() => chain); });
  chain.then = (resolve: any, _reject?: any) => {
    const result = { data: getDataForTable(table), error: null };
    return resolve(result);
  };
  return chain;
}

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: (table: string) => makeChain(table),
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
    <MemoryRouter initialEntries={['/coach/split']}>
      <SplitPage />
    </MemoryRouter>,
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('SplitPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the loading spinner while fetching data', () => {
    renderPage();
    expect(screen.getByTestId('split-loading')).toBeInTheDocument();
  });

  it('renders "WEEKLY SPLIT PLANNER" heading and weekday cards after loading', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('WEEKLY SPLIT PLANNER')).toBeInTheDocument();
    });
    // All 7 weekday cards should render
    for (let i = 0; i < 7; i++) {
      expect(screen.getByTestId(`day-${i}`)).toBeInTheDocument();
    }
  });

  it('renders exercise tables for days with splits', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('WEEKLY SPLIT PLANNER')).toBeInTheDocument();
    });
    // Monday (weekday 1) has exercises
    expect(screen.getByTestId('day-1-table')).toBeInTheDocument();
    expect(screen.getByTestId('day-1-set-0')).toBeInTheDocument();
    expect(screen.getByTestId('day-1-set-1')).toBeInTheDocument();

    // Wednesday (weekday 3) has exercises
    expect(screen.getByTestId('day-3-table')).toBeInTheDocument();
    expect(screen.getByTestId('day-3-set-0')).toBeInTheDocument();
  });

  it('shows "Rest day" for days with no exercises', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('WEEKLY SPLIT PLANNER')).toBeInTheDocument();
    });
    // Sunday (0), Tuesday (2), Thursday (4), Friday (5), Saturday (6) should be rest days
    expect(screen.getByTestId('day-0-empty')).toHaveTextContent('Rest day');
    expect(screen.getByTestId('day-2-empty')).toHaveTextContent('Rest day');
    expect(screen.getByTestId('day-4-empty')).toHaveTextContent('Rest day');
    expect(screen.getByTestId('day-5-empty')).toHaveTextContent('Rest day');
    expect(screen.getByTestId('day-6-empty')).toHaveTextContent('Rest day');
  });
});
