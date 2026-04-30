/**
 * RecipeFormPage — view-mode + edit-mode toggle behaviour.
 *
 * The recipe form lands in view mode when an existing recipe is loaded
 * (`/chef/recipes/:id`) and in edit mode when creating a new recipe
 * (`/chef/recipes/new`). The user toggles to edit mode via a header
 * button and back via Cancel (which reverts local state). These tests
 * exercise that flow at the rendered-component level, mocking out
 * Supabase + auth so we can drive the UI without a live backend.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const RECIPE_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

// Recipe row returned by the recipe fetch in edit-mode load.
const recipeFixture = {
  recipe_id: RECIPE_ID,
  user_id: 'u-recipe',
  name: 'Test Recipe',
  description: 'Yummy seed recipe',
  base_servings: 2,
  active_time: 10,
  total_time: 25,
  instructions: 'Step 1: cook.',
  recipe_ingredients: [
    {
      ingredient_id: 'ing-1',
      product_id: PRODUCT_ID,
      quantity: 1,
      unit: 'container',
      note: 'sliced',
      products: {
        name: 'Bacon',
        calories_per_serving: 100,
        carbs_per_serving: 0,
        protein_per_serving: 8,
        fat_per_serving: 7,
        servings_per_container: 4,
        net_weight_g: null,
        visual_unit_label: 'slice',
        visual_units_per_serving: 1,
      },
    },
  ],
};

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
      const b: any = {};
      b.select = vi.fn(() => b);
      b.insert = vi.fn(() => b);
      b.update = vi.fn(() => b);
      b.delete = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.ilike = vi.fn(() => b);
      b.not = vi.fn(() => b);
      b.order = vi.fn(() => Promise.resolve({ data: [], error: null }));
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.single = vi.fn(() => {
        // The recipe fetch is a chained `.eq().eq().single()` — return the
        // fixture row only when querying recipes.
        if (table === 'recipes') return Promise.resolve({ data: recipeFixture, error: null });
        return Promise.resolve({ data: null, error: null });
      });
      b.then = (resolve: (v: any) => void) => resolve({ data: [], error: null });
      return b;
    });
    builder.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return builder;
  };
  return {
    supabase: {
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn((cb?: (status: string) => void) => {
          setTimeout(() => cb?.('SUBSCRIBED'), 0);
          return { unsubscribe: vi.fn() };
        }),
        unsubscribe: vi.fn(),
      })),
      removeChannel: vi.fn(),
      realtime: { stateChangeCallbacks: { close: [] }, connect: vi.fn() },
      functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
    },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u-recipe', email: 't@t.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({
  useRealtimeInvalidation: vi.fn(),
}));

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

import { RecipeFormPage } from '@/pages/chefbyte/RecipeFormPage';

function renderAt(path: string, routePattern: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePattern} element={<RecipeFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('RecipeFormPage — view / edit mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('new recipe URL lands in edit mode (no Edit button, name input visible)', async () => {
    renderAt('/chef/recipes/new', '/chef/recipes/new');

    // The "Recipe name" input must be present (edit mode).
    const nameInput = await screen.findByPlaceholderText('Recipe name');
    expect(nameInput).toBeTruthy();

    // The "Enter edit mode" button must NOT be rendered (already in edit mode).
    expect(screen.queryByTestId('enter-edit-mode-btn')).toBeNull();

    // Save button labelled "Create Recipe" because this is a new recipe.
    expect(screen.getByTestId('save-recipe-btn').textContent).toContain('Create Recipe');
  });

  it('existing recipe URL lands in view mode (read-only, Edit button visible)', async () => {
    renderAt(`/chef/recipes/${RECIPE_ID}`, '/chef/recipes/:id');

    // Wait for the recipe to load + populate. The view-mode renders a
    // bulleted ingredients list with the formatted display string.
    const ingredientsList = await screen.findByTestId('ingredients-list-view');
    expect(ingredientsList).toBeTruthy();
    // The ingredient line rendered via formatIngredientDisplay (visual
    // unit on product) — "1 container Bacon" → "4 slices Bacon" because
    // 1 container × 4 servings × 1 slice/serving = 4 slices.
    expect(ingredientsList.textContent).toContain('Bacon');
    // Edit button must be present in the page header.
    expect(screen.getByTestId('enter-edit-mode-btn')).toBeTruthy();
    // The Recipe-name input must NOT be rendered in view mode.
    expect(screen.queryByPlaceholderText('Recipe name')).toBeNull();
    // No Save / Cancel-edit buttons in view mode.
    expect(screen.queryByTestId('save-recipe-btn')).toBeNull();
    expect(screen.queryByTestId('cancel-edit-btn')).toBeNull();
    // Add-ingredient form is hidden in view mode.
    expect(screen.queryByTestId('add-ingredient-form')).toBeNull();
  });

  it('clicking Edit reveals the edit form; Cancel restores view mode + reverts local edits', async () => {
    const user = userEvent.setup();
    renderAt(`/chef/recipes/${RECIPE_ID}`, '/chef/recipes/:id');

    // Wait for the recipe to load.
    await screen.findByTestId('enter-edit-mode-btn');

    // Switch to edit mode.
    await user.click(screen.getByTestId('enter-edit-mode-btn'));
    const nameInput = (await screen.findByPlaceholderText('Recipe name')) as HTMLInputElement;
    expect(nameInput.value).toBe('Test Recipe');

    // Edit the name then bail with Cancel.
    await user.clear(nameInput);
    await user.type(nameInput, 'Different Name');
    expect((screen.getByPlaceholderText('Recipe name') as HTMLInputElement).value).toBe('Different Name');

    await user.click(screen.getByTestId('cancel-edit-btn'));

    // Back to view mode → no name input, but the ingredients list returns,
    // and the edit-mode toggle button is back.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Recipe name')).toBeNull();
    });
    expect(screen.getByTestId('enter-edit-mode-btn')).toBeTruthy();
    // Re-entering edit mode shows the ORIGINAL name (snapshot revert).
    await user.click(screen.getByTestId('enter-edit-mode-btn'));
    const restored = (await screen.findByPlaceholderText('Recipe name')) as HTMLInputElement;
    expect(restored.value).toBe('Test Recipe');
  });
});
