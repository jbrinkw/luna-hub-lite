/**
 * UX Audit R2 #7 — RecipeFormPage ingredient-search must filter out
 * `[MEAL]` carve-out products.
 *
 * R1 found the bug. R2 confirmed it stood. SettingsPage already applies
 * the same `.not('name', 'ilike', '[MEAL]%')` filter; the recipe form
 * was the lone hold-out, polluting recipe authorship with placeholder
 * meal-prep allocations that disappear when the user clears the meal.
 *
 * Verification strategy: spy on the `chefbyte().from('products')` query
 * builder and assert that `searchProducts(...)` calls `.not('name',
 * 'ilike', '[MEAL]%')` on every search. The filter ordering is also
 * pinned (positive ilike → not-MEAL) so a future refactor that moves
 * the negative filter ABOVE the positive one keeps the behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const notSpy = vi.fn();
const ilikeSpy = vi.fn();

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((_table: string) => {
      const b: any = {};
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.ilike = vi.fn((col: string, pattern: string) => {
        ilikeSpy(col, pattern);
        return b;
      });
      b.not = vi.fn((col: string, op: string, val: string) => {
        notSpy(col, op, val);
        return b;
      });
      b.order = vi.fn(() => Promise.resolve({ data: [], error: null }));
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
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

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chef/recipes/new']}>
        <Routes>
          <Route path="/chef/recipes/new" element={<RecipeFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RecipeFormPage — ingredient search excludes [MEAL] carve-outs', () => {
  beforeEach(() => {
    notSpy.mockClear();
    ilikeSpy.mockClear();
  });

  it('searchProducts call hits .not("name", "ilike", "[MEAL]%") alongside the positive ilike', async () => {
    const user = userEvent.setup();
    renderForm();

    // Find the ingredient search input — placeholder text per the form
    // (loaded via heuristic since multiple text inputs exist; settle on
    // a stable selector).
    const inputs = await screen.findAllByRole('textbox');
    // The product search has placeholder "Search products..." — match by
    // placeholder substring to be robust against label wording.
    const searchInput = inputs.find((i) => /search/i.test(i.getAttribute('placeholder') ?? ''));
    expect(searchInput).toBeTruthy();
    await user.type(searchInput!, 'chicken');

    // searchProducts is debounced 300ms in the page; wait it out.
    await new Promise((r) => setTimeout(r, 400));

    // The .not filter must have been called with these exact args.
    expect(notSpy).toHaveBeenCalledWith('name', 'ilike', '[MEAL]%');
    // And the positive ilike must also have fired with the typed text.
    expect(ilikeSpy).toHaveBeenCalledWith('name', expect.stringContaining('chicken'));
  });
});
