import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage, pctOf } from '@/pages/chefbyte/HomePage';

vi.mock('@/shared/auth/AuthProvider', () => {
  const mockUser = { id: 'u1' };
  return { useAuth: () => ({ user: mockUser, signOut: vi.fn() }) };
});

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockMacroData = {
  consumed: { calories: 1200, protein: 80, carbs: 150, fat: 40 },
  goals: { calories: 2000, protein: 150, carbs: 250, fats: 65 },
};

const mockMealPrep = [
  {
    meal_id: 'mp-1',
    servings: 2,
    recipes: { name: 'Overnight Oats' },
    products: null,
  },
  {
    meal_id: 'mp-2',
    servings: 1,
    recipes: null,
    products: { name: 'Protein Shake' },
  },
];

/* ------------------------------------------------------------------ */
/*  Table-based mock data                                              */
/* ------------------------------------------------------------------ */

const tableData: Record<string, any> = {
  // Missing prices: 3 products
  products_prices: [{ product_id: 'p1' }, { product_id: 'p2' }, { product_id: 'p3' }],
  // Placeholders: 1 product
  products_placeholders: [{ product_id: 'p4' }],
  // Products with min_stock: simulate below_min_stock count = 2
  products_min_stock: [
    { product_id: 'p1', min_stock_amount: 5 },
    { product_id: 'p2', min_stock_amount: 3 },
  ],
  // Stock lots for below-min check
  stock_lots: [{ qty_containers: 2 }],
  // Shopping list for cart value
  shopping_list: [
    { qty_containers: 2, products: { price: 4.99 } },
    { qty_containers: 1, products: { price: 12.50 } },
  ],
  // Meal prep entries
  meal_plan_entries: mockMealPrep,
  // User config
  user_config: null,
};

/* ------------------------------------------------------------------ */
/*  Supabase mock — track table + query context for routing data       */
/* ------------------------------------------------------------------ */

let lastTable = '';
let queryCtx = ''; // Track what kind of products query (prices, placeholders, min_stock)

const rpcImpl = () => Promise.resolve({ data: mockMacroData, error: null });
const mockRpc = vi.fn(rpcImpl);

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt',
  'gte', 'lte', 'upsert',
];
const thenImpl = (cb: any) => {
  let data: any = null;
  if (lastTable === 'products') {
    data = tableData[`products_${queryCtx}`] ?? [];
  } else if (lastTable === 'stock_lots') {
    data = tableData.stock_lots;
  } else if (lastTable === 'shopping_list') {
    data = tableData.shopping_list;
  } else if (lastTable === 'meal_plan_entries') {
    data = tableData.meal_plan_entries;
  } else {
    data = tableData[lastTable] ?? null;
  }
  return cb({ data, error: null });
};

