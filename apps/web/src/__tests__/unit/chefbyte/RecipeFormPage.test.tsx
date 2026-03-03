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

    it('pre-fills form inputs with the loaded recipe values', async () => {
      renderEditMode();
      await waitFor(() => {
        expect(screen.getByText('EDIT RECIPE')).toBeInTheDocument();
      });

      // IonInput mock renders: <div data-testid="..."><label>Name</label><input aria-label="Name" .../></div>
      // IonTextarea mock renders: <div><label>Description</label><textarea id="Description" .../></div>
      // Use aria-label or id to find the actual input/textarea elements.

      // The recipe name input should contain "Chicken Stir Fry"
      const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
      expect(nameInput.value).toBe('Chicken Stir Fry');

      // The description textarea should contain "Quick stir fry"
      const descInput = screen.getByLabelText('Description') as HTMLTextAreaElement;
      expect(descInput.value).toBe('Quick stir fry');

      // Base servings should be 2
      const servingsInput = screen.getByLabelText('Base Servings') as HTMLInputElement;
      expect(servingsInput.value).toBe('2');

      // Active time should be 15
      const activeTimeInput = screen.getByLabelText('Active Time (min)') as HTMLInputElement;
      expect(activeTimeInput.value).toBe('15');

      // Total time should be 25
      const totalTimeInput = screen.getByLabelText('Total Time (min)') as HTMLInputElement;
      expect(totalTimeInput.value).toBe('25');

      // Instructions should contain "Cook it all together"
      const instructionsInput = screen.getByLabelText('Instructions') as HTMLTextAreaElement;
      expect(instructionsInput.value).toBe('Cook it all together');
    });

    it('pre-fills ingredient list from loaded recipe', async () => {
      renderEditMode();
      await waitFor(() => {
        expect(screen.getByText('EDIT RECIPE')).toBeInTheDocument();
      });

      // Should show the ingredients table with the loaded ingredient
      expect(screen.getByTestId('ingredients-table')).toBeInTheDocument();
      expect(screen.getByTestId('ingredient-row-0')).toBeInTheDocument();
      expect(screen.getByTestId('ingredient-row-0')).toHaveTextContent('Chicken Breast');
    });
  });
});
