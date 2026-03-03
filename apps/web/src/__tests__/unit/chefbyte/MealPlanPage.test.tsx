import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MealPlanPage, getMonday } from '@/pages/chefbyte/MealPlanPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockMeals = [
  {
    meal_id: 'm1',
    user_id: 'u1',
    recipe_id: 'r1',
    product_id: null,
    logical_date: '2026-03-02',
    servings: 1,
    meal_prep: false,
    completed_at: '2026-03-02T11:30:00Z',
    recipes: { name: 'Yogurt Bowl' },
    products: null,
  },
  {
    meal_id: 'm2',
    user_id: 'u1',
    recipe_id: 'r2',
    product_id: null,
    logical_date: '2026-03-02',
    servings: 2,
    meal_prep: false,
    completed_at: null,
    recipes: { name: 'Chicken Stir Fry' },
    products: null,
  },
  {
    meal_id: 'm3',
    user_id: 'u1',
    recipe_id: null,
    product_id: 'p1',
    logical_date: '2026-03-04',
    servings: 1,
    meal_prep: true,
    completed_at: null,
    recipes: null,
    products: { name: 'Protein Shake' },
  },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock — chain pattern matching other ChefByte tests        */
/* ------------------------------------------------------------------ */

const mockRpc = vi.fn(() => Promise.resolve({ data: null, error: null }));

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt',
  'gte', 'lte', 'upsert',
];
chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });
mockChain.then = vi.fn((cb: any) => cb({ data: mockMeals, error: null }));

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: () => mockChain,
      rpc: mockRpc,
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
    <MemoryRouter initialEntries={['/chef/meal-plan']}>
      <MealPlanPage />
    </MemoryRouter>,
  );
}