chainMethods.forEach(m => {
  mockChain[m] = vi.fn((...args: any[]) => {
    // Track query context based on filter args
    if (m === 'is' && args[0] === 'price') queryCtx = 'prices';
    if (m === 'eq' && args[0] === 'is_placeholder' && args[1] === true) queryCtx = 'placeholders';
    if (m === 'gt' && args[0] === 'min_stock_amount') queryCtx = 'min_stock';
    return mockChain;
  });
});
mockChain.then = vi.fn(thenImpl);

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: (table: string) => {
        lastTable = table;
        queryCtx = '';
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
    <MemoryRouter initialEntries={['/chef/home']}>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Restore implementations
    mockRpc.mockImplementation(rpcImpl);
    chainMethods.forEach(m => {
      mockChain[m] = vi.fn((...args: any[]) => {
        if (m === 'is' && args[0] === 'price') queryCtx = 'prices';
        if (m === 'eq' && args[0] === 'is_placeholder' && args[1] === true) queryCtx = 'placeholders';
        if (m === 'gt' && args[0] === 'min_stock_amount') queryCtx = 'min_stock';
        return mockChain;
      });
    });
    mockChain.then = vi.fn(thenImpl);
    lastTable = '';
    queryCtx = '';
  });

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByTestId('home-loading')).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Status cards                                                     */
  /* ---------------------------------------------------------------- */

  it('renders status cards section', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('status-cards')).toBeInTheDocument();
    });
    expect(screen.getByTestId('card-missing-prices')).toBeInTheDocument();
    expect(screen.getByTestId('card-placeholders')).toBeInTheDocument();
    expect(screen.getByTestId('card-below-min')).toBeInTheDocument();
    expect(screen.getByTestId('card-cart-value')).toBeInTheDocument();
  });

  it('shows Missing Prices count', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('card-missing-prices')).toBeInTheDocument();
    });
    expect(screen.getByTestId('card-missing-prices')).toHaveTextContent('3');
    expect(screen.getByTestId('card-missing-prices')).toHaveTextContent('Missing Prices');
  });

  it('shows Placeholders count', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('card-placeholders')).toBeInTheDocument();
    });
    expect(screen.getByTestId('card-placeholders')).toHaveTextContent('1');
    expect(screen.getByTestId('card-placeholders')).toHaveTextContent('Placeholders');
  });

  it('shows Cart Value', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('card-cart-value')).toBeInTheDocument();
    });
    // 2 * 4.99 + 1 * 12.50 = 22.48
    expect(screen.getByTestId('card-cart-value')).toHaveTextContent('$22.48');
  });

  /* ---------------------------------------------------------------- */
  /*  Macro summary                                                    */
  /* ---------------------------------------------------------------- */

  it('renders compact macro summary', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('macro-summary')).toBeInTheDocument();
    });
    expect(screen.getByTestId('compact-calories')).toBeInTheDocument();
    expect(screen.getByTestId('compact-protein')).toBeInTheDocument();
    expect(screen.getByTestId('compact-carbs')).toBeInTheDocument();
    expect(screen.getByTestId('compact-fats')).toBeInTheDocument();
  });

  it('shows macro values from RPC', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('compact-calories')).toBeInTheDocument();
    });
    expect(screen.getByTestId('compact-calories')).toHaveTextContent('1200/2000');
    expect(screen.getByTestId('compact-protein')).toHaveTextContent('80g/150g');
    expect(screen.getByTestId('compact-carbs')).toHaveTextContent('150g/250g');
    expect(screen.getByTestId('compact-fats')).toHaveTextContent('40g/65g');
  });

  /* ---------------------------------------------------------------- */
  /*  Quick actions                                                    */
  /* ---------------------------------------------------------------- */

  it('renders quick action buttons', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('quick-actions')).toBeInTheDocument();
    });
    expect(screen.getByTestId('import-shopping-btn')).toHaveTextContent('Import Shopping');
    expect(screen.getByTestId('target-macros-btn')).toHaveTextContent('Target Macros');
    expect(screen.getByTestId('taste-profile-btn')).toHaveTextContent('Taste Profile');
    expect(screen.getByTestId('meal-plan-cart-btn')).toHaveTextContent('Meal Plan');
  });

  /* ---------------------------------------------------------------- */
  /*  Meal prep section                                                */
  /* ---------------------------------------------------------------- */

  it('renders meal prep section with entries', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('meal-prep-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('prep-entry-mp-1')).toHaveTextContent('Overnight Oats');
    expect(screen.getByTestId('prep-entry-mp-1')).toHaveTextContent('2 servings');
    expect(screen.getByTestId('prep-entry-mp-2')).toHaveTextContent('Protein Shake');
    expect(screen.getByTestId('prep-entry-mp-2')).toHaveTextContent('1 serving');
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
    expect(screen.getByTestId('target-macros-modal')).toHaveTextContent('Target Macros');
  });

  it('closes Target Macros modal on Cancel', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('target-macros-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('target-macros-btn'));
    expect(screen.getByTestId('target-macros-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('target-cancel-btn'));
    expect(screen.queryByTestId('target-macros-modal')).not.toBeInTheDocument();
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
    expect(screen.getByTestId('taste-modal')).toHaveTextContent('Taste Profile');
  });

  it('closes Taste Profile modal on Cancel', async () => {
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

  /* ---------------------------------------------------------------- */
  /*  RPC verification                                                 */
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

describe('pctOf', () => {
  it('calculates percentage correctly', () => {
    expect(pctOf(50, 100)).toBe(50);
    expect(pctOf(100, 100)).toBe(100);
  });

  it('caps at 100%', () => {
    expect(pctOf(200, 100)).toBe(100);
  });

  it('returns 0 for zero goal', () => {
    expect(pctOf(50, 0)).toBe(0);
  });

  it('returns 0 for negative goal', () => {
    expect(pctOf(50, -10)).toBe(0);
  });

  it('rounds correctly', () => {
    // 1/3 * 100 = 33.33... → 33
    expect(pctOf(1, 3)).toBe(33);
  });
});
