import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { epley1RM, PrsPage } from '@/pages/coachbyte/PrsPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockCompletedSets = [
  { exercise_id: 'ex-1', actual_reps: 5, actual_load: 225, exercises: { name: 'Squat' } },
  { exercise_id: 'ex-1', actual_reps: 3, actual_load: 275, exercises: { name: 'Squat' } },
  { exercise_id: 'ex-2', actual_reps: 8, actual_load: 185, exercises: { name: 'Bench Press' } },
];

const mockExercises = [
  { exercise_id: 'ex-1', name: 'Squat' },
  { exercise_id: 'ex-2', name: 'Bench Press' },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock — per-call chain objects to avoid shared state       */
/* ------------------------------------------------------------------ */

let completedSetsData: any[] | null = mockCompletedSets;

function getDataForTable(table: string) {
  if (table === 'exercises') return mockExercises;
  if (table === 'completed_sets') return completedSetsData;
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
    <MemoryRouter initialEntries={['/coach/prs']}>
      <PrsPage />
    </MemoryRouter>,
  );
}

/* ------------------------------------------------------------------ */
/*  Pure function tests                                                */
/* ------------------------------------------------------------------ */

describe('epley1RM', () => {
  it('returns 0 for 0 reps', () => {
    expect(epley1RM(225, 0)).toBe(0);
  });

  it('returns 0 for 0 load', () => {
    expect(epley1RM(0, 5)).toBe(0);
  });

  it('returns load directly for 1 rep', () => {
    expect(epley1RM(315, 1)).toBe(315);
  });

  it('calculates Epley for 5 reps at 225', () => {
    // 225 × (1 + 5/30) = 225 × 1.1667 ≈ 263
    expect(epley1RM(225, 5)).toBe(263);
  });

  it('calculates Epley for 10 reps at 185', () => {
    // 185 × (1 + 10/30) = 185 × 1.3333 ≈ 247
    expect(epley1RM(185, 10)).toBe(247);
  });

  it('calculates Epley for 3 reps at 315', () => {
    // 315 × (1 + 3/30) = 315 × 1.1 = 347
    expect(epley1RM(315, 3)).toBe(347);
  });
});

/* ------------------------------------------------------------------ */
/*  Rendering tests                                                    */
/* ------------------------------------------------------------------ */

describe('PrsPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    completedSetsData = mockCompletedSets;
  });

  it('renders "PR TRACKER" heading after loading', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('PR TRACKER')).toBeInTheDocument();
    });
  });

  it('renders PR cards with exercise names when completed sets exist', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('pr-card-ex-1')).toBeInTheDocument();
    });
    // Squat and Bench Press should appear (uppercased in the card title)
    expect(screen.getByTestId('pr-name-ex-1')).toHaveTextContent('SQUAT');
    expect(screen.getByTestId('pr-card-ex-2')).toBeInTheDocument();
    expect(screen.getByTestId('pr-name-ex-2')).toHaveTextContent('BENCH PRESS');
  });

  it('shows e1RM values on PR cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('pr-e1rm-ex-1')).toBeInTheDocument();
    });
    // Squat best: max of epley(225,5)=263, epley(275,3)=303 → 303
    expect(screen.getByTestId('pr-e1rm-ex-1')).toHaveTextContent('e1RM: 303');
    // Bench: epley(185,8)=234
    expect(screen.getByTestId('pr-e1rm-ex-2')).toHaveTextContent('e1RM: 234');
  });

  it('shows "No PRs recorded" message when no completed sets exist', async () => {
    completedSetsData = [];
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('no-prs')).toBeInTheDocument();
    });
    expect(screen.getByTestId('no-prs')).toHaveTextContent('No PRs recorded');
  });
});
