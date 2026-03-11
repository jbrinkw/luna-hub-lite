import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ScannerPage } from '@/pages/chefbyte/ScannerPage';

/* ------------------------------------------------------------------ */
/*  Supabase mock                                                      */
/* ------------------------------------------------------------------ */

const mockUpdate = vi.fn();
const mockEqUpdate = vi.fn();

const mockProduct = {
  product_id: 'prod-1',
  name: 'Unknown (2900007325)',
  barcode: '2900007325',
  is_placeholder: true,
  calories_per_serving: null,
  protein_per_serving: null,
  carbs_per_serving: null,
  fat_per_serving: null,
  servings_per_container: 1,
};

let productLookupResult: any = mockProduct;

vi.mock('@/shared/supabase', () => {
  const chefbyte = () => {
    const builder: any = {};
    builder.from = vi.fn((table: string) => {
      const tableBuilder: any = {};
      const chainMethods = ['select', 'eq', 'is', 'order', 'limit'];
      for (const m of chainMethods) {
        tableBuilder[m] = vi.fn(() => tableBuilder);
      }

      if (table === 'products') {
        // SELECT (product lookup by barcode)
        tableBuilder.select = vi.fn(() => tableBuilder);
        tableBuilder.single = vi.fn(() => Promise.resolve({ data: productLookupResult, error: null }));

        // UPDATE (name save)
        tableBuilder.update = vi.fn((data: any) => {
          mockUpdate(data);
          const updateChain: any = {};
          updateChain.eq = vi.fn((...args: any[]) => {
            mockEqUpdate(...args);
            return Promise.resolve({ data: null, error: null });
          });
          return updateChain;
        });
      } else if (table === 'stock_lots') {
        tableBuilder.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
        tableBuilder.insert = vi.fn(() => {
          const c: any = {};
          c.select = vi.fn(() => c);
          c.single = vi.fn(() => Promise.resolve({ data: { lot_id: 'lot-1' }, error: null }));
          return c;
        });
      } else if (table === 'locations') {
        tableBuilder.single = vi.fn(() => Promise.resolve({ data: { location_id: 'loc-1' }, error: null }));
      } else {
        tableBuilder.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
        tableBuilder.insert = vi.fn(() => {
          const c: any = {};
          c.select = vi.fn(() => c);
          c.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
          return c;
        });
      }

      return tableBuilder;
    });
    builder.rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
    return builder;
  };

  return {
    supabase: { functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: { message: 'skip' } })) } },
    chefbyte,
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

/* ------------------------------------------------------------------ */
/*  Auth mock                                                          */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'test@test.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

/* ------------------------------------------------------------------ */
/*  Settings alerts mock (used by ChefLayout)                          */
/* ------------------------------------------------------------------ */

vi.mock('@/hooks/useSettingsAlerts', () => ({
  useSettingsAlerts: () => false,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function renderScanner() {
  return render(
    <MemoryRouter initialEntries={['/chef/scanner']}>
      <ScannerPage />
    </MemoryRouter>,
  );
}

async function scanBarcode(user: ReturnType<typeof userEvent.setup>, barcode: string) {
  const input = screen.getByTestId('barcode-input');
  await user.type(input, barcode);
  await user.keyboard('{Enter}');
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('Scanner — inline name editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    productLookupResult = mockProduct;
  });

  it('shows editable input for active item with productId', async () => {
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '2900007325');

    // Wait for queue item to appear
    await waitFor(() => {
      expect(screen.getByText(/Unknown \(2900007325\)/)).toBeInTheDocument();
    });

    // Click the queue item to select it — item auto-selects on scan,
    // but the name updates async after product lookup resolves
    await waitFor(() => {
      const display = screen.getByTestId('active-item-display');
      expect(display.tagName).toBe('INPUT');
      expect((display as HTMLInputElement).value).toBe('Unknown (2900007325)');
    });
  });

  it('saves edited name to DB on Enter', async () => {
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '2900007325');

    await waitFor(() => {
      expect(screen.getByText(/Unknown \(2900007325\)/)).toBeInTheDocument();
    });

    // Select the item
    const queueItem = screen.getByText(/Unknown \(2900007325\)/).closest('[data-testid^="queue-item"]')!;
    await user.click(queueItem);

    // Edit the name
    const nameInput = screen.getByTestId('active-item-display') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Honey Bunches of Oats');
    await user.keyboard('{Enter}');

    // Verify DB update was called with new name
    expect(mockUpdate).toHaveBeenCalledWith({ name: 'Honey Bunches of Oats', is_placeholder: false });
    expect(mockEqUpdate).toHaveBeenCalledWith('product_id', 'prod-1');

    // Queue item name should be updated
    await waitFor(() => {
      expect(screen.getByText('Honey Bunches of Oats')).toBeInTheDocument();
    });
  });

  it('saves edited name to DB on blur', async () => {
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '2900007325');

    await waitFor(() => {
      expect(screen.getByText(/Unknown \(2900007325\)/)).toBeInTheDocument();
    });

    const queueItem = screen.getByText(/Unknown \(2900007325\)/).closest('[data-testid^="queue-item"]')!;
    await user.click(queueItem);

    const nameInput = screen.getByTestId('active-item-display') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Cheerios');

    // Blur by clicking elsewhere
    await user.click(screen.getByTestId('barcode-input'));

    expect(mockUpdate).toHaveBeenCalledWith({ name: 'Cheerios', is_placeholder: false });
  });

  it('does not save if name is unchanged', async () => {
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '2900007325');

    await waitFor(() => {
      expect(screen.getByText(/Unknown \(2900007325\)/)).toBeInTheDocument();
    });

    const queueItem = screen.getByText(/Unknown \(2900007325\)/).closest('[data-testid^="queue-item"]')!;
    await user.click(queueItem);

    // Just press Enter without changing
    const nameInput = screen.getByTestId('active-item-display');
    await user.click(nameInput);
    await user.keyboard('{Enter}');

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not save if name is empty', async () => {
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '2900007325');

    await waitFor(() => {
      expect(screen.getByText(/Unknown \(2900007325\)/)).toBeInTheDocument();
    });

    const queueItem = screen.getByText(/Unknown \(2900007325\)/).closest('[data-testid^="queue-item"]')!;
    await user.click(queueItem);

    const nameInput = screen.getByTestId('active-item-display') as HTMLInputElement;
    await user.clear(nameInput);
    await user.keyboard('{Enter}');

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('clears isNew flag after rename', async () => {
    const user = userEvent.setup();
    renderScanner();

    await scanBarcode(user, '2900007325');

    await waitFor(() => {
      expect(screen.getByText(/Unknown \(2900007325\)/)).toBeInTheDocument();
    });

    // Should show [!NEW] badge for placeholder
    const newBadge = screen.queryByText('[!NEW]');
    expect(newBadge).toBeInTheDocument();

    const queueItem = screen.getByText(/Unknown \(2900007325\)/).closest('[data-testid^="queue-item"]')!;
    await user.click(queueItem);

    const nameInput = screen.getByTestId('active-item-display') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Cheerios');
    await user.keyboard('{Enter}');

    // [!NEW] badge should be gone after rename
    await waitFor(() => {
      expect(screen.queryByText('[!NEW]')).not.toBeInTheDocument();
    });
  });

  it('shows static div when no item is selected', () => {
    renderScanner();

    const display = screen.getByTestId('active-item-display');
    expect(display.tagName).toBe('DIV');
    expect(display).toHaveTextContent('No item selected');
  });
});
