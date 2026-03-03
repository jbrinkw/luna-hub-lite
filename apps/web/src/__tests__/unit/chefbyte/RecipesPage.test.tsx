import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecipesPage, computeRecipeMacros } from '@/pages/chefbyte/RecipesPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockRecipes = [
  {
    recipe_id: 'r1',
    user_id: 'u1',
    name: 'Chicken Stir Fry',
    description: 'Quick stir fry',
    base_servings: 2,
    active_time: 15,
    total_time: 25,
    instructions: 'Cook it',
    recipe_ingredients: [
      {
        ingredient_id: 'i1',
        quantity: 2,
        unit: 'serving',
        note: null,
        products: {
          name: 'Chicken Breast',
          calories_per_serving: 165,
          carbs_per_serving: 0,
          protein_per_serving: 31,
          fat_per_serving: 3.6,
          servings_per_container: 4,
        },
      },
      {
        ingredient_id: 'i2',
        quantity: 1,
        unit: 'container',
        note: 'frozen',
        products: {
          name: 'Mixed Vegetables',
          calories_per_serving: 60,
          carbs_per_serving: 12,
          protein_per_serving: 2,
          fat_per_serving: 0,
          servings_per_container: 3,
        },
      },
    ],
  },
  {
    recipe_id: 'r2',
    user_id: 'u1',
    name: 'Overnight Oats',
    description: null,
    base_servings: 1,
    active_time: 5,
    total_time: 480,
    instructions: null,
    recipe_ingredients: [
      {
        ingredient_id: 'i3',
        quantity: 1,
        unit: 'serving',
        note: null,
        products: {
          name: 'Oats',
          calories_per_serving: 150,
          carbs_per_serving: 27,
          protein_per_serving: 5,
          fat_per_serving: 3,
          servings_per_container: 10,
        },
      },
    ],
  },
  {
    recipe_id: 'r3',
    user_id: 'u1',
    name: 'Protein Shake',
    description: null,
    base_servings: 1,
    active_time: null,
    total_time: null,
    instructions: null,
    recipe_ingredients: [],
  },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock — chain pattern matching other ChefByte tests        */
/* ------------------------------------------------------------------ */

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt',
];
chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });
mockChain.then = vi.fn((cb: any) => cb({ data: mockRecipes, error: null }));

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: () => mockChain,
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
    <MemoryRouter initialEntries={['/chef/recipes']}>
      <RecipesPage />
    </MemoryRouter>,
  );
}

describe('RecipesPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /* ---- Loading ---- */

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByTestId('recipes-loading')).toBeInTheDocument();
  });

  /* ---- Recipe cards ---- */

  it('shows recipe cards with names after loading', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('recipe-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recipe-card-r1')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-name-r1')).toHaveTextContent('Chicken Stir Fry');
    expect(screen.getByTestId('recipe-card-r2')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-name-r2')).toHaveTextContent('Overnight Oats');
    expect(screen.getByTestId('recipe-card-r3')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-name-r3')).toHaveTextContent('Protein Shake');
  });

  /* ---- Per-serving macros on cards ---- */

  it('shows per-serving macros on recipe cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('recipe-macros-r1')).toBeInTheDocument();
    });
    // Chicken Stir Fry:
    //   Chicken: 2 servings * 165 cal = 330 cal, 2*0 carb, 2*31 prot = 62, 2*3.6 fat = 7.2
    //   Mixed Veg: 1 container * 3 servings/ctn * 60 cal = 180 cal, 3*12 carb = 36, 3*2 prot = 6, 3*0 fat = 0
    //   Total: 510 cal, 36 carb, 68 prot, 7.2 fat
    //   Per serving (base_servings=2): 255 cal, 18 carb, 34 prot, 4 fat (rounded)
    expect(screen.getByTestId('recipe-macros-r1')).toHaveTextContent('255 cal');
    expect(screen.getByTestId('recipe-macros-r1')).toHaveTextContent('34g P');
    expect(screen.getByTestId('recipe-macros-r1')).toHaveTextContent('18g C');
    expect(screen.getByTestId('recipe-macros-r1')).toHaveTextContent('4g F');

    // Overnight Oats: 1 serving * 150 cal, 27 carb, 5 prot, 3 fat / 1 serving
    expect(screen.getByTestId('recipe-macros-r2')).toHaveTextContent('150 cal');
    expect(screen.getByTestId('recipe-macros-r2')).toHaveTextContent('5g P');
    expect(screen.getByTestId('recipe-macros-r2')).toHaveTextContent('27g C');
    expect(screen.getByTestId('recipe-macros-r2')).toHaveTextContent('3g F');
  });

  /* ---- Search bar and filter chips ---- */

  it('shows search bar and filter chips', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('recipes-filters')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recipe-search')).toBeInTheDocument();
    expect(screen.getByTestId('can-be-made-filter')).toBeInTheDocument();
    expect(screen.getByTestId('active-time-filter')).toBeInTheDocument();
  });

  /* ---- New Recipe button ---- */

  it('shows "New Recipe" button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('new-recipe-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('new-recipe-btn')).toHaveTextContent('+ New Recipe');
  });

  /* ---- Active/Total time display ---- */

  it('shows active and total time on recipe cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('active-time-r1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('active-time-r1')).toHaveTextContent('Active: 15 min');
    expect(screen.getByTestId('total-time-r1')).toHaveTextContent('Total: 25 min');
  });

  /* ---- Stock status badges ---- */

  it('shows stock status badge on cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('stock-status-r1')).toBeInTheDocument();
    });
    // r1 has ingredients; stock check returns CAN MAKE for now (simplified)
    expect(screen.getByTestId('stock-status-r1')).toHaveTextContent('CAN MAKE');
    // r3 has no ingredients — CAN MAKE
    expect(screen.getByTestId('stock-status-r3')).toHaveTextContent('CAN MAKE');
  });

  /* ---- Meal Plan button ---- */

  it('shows "Meal Plan" button on each recipe card', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('meal-plan-btn-r1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('meal-plan-btn-r1')).toHaveTextContent('+ Meal Plan');
    expect(screen.getByTestId('meal-plan-btn-r2')).toHaveTextContent('+ Meal Plan');
  });
});

