import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ScannerPage, autoScaleNutrition } from '@/pages/chefbyte/ScannerPage';

vi.mock('@/shared/auth/AuthProvider', () => {
  const mockUser = { id: 'u1' };
  return { useAuth: () => ({ user: mockUser, signOut: vi.fn() }) };
});

/* ------------------------------------------------------------------ */
/*  Mock product data for barcode lookup                               */
/* ------------------------------------------------------------------ */

const mockProduct = {
  product_id: 'prod-1',
  name: 'Test Cereal',
  barcode: '049000000443',
  is_placeholder: false,
  calories_per_serving: 120,
  protein_per_serving: 3,
  carbs_per_serving: 25,
  fat_per_serving: 1.5,
  servings_per_container: 10,
};

const mockChain: any = {};
const chainMethods = [
  'select',
  'eq',
  'neq',
  'order',
  'or',
  'single',
  'update',
  'insert',
  'delete',
  'limit',
  'is',
  'in',
  'gt',
  'lt',
  'upsert',
];
chainMethods.forEach((m) => {
  mockChain[m] = vi.fn(() => mockChain);
});
// Default: return null (no product found)
mockChain.then = vi.fn((cb: any) => cb({ data: null, error: null }));

const mockRpc = vi.fn(() => Promise.resolve({ data: null, error: null }));

const mockFrom = vi.fn(() => mockChain);

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: mockFrom,
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
    <MemoryRouter initialEntries={['/chef']}>
      <ScannerPage />
    </MemoryRouter>,
  );
}