describe('MealPlanPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByTestId('mealplan-loading')).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Week navigation                                                  */
  /* ---------------------------------------------------------------- */

  it('shows week navigation with prev/today/next buttons', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-nav')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prev-week-btn')).toHaveTextContent('Prev');
    expect(screen.getByTestId('today-btn')).toHaveTextContent('Today');
    expect(screen.getByTestId('next-week-btn')).toHaveTextContent('Next');
    expect(screen.getByTestId('week-range')).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  7-day grid                                                       */
  /* ---------------------------------------------------------------- */

  it('shows 7 day columns in the grid', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });
    // There should be exactly 7 day columns
    const grid = screen.getByTestId('week-grid');
    const cols = grid.querySelectorAll('[data-testid^="day-col-"]');
    expect(cols).toHaveLength(7);
  });

  it('shows meal names in day slots', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });
    // The mock meals should appear in the grid
    expect(screen.getByTestId('grid-meal-m1')).toHaveTextContent('Yogurt Bowl');
    expect(screen.getByTestId('grid-meal-m2')).toHaveTextContent('Chicken Stir Fry');
    expect(screen.getByTestId('grid-meal-m3')).toHaveTextContent('Protein Shake');
  });

  /* ---------------------------------------------------------------- */
  /*  Status badges                                                    */
  /* ---------------------------------------------------------------- */

  it('shows [done] badge for completed meals', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('grid-meal-m1')).toBeInTheDocument();
    });
    // m1 has completed_at set
    expect(screen.getByTestId('done-badge-m1')).toBeInTheDocument();
    expect(screen.getByTestId('done-badge-m1')).toHaveTextContent('done');
    // m2 is not completed — no done badge
    expect(screen.queryByTestId('done-badge-m2')).not.toBeInTheDocument();
  });

  it('shows [PREP] badge for meal prep entries', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('grid-meal-m3')).toBeInTheDocument();
    });
    // m3 is meal_prep and not completed
    expect(screen.getByTestId('prep-badge-m3')).toBeInTheDocument();
    expect(screen.getByTestId('prep-badge-m3')).toHaveTextContent('PREP');
    // m1/m2 are not meal_prep
    expect(screen.queryByTestId('prep-badge-m1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prep-badge-m2')).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Day detail                                                       */
  /* ---------------------------------------------------------------- */

  it('shows day detail table when a day is selected', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });
    // Day detail should not be visible before selection
    expect(screen.queryByTestId('day-detail')).not.toBeInTheDocument();

    // Click a day column that has meals (2026-03-02)
    fireEvent.click(screen.getByTestId('day-col-2026-03-02'));

    await waitFor(() => {
      expect(screen.getByTestId('day-detail')).toBeInTheDocument();
    });
    expect(screen.getByTestId('day-detail-table')).toBeInTheDocument();
    expect(screen.getByTestId('detail-row-m1')).toBeInTheDocument();
    expect(screen.getByTestId('detail-row-m2')).toBeInTheDocument();
    // m1 is completed — should show DONE with time
    expect(screen.getByTestId('detail-row-m1')).toHaveTextContent('DONE');
    // m2 is planned
    expect(screen.getByTestId('detail-row-m2')).toHaveTextContent('Planned');
  });

  /* ---------------------------------------------------------------- */
  /*  Add meal button                                                  */
  /* ---------------------------------------------------------------- */

  it('shows Add Meal button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('add-meal-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('add-meal-btn')).toHaveTextContent('+ Add Meal');
  });

  /* ---------------------------------------------------------------- */
  /*  Mark Done button                                                 */
  /* ---------------------------------------------------------------- */

  it('shows Mark Done button for planned entries in day detail', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    // Select the day with planned meal m2
    fireEvent.click(screen.getByTestId('day-col-2026-03-02'));

    await waitFor(() => {
      expect(screen.getByTestId('day-detail')).toBeInTheDocument();
    });

    // m2 is planned — should have Mark Done
    expect(screen.getByTestId('mark-done-m2')).toBeInTheDocument();
    expect(screen.getByTestId('mark-done-m2')).toHaveTextContent('Mark Done');
    // m1 is completed — should NOT have Mark Done
    expect(screen.queryByTestId('mark-done-m1')).not.toBeInTheDocument();
  });

  it('calls mark_meal_done RPC when Mark Done is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    // Select the day with planned meal m2
    fireEvent.click(screen.getByTestId('day-col-2026-03-02'));

    await waitFor(() => {
      expect(screen.getByTestId('mark-done-m2')).toBeInTheDocument();
    });

    mockRpc.mockClear();
    fireEvent.click(screen.getByTestId('mark-done-m2'));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mark_meal_done', { p_meal_id: 'm2' });
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Delete button for planned entries                                */
  /* ---------------------------------------------------------------- */

  it('shows Delete button for planned entries', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('day-col-2026-03-02'));

    await waitFor(() => {
      expect(screen.getByTestId('day-detail')).toBeInTheDocument();
    });

    // m2 is planned — should have Delete button
    expect(screen.getByTestId('delete-meal-m2')).toBeInTheDocument();
    expect(screen.getByTestId('delete-meal-m2')).toHaveTextContent('Delete');
    // m1 is completed — should show dash, no delete
    expect(screen.queryByTestId('delete-meal-m1')).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Execute Prep button for meal_prep entries                        */
  /* ---------------------------------------------------------------- */

  it('shows Execute Prep button for planned meal_prep entries', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    // Select the day with meal_prep entry m3 (2026-03-04)
    fireEvent.click(screen.getByTestId('day-col-2026-03-04'));

    await waitFor(() => {
      expect(screen.getByTestId('day-detail')).toBeInTheDocument();
    });

    expect(screen.getByTestId('exec-prep-m3')).toBeInTheDocument();
    expect(screen.getByTestId('exec-prep-m3')).toHaveTextContent('Execute Prep');
  });

  /* ---------------------------------------------------------------- */
  /*  Meal prep confirmation modal                                     */
  /* ---------------------------------------------------------------- */

  it('shows meal prep confirmation modal when Execute Prep is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('day-col-2026-03-04'));

    await waitFor(() => {
      expect(screen.getByTestId('exec-prep-m3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('exec-prep-m3'));

    await waitFor(() => {
      expect(screen.getByTestId('prep-confirm-modal')).toBeInTheDocument();
    });

    expect(screen.getByTestId('prep-confirm-modal')).toHaveTextContent('Execute Meal Prep');
    expect(screen.getByTestId('prep-confirm-modal')).toHaveTextContent('Protein Shake');
    expect(screen.getByTestId('prep-confirm-modal')).toHaveTextContent('[MEAL] lot');
    expect(screen.getByTestId('prep-execute-btn')).toHaveTextContent('Execute');
    expect(screen.getByTestId('prep-cancel-btn')).toHaveTextContent('Cancel');
  });

  /* ---------------------------------------------------------------- */
  /*  Day detail: Mode column                                          */
  /* ---------------------------------------------------------------- */

  it('shows Regular/Prep mode in day detail', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('day-col-2026-03-02'));

    await waitFor(() => {
      expect(screen.getByTestId('day-detail-table')).toBeInTheDocument();
    });

    // m1 and m2 are not meal_prep — show Regular
    expect(screen.getByTestId('detail-row-m1')).toHaveTextContent('Regular');
    expect(screen.getByTestId('detail-row-m2')).toHaveTextContent('Regular');
  });

  it('shows Prep mode for meal_prep entries in day detail', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('day-col-2026-03-04'));

    await waitFor(() => {
      expect(screen.getByTestId('day-detail-table')).toBeInTheDocument();
    });

    expect(screen.getByTestId('detail-row-m3')).toHaveTextContent('Prep');
  });

  /* ---------------------------------------------------------------- */
  /*  Empty day message                                                */
  /* ---------------------------------------------------------------- */

  it('shows "No meals planned" message when selecting empty day', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('week-grid')).toBeInTheDocument();
    });

    // Click a day that has no meals (2026-03-03, Tuesday)
    fireEvent.click(screen.getByTestId('day-col-2026-03-03'));

    await waitFor(() => {
      expect(screen.getByTestId('day-detail')).toBeInTheDocument();
    });

    expect(screen.getByTestId('no-meals')).toBeInTheDocument();
    expect(screen.getByTestId('no-meals')).toHaveTextContent('No meals planned for this day');
  });
});

/* ------------------------------------------------------------------ */
/*  Pure function tests                                                */
/* ------------------------------------------------------------------ */

describe('getMonday', () => {
  it('returns Monday for a Wednesday input', () => {
    // 2026-03-04 is a Wednesday
    const wed = new Date(2026, 2, 4);
    const mon = getMonday(wed);
    expect(mon.getDay()).toBe(1); // Monday
    expect(mon.getDate()).toBe(2); // March 2
  });

  it('returns same day if input is already Monday', () => {
    // 2026-03-02 is a Monday
    const mon = new Date(2026, 2, 2);
    const result = getMonday(mon);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(2);
  });

  it('returns previous Monday for a Sunday', () => {
    // 2026-03-08 is a Sunday
    const sun = new Date(2026, 2, 8);
    const mon = getMonday(sun);
    expect(mon.getDay()).toBe(1);
    expect(mon.getDate()).toBe(2); // March 2
  });
});
