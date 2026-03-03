import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MacroPage, calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockMacroData = {
  consumed: { calories: 1200, protein: 80, carbs: 150, fat: 40 },
  goals: { calories: 2000, protein: 150, carbs: 250, fats: 65 },
};

const mockFoodLogs = [
  {
    log_id: 'fl-1',
    product_id: null,
    recipe_id: 'r1',
    calories: 310,
    protein: 28,
    carbs: 22,
    fat: 8,
    recipes: { name: 'Yogurt Bowl' },
    products: null,
  },
  {
    log_id: 'fl-2',
    product_id: 'p1',
    recipe_id: null,
    calories: 500,
    protein: 24,
    carbs: 60,
    fat: 20,
    recipes: null,
    products: { name: 'Protein Bar' },
  },
];

const mockTempItems = [
  {
    temp_id: 'ti-1',
    name: 'Coffee w/ cream',
    calories: 80,
    protein: 2,
    carbs: 4,
    fat: 6,
  },
];

const mockLtEvents = [
  {
    event_id: 'lt-1',
    calories: 120,
    protein: 10,
    carbs: 15,
    fat: 3,
  },
];

const mockPlannedMeals = [
  {
    meal_id: 'mp-1',
    servings: 2,
    recipes: {
      name: 'Chicken Stir Fry',
      calories_per_serving: 210,
      protein_per_serving: 19,
      carbs_per_serving: 16,
      fat_per_serving: 7,
    },
    products: null,
  },
];

/* ------------------------------------------------------------------ */
/*  Table-based mock data                                              */
/* ------------------------------------------------------------------ */

const tableData: Record<string, any> = {
  food_logs: mockFoodLogs,
  temp_items: mockTempItems,
  liquidtrack_events: mockLtEvents,
  meal_plan_entries: mockPlannedMeals,
  user_config: null,
};

/* ------------------------------------------------------------------ */
/*  Supabase mock — chain pattern matching other ChefByte tests        */
/* ------------------------------------------------------------------ */

let lastTable = '';

const rpcImpl = () => Promise.resolve({ data: mockMacroData, error: null });
const mockRpc = vi.fn(rpcImpl);

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt',
  'gte', 'lte', 'upsert',
];
const thenImpl = (cb: any) => {
  const data = tableData[lastTable] ?? null;
  return cb({ data, error: null });
};
chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });
mockChain.then = vi.fn(thenImpl);

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: (table: string) => {
        lastTable = table;
        return mockChain;
      },
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
    <MemoryRouter initialEntries={['/chef/macros']}>
      <MacroPage />
    </MemoryRouter>,
  );
}