describe('ScannerPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /* ---------------------------------------------------------------- */
  /*  Two-column layout                                                */
  /* ---------------------------------------------------------------- */

  it('renders the scanner container with two columns', () => {
    renderPage();
    expect(screen.getByTestId('scanner-container')).toBeInTheDocument();
    expect(screen.getByTestId('queue-panel')).toBeInTheDocument();
    expect(screen.getByTestId('keypad-panel')).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Barcode input                                                    */
  /* ---------------------------------------------------------------- */

  it('renders barcode input field', () => {
    renderPage();
    expect(screen.getByTestId('barcode-input')).toBeInTheDocument();
    expect(screen.getByTestId('barcode-input')).toHaveAttribute('type', 'text');
  });

  /* ---------------------------------------------------------------- */
  /*  Filter buttons                                                   */
  /* ---------------------------------------------------------------- */

  it('renders All and New filter buttons', () => {
    renderPage();
    expect(screen.getByTestId('filter-all')).toHaveTextContent('All');
    expect(screen.getByTestId('filter-new')).toHaveTextContent('New');
  });

  /* ---------------------------------------------------------------- */
  /*  Empty queue                                                      */
  /* ---------------------------------------------------------------- */

  it('shows empty queue message', () => {
    renderPage();
    expect(screen.getByTestId('queue-empty')).toHaveTextContent('Scan a barcode to start');
  });

  /* ---------------------------------------------------------------- */
  /*  Mode selector                                                    */
  /* ---------------------------------------------------------------- */

  it('renders 4 mode buttons', () => {
    renderPage();
    expect(screen.getByTestId('mode-selector')).toBeInTheDocument();
    expect(screen.getByTestId('mode-purchase')).toHaveTextContent('Purchase');
    expect(screen.getByTestId('mode-consume_macros')).toHaveTextContent('Consume+Macros');
    expect(screen.getByTestId('mode-consume_no_macros')).toHaveTextContent('Consume-NoMacros');
    expect(screen.getByTestId('mode-shopping')).toHaveTextContent('Add to Shopping');
  });

  it('purchase mode is selected by default', () => {
    renderPage();
    // Purchase button should be solid fill (default mode)
    const purchaseBtn = screen.getByTestId('mode-purchase');
    expect(purchaseBtn).toHaveAttribute('fill', 'solid');
  });

  it('switches mode when clicking a mode button', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('mode-consume_macros'));
    expect(screen.getByTestId('mode-consume_macros')).toHaveAttribute('fill', 'solid');
    expect(screen.getByTestId('mode-purchase')).toHaveAttribute('fill', 'outline');
  });

  /* ---------------------------------------------------------------- */
  /*  Active item display                                              */
  /* ---------------------------------------------------------------- */

  it('shows "No item selected" when queue is empty', () => {
    renderPage();
    expect(screen.getByTestId('active-item-display')).toHaveTextContent('No item selected');
  });

  /* ---------------------------------------------------------------- */
  /*  Screen value                                                     */
  /* ---------------------------------------------------------------- */

  it('shows screen value with initial value of 1', () => {
    renderPage();
    expect(screen.getByTestId('screen-value')).toHaveTextContent('1');
  });

  /* ---------------------------------------------------------------- */
  /*  Keypad                                                           */
  /* ---------------------------------------------------------------- */

  it('renders all 12 keypad keys', () => {
    renderPage();
    expect(screen.getByTestId('keypad-grid')).toBeInTheDocument();
    // Digits 0-9
    for (let i = 0; i <= 9; i++) {
      expect(screen.getByTestId(`key-${i}`)).toBeInTheDocument();
    }
    // Decimal and backspace
    expect(screen.getByTestId('key-.')).toBeInTheDocument();
    expect(screen.getByTestId('key-backspace')).toBeInTheDocument();
  });

  it('updates screen value when keypad digit is pressed', () => {
    renderPage();
    // First key press replaces (overwrite mode)
    fireEvent.click(screen.getByTestId('key-5'));
    expect(screen.getByTestId('screen-value')).toHaveTextContent('5');

    // Subsequent press appends
    fireEvent.click(screen.getByTestId('key-3'));
    expect(screen.getByTestId('screen-value')).toHaveTextContent('53');
  });

  it('backspace removes last digit', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('key-4'));
    fireEvent.click(screen.getByTestId('key-2'));
    expect(screen.getByTestId('screen-value')).toHaveTextContent('42');

    fireEvent.click(screen.getByTestId('key-backspace'));
    expect(screen.getByTestId('screen-value')).toHaveTextContent('4');
  });

  it('decimal point works correctly', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('key-2'));
    fireEvent.click(screen.getByTestId('key-.'));
    fireEvent.click(screen.getByTestId('key-5'));
    expect(screen.getByTestId('screen-value')).toHaveTextContent('2.5');
  });

  /* ---------------------------------------------------------------- */
  /*  Nutrition editor (purchase mode only)                            */
  /* ---------------------------------------------------------------- */

  it('shows nutrition editor in purchase mode', () => {
    renderPage();
    expect(screen.getByTestId('nutrition-editor')).toBeInTheDocument();
    expect(screen.getByTestId('nut-servingsPerContainer')).toBeInTheDocument();
    expect(screen.getByTestId('nut-calories')).toBeInTheDocument();
    expect(screen.getByTestId('nut-carbs')).toBeInTheDocument();
    expect(screen.getByTestId('nut-fat')).toBeInTheDocument();
    expect(screen.getByTestId('nut-protein')).toBeInTheDocument();
  });

  it('hides nutrition editor in consume mode', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('mode-consume_macros'));
    expect(screen.queryByTestId('nutrition-editor')).not.toBeInTheDocument();
  });

  it('hides nutrition editor in shopping mode', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('mode-shopping'));
    expect(screen.queryByTestId('nutrition-editor')).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Unit toggle (consume modes only)                                 */
  /* ---------------------------------------------------------------- */

  it('shows unit toggle in consume+macros mode', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('mode-consume_macros'));
    expect(screen.getByTestId('unit-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('unit-toggle')).toHaveTextContent('Serving');
  });

  it('shows unit toggle in consume-no-macros mode', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('mode-consume_no_macros'));
    expect(screen.getByTestId('unit-toggle')).toBeInTheDocument();
  });

  it('hides unit toggle in purchase mode', () => {
    renderPage();
    expect(screen.queryByTestId('unit-toggle')).not.toBeInTheDocument();
  });

  it('hides unit toggle in shopping mode', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('mode-shopping'));
    expect(screen.queryByTestId('unit-toggle')).not.toBeInTheDocument();
  });

  it('toggles unit between Servings and Containers', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('mode-consume_macros'));
    expect(screen.getByTestId('unit-toggle')).toHaveTextContent('Serving');

    fireEvent.click(screen.getByTestId('unit-toggle'));
    expect(screen.getByTestId('unit-toggle')).toHaveTextContent('Container');

    fireEvent.click(screen.getByTestId('unit-toggle'));
    expect(screen.getByTestId('unit-toggle')).toHaveTextContent('Serving');
  });

  /* ---------------------------------------------------------------- */
  /*  Barcode submission                                               */
  /* ---------------------------------------------------------------- */

  it('submits a barcode and populates the queue with the found product', async () => {
    // Make the single() call resolve with a known product
    mockChain.then = vi.fn((cb: any) => cb({ data: mockProduct, error: null }));

    renderPage();

    const input = screen.getByTestId('barcode-input');
    fireEvent.change(input, { target: { value: '049000000443' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    // The queue should get a pending item first, then update to success with the product name.
    // The product name appears in both the queue item and the active-item-display, so
    // verify via the queue-list container and active-item-display.
    await waitFor(() => {
      expect(screen.getByTestId('queue-list')).toHaveTextContent('Test Cereal');
    });

    // Verify the active item display also shows the product name
    expect(screen.getByTestId('active-item-display')).toHaveTextContent('Test Cereal');

    // Verify the queue item shows "Purchased 1 containers" (default mode is purchase)
    expect(screen.getByTestId('queue-list')).toHaveTextContent('Purchased');
    expect(screen.getByTestId('queue-list')).toHaveTextContent('1 container');

    // Empty queue message should be gone
    expect(screen.queryByTestId('queue-empty')).not.toBeInTheDocument();
  });

  it('submits a barcode for unknown product and creates placeholder', async () => {
    // First call returns null (product not found), second returns the new placeholder
    let callIdx = 0;
    mockChain.then = vi.fn((cb: any) => {
      callIdx++;
      if (callIdx === 1) return cb({ data: null, error: null }); // product lookup
      return cb({ data: { product_id: 'new-1', name: 'Unknown (999999)' }, error: null }); // insert
    });

    renderPage();

    const input = screen.getByTestId('barcode-input');
    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    // Verify via the queue-list container (name appears in both queue item and active display)
    await waitFor(() => {
      expect(screen.getByTestId('queue-list')).toHaveTextContent('Unknown (999999)');
    });

    // Verify insert was called (the from mock was invoked for products insert)
    expect(mockFrom).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Pure function tests: autoScaleNutrition                            */
/* ------------------------------------------------------------------ */

describe('autoScaleNutrition', () => {
  const original = {
    servingsPerContainer: '10',
    calories: '200',
    carbs: '20',
    fat: '10',
    protein: '15',
  };

  it('scales macros proportionally when calories change', () => {
    const current = { ...original };
    const result = autoScaleNutrition('calories', '400', current, original);

    // 400/200 = 2x ratio
    expect(result.calories).toBe('400');
    expect(result.carbs).toBe('40');
    expect(result.fat).toBe('20');
    expect(result.protein).toBe('30');
  });

  it('recalculates calories with 4-4-9 when macro changes', () => {
    const current = { ...original };
    const result = autoScaleNutrition('carbs', '30', current, original);

    // calories = 30*4 + 10*9 + 15*4 = 120 + 90 + 60 = 270
    expect(result.carbs).toBe('30');
    expect(result.calories).toBe('270');
    expect(result.fat).toBe('10');
    expect(result.protein).toBe('15');
  });

  it('handles zero original calories gracefully', () => {
    const zeroOrig = { ...original, calories: '0' };
    const current = { ...original };
    const result = autoScaleNutrition('calories', '100', current, zeroOrig);

    // Original calories is 0 → no scaling, just set calories
    expect(result.calories).toBe('100');
  });

  it('does not scale when editing servingsPerContainer', () => {
    const current = { ...original };
    const result = autoScaleNutrition('servingsPerContainer', '20', current, original);

    expect(result.servingsPerContainer).toBe('20');
    expect(result.calories).toBe('200');
    expect(result.carbs).toBe('20');
  });

  it('protein change recalculates calories', () => {
    const current = { ...original };
    const result = autoScaleNutrition('protein', '25', current, original);

    // calories = 20*4 + 10*9 + 25*4 = 80 + 90 + 100 = 270
    expect(result.protein).toBe('25');
    expect(result.calories).toBe('270');
  });

  it('fat change recalculates calories', () => {
    const current = { ...original };
    const result = autoScaleNutrition('fat', '20', current, original);

    // calories = 20*4 + 20*9 + 15*4 = 80 + 180 + 60 = 320
    expect(result.fat).toBe('20');
    expect(result.calories).toBe('320');
  });
});
