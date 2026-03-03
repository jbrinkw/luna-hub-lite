import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RecipeFormPage } from '@/pages/chefbyte/RecipeFormPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockRecipe = {
  recipe_id: 'r1',
  user_id: 'u1',
  name: 'Chicken Stir Fry',
  description: 'Quick stir fry',
  base_servings: 2,
  active_time: 15,
  total_time: 25,
  instructions: 'Cook it all together',
  recipe_ingredients: [
    {
      ingredient_id: 'i1',
      product_id: 'prod-1',
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
  ],
};

/* ------------------------------------------------------------------ */
/*  Supabase mock — chain pattern                                      */
/* ------------------------------------------------------------------ */

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt',
];
chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });

// Default: resolve with mock recipe (for edit mode loads)
mockChain.then = vi.fn((cb: any) => cb({ data: mockRecipe, error: null }));

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

function renderCreateMode() {
  return render(
    <MemoryRouter initialEntries={['/chef/recipes/new']}>
      <Routes>
        <Route path="/chef/recipes/new" element={<RecipeFormPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderEditMode() {
  return render(
    <MemoryRouter initialEntries={['/chef/recipes/r1']}>
      <Routes>
        <Route path="/chef/recipes/:id" element={<RecipeFormPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecipeFormPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /* ================================================================ */
  /*  CREATE MODE                                                      */
  /* ================================================================ */

  describe('create mode', () => {
    it('renders create form with empty fields', () => {
      renderCreateMode();
      expect(screen.getByText('NEW RECIPE')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-fields')).toBeInTheDocument();
    });

    it('shows all form fields', () => {
      renderCreateMode();
      expect(screen.getByTestId('recipe-name')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-description')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-base-servings')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-active-time')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-total-time')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-instructions')).toBeInTheDocument();
    });

    it('shows ingredient section with add button', () => {
      renderCreateMode();
      expect(screen.getByTestId('ingredients-section')).toBeInTheDocument();
      expect(screen.getByTestId('add-ingredient-form')).toBeInTheDocument();
      expect(screen.getByTestId('add-ingredient-btn')).toBeInTheDocument();
      expect(screen.getByTestId('ingredient-product-search')).toBeInTheDocument();
      expect(screen.getByTestId('ingredient-qty')).toBeInTheDocument();
      expect(screen.getByTestId('ingredient-unit')).toBeInTheDocument();
      expect(screen.getByTestId('ingredient-note')).toBeInTheDocument();
    });

    it('shows save button with "Create Recipe" text', () => {
      renderCreateMode();
      expect(screen.getByTestId('save-recipe-btn')).toBeInTheDocument();
      expect(screen.getByTestId('save-recipe-btn')).toHaveTextContent('Create Recipe');
    });

    it('does NOT show delete button in create mode', () => {
      renderCreateMode();
      expect(screen.queryByTestId('delete-recipe-btn')).not.toBeInTheDocument();
    });

    it('shows "No ingredients" message when none added', () => {
      renderCreateMode();
      expect(screen.getByTestId('no-ingredients')).toBeInTheDocument();
      expect(screen.getByTestId('no-ingredients')).toHaveTextContent('No ingredients added yet');
    });

    it('shows macro display section', () => {
      renderCreateMode();
      expect(screen.getByTestId('macro-display')).toBeInTheDocument();
      expect(screen.getByTestId('total-macros')).toBeInTheDocument();
      expect(screen.getByTestId('per-serving-macros')).toBeInTheDocument();
    });
  });

  /* ================================================================ */
  /*  EDIT MODE                                                        */
  /* ================================================================ */

  describe('edit mode', () => {
    it('shows loading spinner while fetching recipe', () => {
      renderEditMode();
      expect(screen.getByTestId('recipe-form-loading')).toBeInTheDocument();
    });

    it('loads recipe and shows "EDIT RECIPE" heading', async () => {
      renderEditMode();
      await waitFor(() => {
        expect(screen.getByText('EDIT RECIPE')).toBeInTheDocument();
      });
    });

    it('shows save button with "Update Recipe" text', async () => {
      renderEditMode();
      await waitFor(() => {
        expect(screen.getByTestId('save-recipe-btn')).toBeInTheDocument();
      });
      expect(screen.getByTestId('save-recipe-btn')).toHaveTextContent('Update Recipe');
    });

    it('shows delete button in edit mode', async () => {
      renderEditMode();
      await waitFor(() => {
        expect(screen.getByTestId('delete-recipe-btn')).toBeInTheDocument();
      });
      expect(screen.getByTestId('delete-recipe-btn')).toHaveTextContent('Delete');
    });

    it('shows ingredient section and form fields', async () => {
      renderEditMode();
      await waitFor(() => {
        expect(screen.getByTestId('ingredients-section')).toBeInTheDocument();
      });
      expect(screen.getByTestId('recipe-fields')).toBeInTheDocument();
      expect(screen.getByTestId('recipe-name')).toBeInTheDocument();
    });
  });
});