/* ================================================================== */
/*  Pure logic: computeRecipeMacros                                    */
/* ================================================================== */

describe('computeRecipeMacros', () => {
  it('computes per-serving macros from ingredients with servings unit', () => {
    const ingredients = [
      {
        quantity: 2,
        unit: 'serving',
        products: {
          calories_per_serving: 100,
          carbs_per_serving: 20,
          protein_per_serving: 10,
          fat_per_serving: 5,
          servings_per_container: 4,
        },
      },
    ];
    const result = computeRecipeMacros(ingredients, 2);
    // 2 servings * 100 cal = 200 total / 2 base_servings = 100
    expect(result.calories).toBe(100);
    expect(result.carbs).toBe(20);
    expect(result.protein).toBe(10);
    expect(result.fat).toBe(5);
  });

  it('computes per-serving macros from ingredients with container unit', () => {
    const ingredients = [
      {
        quantity: 1,
        unit: 'container',
        products: {
          calories_per_serving: 100,
          carbs_per_serving: 20,
          protein_per_serving: 10,
          fat_per_serving: 5,
          servings_per_container: 4,
        },
      },
    ];
    const result = computeRecipeMacros(ingredients, 2);
    // 1 container * 4 servings = 4 multiplier
    // 4 * 100 = 400 total / 2 base_servings = 200
    expect(result.calories).toBe(200);
    expect(result.carbs).toBe(40);
    expect(result.protein).toBe(20);
    expect(result.fat).toBe(10);
  });

  it('handles mixed unit ingredients', () => {
    const ingredients = [
      {
        quantity: 2,
        unit: 'serving',
        products: {
          calories_per_serving: 165,
          carbs_per_serving: 0,
          protein_per_serving: 31,
          fat_per_serving: 3.6,
          servings_per_container: 4,
        },
      },
      {
        quantity: 1,
        unit: 'container',
        products: {
          calories_per_serving: 60,
          carbs_per_serving: 12,
          protein_per_serving: 2,
          fat_per_serving: 0,
          servings_per_container: 3,
        },
      },
    ];
    const result = computeRecipeMacros(ingredients, 2);
    // Chicken: 2 * 165 = 330, 2*0=0, 2*31=62, 2*3.6=7.2
    // Veg: 1*3=3 multiplier -> 3*60=180, 3*12=36, 3*2=6, 3*0=0
    // Total: 510, 36, 68, 7.2
    // Per serving (2): 255, 18, 34, 3.6 -> round -> 255, 18, 34, 4
    expect(result.calories).toBe(255);
    expect(result.carbs).toBe(18);
    expect(result.protein).toBe(34);
    expect(result.fat).toBe(4);
  });

  it('returns zeros for empty ingredients list', () => {
    const result = computeRecipeMacros([], 1);
    expect(result.calories).toBe(0);
    expect(result.carbs).toBe(0);
    expect(result.protein).toBe(0);
    expect(result.fat).toBe(0);
  });

  it('handles null products gracefully (defaults to 0)', () => {
    const ingredients = [
      {
        quantity: 1,
        unit: 'serving',
        products: null,
      },
    ];
    const result = computeRecipeMacros(ingredients, 1);
    expect(result.calories).toBe(0);
    expect(result.carbs).toBe(0);
    expect(result.protein).toBe(0);
    expect(result.fat).toBe(0);
  });

  it('prevents division by zero when baseServings is 0', () => {
    const ingredients = [
      {
        quantity: 1,
        unit: 'serving',
        products: {
          calories_per_serving: 200,
          carbs_per_serving: 30,
          protein_per_serving: 15,
          fat_per_serving: 8,
          servings_per_container: 1,
        },
      },
    ];
    const result = computeRecipeMacros(ingredients, 0);
    // Should use Math.max(0, 1) = 1 as divisor
    expect(result.calories).toBe(200);
    expect(result.carbs).toBe(30);
    expect(result.protein).toBe(15);
    expect(result.fat).toBe(8);
  });
});