describe('MacroPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Restore implementations after clearAllMocks (prevents hanging awaits in pending loadData)
    mockRpc.mockImplementation(rpcImpl);
    chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });
    mockChain.then = vi.fn(thenImpl);
    lastTable = '';
  });

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByTestId('macro-loading')).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Date navigation                                                  */
  /* ---------------------------------------------------------------- */

  it('shows date navigation with prev/today/next buttons', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('date-nav')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prev-date-btn')).toHaveTextContent('Prev');
    expect(screen.getByTestId('today-date-btn')).toHaveTextContent('Today');
    expect(screen.getByTestId('next-date-btn')).toHaveTextContent('Next');
    expect(screen.getByTestId('current-date')).toBeInTheDocument();
  });

  it('displays the current date', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('current-date')).toBeInTheDocument();
    });
    const dateText = screen.getByTestId('current-date').textContent;
    expect(dateText).toBeTruthy();
    expect(dateText!.length).toBeGreaterThan(0);
  });

  it('navigates to previous date when Prev is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('date-nav')).toBeInTheDocument();
    });

    // First go forward so we have a known reference, then go backward
    fireEvent.click(screen.getByTestId('next-date-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('current-date')).toBeInTheDocument();
    });

    // Capture the "tomorrow" date text, then click Prev to go back to today
    const tomorrowText = screen.getByTestId('current-date').textContent!;
    fireEvent.click(screen.getByTestId('prev-date-btn'));

    await waitFor(() => {
      const afterPrev = screen.getByTestId('current-date').textContent;
      expect(afterPrev).not.toBe(tomorrowText);
    });

    // Parse the day numbers from the displayed date strings to verify backward direction.
    // formatDateDisplay outputs e.g. "Tue, Mar 3" — extract the numeric day.
    const dayMatch = (text: string) => {
      const m = text.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : NaN;
    };
    const tomorrowDay = dayMatch(tomorrowText);
    const currentDay = dayMatch(screen.getByTestId('current-date').textContent!);
    // The day after Prev should be less than the day before Prev (handles month boundaries by checking != )
    // More precisely, Prev from tomorrow should return to today
    expect(currentDay).not.toBe(tomorrowDay);
    // The date should have gone backward: today's day number is less than tomorrow's
    // (unless month boundary, in which case they're simply different, which we already asserted)
    if (tomorrowDay > 1) {
      expect(currentDay).toBe(tomorrowDay - 1);
    }
  });

  it('navigates to next date when Next is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('date-nav')).toBeInTheDocument();
    });

    const dateBefore = screen.getByTestId('current-date').textContent;
    fireEvent.click(screen.getByTestId('next-date-btn'));

    await waitFor(() => {
      const dateAfter = screen.getByTestId('current-date').textContent;
      expect(dateAfter).not.toBe(dateBefore);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Progress bars                                                    */
  /* ---------------------------------------------------------------- */

  it('renders macro summary with 4 progress bars', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('macro-summary')).toBeInTheDocument();
    });
    expect(screen.getByTestId('progress-calories')).toBeInTheDocument();
    expect(screen.getByTestId('progress-protein')).toBeInTheDocument();
    expect(screen.getByTestId('progress-carbs')).toBeInTheDocument();
    expect(screen.getByTestId('progress-fats')).toBeInTheDocument();
  });

  it('shows consumed/goal values in progress bars', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('progress-calories')).toBeInTheDocument();
    });
    expect(screen.getByTestId('progress-calories')).toHaveTextContent('1200 / 2000');
    expect(screen.getByTestId('progress-calories')).toHaveTextContent('60%');
    expect(screen.getByTestId('progress-protein')).toHaveTextContent('80g / 150g');
    expect(screen.getByTestId('progress-protein')).toHaveTextContent('53%');
    expect(screen.getByTestId('progress-carbs')).toHaveTextContent('150g / 250g');
    expect(screen.getByTestId('progress-carbs')).toHaveTextContent('60%');
    expect(screen.getByTestId('progress-fats')).toHaveTextContent('40g / 65g');
    expect(screen.getByTestId('progress-fats')).toHaveTextContent('62%');
  });

  /* ---------------------------------------------------------------- */
  /*  Consumed items table                                             */
  /* ---------------------------------------------------------------- */

  it('renders consumed items section with table', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('consumed-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('consumed-table')).toBeInTheDocument();
  });

  it('shows consumed item rows with correct data', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('consumed-table')).toBeInTheDocument();
    });

    const row1 = screen.getByTestId('consumed-row-fl-1');
    expect(row1).toHaveTextContent('Meal Plan');
    expect(row1).toHaveTextContent('Yogurt Bowl');
    expect(row1).toHaveTextContent('310');
    expect(row1).toHaveTextContent('28g');

    const row2 = screen.getByTestId('consumed-row-fl-2');
    expect(row2).toHaveTextContent('Meal Plan');
    expect(row2).toHaveTextContent('Protein Bar');

    const row3 = screen.getByTestId('consumed-row-ti-1');
    expect(row3).toHaveTextContent('Temp Item');
    expect(row3).toHaveTextContent('Coffee w/ cream');
    expect(row3).toHaveTextContent('80');

    const row4 = screen.getByTestId('consumed-row-lt-1');
    expect(row4).toHaveTextContent('LiquidTrack');
    expect(row4).toHaveTextContent('Liquid intake');
    expect(row4).toHaveTextContent('120');
  });

  it('shows consumed table header columns', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('consumed-table')).toBeInTheDocument();
    });
    const table = screen.getByTestId('consumed-table');
    expect(table).toHaveTextContent('Source');
    expect(table).toHaveTextContent('Item');
    expect(table).toHaveTextContent('Cal');
  });

  /* ---------------------------------------------------------------- */
  /*  Planned items                                                    */
  /* ---------------------------------------------------------------- */

  it('renders planned items section', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('planned-section')).toBeInTheDocument();
    });
  });

  it('shows planned item rows with estimated macros', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('planned-section')).toBeInTheDocument();
    });

    const row = screen.getByTestId('planned-row-mp-1');
    expect(row).toHaveTextContent('Chicken Stir Fry');
    expect(row).toHaveTextContent('420');
    expect(row).toHaveTextContent('38g');
    expect(row).toHaveTextContent('32g');
    expect(row).toHaveTextContent('14g');
  });

  /* ---------------------------------------------------------------- */
  /*  Action buttons                                                   */
  /* ---------------------------------------------------------------- */

  it('shows action buttons for temp item, targets, and taste profile', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('log-temp-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('log-temp-btn')).toHaveTextContent('Log Temp Item');
    expect(screen.getByTestId('target-macros-btn')).toHaveTextContent('Edit Targets');
    expect(screen.getByTestId('taste-profile-btn')).toHaveTextContent('Taste Profile');
  });

  /* ---------------------------------------------------------------- */
  /*  Temp Item modal                                                  */
  /* ---------------------------------------------------------------- */

  it('opens Log Temp Item modal when button is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('log-temp-btn')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('temp-item-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('log-temp-btn'));

    expect(screen.getByTestId('temp-item-modal')).toBeInTheDocument();
    expect(screen.getByTestId('temp-name')).toBeInTheDocument();
    expect(screen.getByTestId('temp-calories')).toBeInTheDocument();
    expect(screen.getByTestId('temp-protein')).toBeInTheDocument();
    expect(screen.getByTestId('temp-carbs')).toBeInTheDocument();
    expect(screen.getByTestId('temp-fat')).toBeInTheDocument();
    expect(screen.getByTestId('temp-save-btn')).toBeInTheDocument();
    expect(screen.getByTestId('temp-cancel-btn')).toBeInTheDocument();
  });

  it('closes Temp Item modal when Cancel is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('log-temp-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('log-temp-btn'));
    expect(screen.getByTestId('temp-item-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('temp-cancel-btn'));
    expect(screen.queryByTestId('temp-item-modal')).not.toBeInTheDocument();
  });

  it('shows modal title for Log Temp Item', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('log-temp-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('log-temp-btn'));
    expect(screen.getByTestId('temp-item-modal')).toHaveTextContent('Log Temp Item');
  });

  /* ---------------------------------------------------------------- */
  /*  Target Macros modal                                              */
  /* ---------------------------------------------------------------- */

  it('opens Target Macros modal when button is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('target-macros-btn')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('target-macros-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('target-macros-btn'));

    expect(screen.getByTestId('target-macros-modal')).toBeInTheDocument();
    expect(screen.getByTestId('target-protein')).toBeInTheDocument();
    expect(screen.getByTestId('target-carbs')).toBeInTheDocument();
    expect(screen.getByTestId('target-fats')).toBeInTheDocument();
    expect(screen.getByTestId('target-calories')).toBeInTheDocument();
    expect(screen.getByTestId('target-save-btn')).toBeInTheDocument();
    expect(screen.getByTestId('target-cancel-btn')).toBeInTheDocument();
  });

  it('closes Target Macros modal when Cancel is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('target-macros-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('target-macros-btn'));
    expect(screen.getByTestId('target-macros-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('target-cancel-btn'));
    expect(screen.queryByTestId('target-macros-modal')).not.toBeInTheDocument();
  });

  it('shows auto-calculated calories in Target Macros modal', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('target-macros-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('target-macros-btn'));

    const caloriesDisplay = screen.getByTestId('target-calories');
    expect(caloriesDisplay).toHaveTextContent('2185');
    expect(caloriesDisplay).toHaveTextContent('protein*4 + carbs*4 + fats*9');
  });

  it('shows modal title for Target Macros', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('target-macros-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('target-macros-btn'));
    expect(screen.getByTestId('target-macros-modal')).toHaveTextContent('Target Macros');
  });

  /* ---------------------------------------------------------------- */
  /*  Taste Profile modal                                              */
  /* ---------------------------------------------------------------- */

  it('opens Taste Profile modal when button is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('taste-profile-btn')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('taste-modal')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('taste-profile-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('taste-modal')).toBeInTheDocument();
    });
    expect(screen.getByTestId('taste-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('taste-save-btn')).toBeInTheDocument();
    expect(screen.getByTestId('taste-cancel-btn')).toBeInTheDocument();
  });

  it('closes Taste Profile modal when Cancel is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('taste-profile-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('taste-profile-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('taste-modal')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('taste-cancel-btn'));
    expect(screen.queryByTestId('taste-modal')).not.toBeInTheDocument();
  });

  it('shows modal title for Taste Profile', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('taste-profile-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('taste-profile-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('taste-modal')).toBeInTheDocument();
    });
    expect(screen.getByTestId('taste-modal')).toHaveTextContent('Taste Profile');
  });

  /* ---------------------------------------------------------------- */
  /*  RPC call verification                                            */
  /* ---------------------------------------------------------------- */

  it('calls get_daily_macros RPC on load', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('macro-summary')).toBeInTheDocument();
    });
    expect(mockRpc).toHaveBeenCalledWith('get_daily_macros', expect.objectContaining({
      p_logical_date: expect.any(String),
    }));
  });
});

/* ------------------------------------------------------------------ */
/*  Pure function tests                                                */
/* ------------------------------------------------------------------ */

describe('calcCaloriesFromMacros', () => {
  it('correctly calculates calories from macros', () => {
    expect(calcCaloriesFromMacros(150, 250, 65)).toBe(2185);
  });

  it('returns 0 when all macros are 0', () => {
    expect(calcCaloriesFromMacros(0, 0, 0)).toBe(0);
  });

  it('handles protein only', () => {
    expect(calcCaloriesFromMacros(100, 0, 0)).toBe(400);
  });

  it('handles carbs only', () => {
    expect(calcCaloriesFromMacros(0, 200, 0)).toBe(800);
  });

  it('handles fats only', () => {
    expect(calcCaloriesFromMacros(0, 0, 50)).toBe(450);
  });

  it('correctly weights fat at 9 cal/g vs protein/carbs at 4 cal/g', () => {
    expect(calcCaloriesFromMacros(10, 10, 10)).toBe(170);
  });
});
