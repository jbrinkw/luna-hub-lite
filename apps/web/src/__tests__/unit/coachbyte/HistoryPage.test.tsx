import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HistoryPage } from '@/pages/coachbyte/HistoryPage';

const mockUser = { id: 'u1' };
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: mockUser, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockPlans = [
  { plan_id: 'plan-1', plan_date: '2026-03-01', summary: 'Leg Day' },
  { plan_id: 'plan-2', plan_date: '2026-02-28', summary: null },
];

const mockPlannedSets = [
  { plan_id: 'plan-1' },
  { plan_id: 'plan-1' },
  { plan_id: 'plan-1' },
  { plan_id: 'plan-2' },
  { plan_id: 'plan-2' },
];

const mockCompletedSets = [
  { plan_id: 'plan-1' },
  { plan_id: 'plan-1' },
  { plan_id: 'plan-2' },
];

const mockExercises = [
  { exercise_id: 'ex-1', name: 'Squat' },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock — per-call chain objects                             */
/* ------------------------------------------------------------------ */

let plansData: any[] | null = mockPlans;

function getDataForTable(table: string) {
  if (table === 'exercises') return mockExercises;
  if (table === 'daily_plans') return plansData;
  if (table === 'planned_sets') return mockPlannedSets;
  if (table === 'completed_sets') return mockCompletedSets;
  return null;
}

function makeChain(table: string) {
  const chain: any = {};
  const methods = ['select', 'eq', 'neq', 'order', 'or', 'single', 'update', 'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt'];
  methods.forEach(m => { chain[m] = vi.fn(() => chain); });
  // Support both `await chain` (thenable) and `.then(cb)` usage
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
    <MemoryRouter initialEntries={['/coach/history']}>
      <HistoryPage />
    </MemoryRouter>,
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('HistoryPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    plansData = mockPlans;
  });

  it('renders the HISTORY heading', () => {
    renderPage();
    expect(screen.getByText('HISTORY')).toBeInTheDocument();
  });

  it('renders filter select', () => {
    renderPage();
    expect(screen.getByTestId('exercise-filter')).toBeInTheDocument();
  });

  it('renders history table with dates and summaries when data exists', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('history-table')).toBeInTheDocument();
    });
    // Verify first row shows date and summary
    const row1 = screen.getByTestId('history-row-2026-03-01');
    expect(row1).toHaveTextContent('2026-03-01');
    expect(row1).toHaveTextContent('Leg Day');
    expect(row1).toHaveTextContent('2/3'); // 2 completed out of 3 planned

    // Second row has null summary, should show dash
    const row2 = screen.getByTestId('history-row-2026-02-28');
    expect(row2).toHaveTextContent('2026-02-28');
    expect(row2).toHaveTextContent('—');
    expect(row2).toHaveTextContent('1/2'); // 1 completed out of 2 planned
  });

  it('shows "No workout history yet" when no plans exist', async () => {
    plansData = [];
    renderPage();
    await waitFor(() => {
      const el = screen.getByTestId('no-history');
      expect(el).toBeInTheDocument();
      expect(el).toHaveTextContent('No workout history yet');
    }, { timeout: 3000 });
  });

  it('shows "Load More" button when there are more than PAGE_SIZE results', async () => {
    // The component fetches PAGE_SIZE+1 (21) items; if it gets 21 it knows there's more
    plansData = Array.from({ length: 21 }, (_, i) => ({
      plan_id: `plan-${i}`,
      plan_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      summary: `Day ${i + 1}`,
    }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('load-more-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-more-btn')).toHaveTextContent('Load More');
  });
});
