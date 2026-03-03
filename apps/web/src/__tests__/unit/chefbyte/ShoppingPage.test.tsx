import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShoppingPage } from '@/pages/chefbyte/ShoppingPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockItems = [
  {
    cart_item_id: 'c1',
    user_id: 'u1',
    product_id: 'p1',
    qty_containers: 2,
    purchased: false,
    created_at: '2026-03-01T10:00:00Z',
    products: { name: 'Chicken', barcode: '123', price: 5.99 },
  },
  {
    cart_item_id: 'c2',
    user_id: 'u1',
    product_id: 'p2',
    qty_containers: 1,
    purchased: false,
    created_at: '2026-03-01T11:00:00Z',
    products: { name: 'Rice', barcode: '456', price: 2.49 },
  },
  {
    cart_item_id: 'c3',
    user_id: 'u1',
    product_id: 'p3',
    qty_containers: 1,
    purchased: true,
    created_at: '2026-03-01T09:00:00Z',
    products: { name: 'Milk', barcode: '789', price: 3.49 },
  },
  {
    cart_item_id: 'c4',
    user_id: 'u1',
    product_id: 'p4',
    qty_containers: 1,
    purchased: true,
    created_at: '2026-03-01T09:30:00Z',
    products: { name: 'Soy Sauce', barcode: '012', price: 4.99 },
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
mockChain.then = vi.fn((cb: any) => cb({ data: mockItems, error: null }));

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
    <MemoryRouter initialEntries={['/chef/shopping']}>
      <ShoppingPage />
    </MemoryRouter>,
  );
}

describe('ShoppingPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /* ---- Loading ---- */

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByTestId('shopping-loading')).toBeInTheDocument();
  });

  /* ---- To Buy section ---- */

  it('shows "To Buy" section with unchecked items', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('to-buy-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('to-buy-section')).toHaveTextContent('To Buy (2)');
    expect(screen.getByTestId('item-c1')).toBeInTheDocument();
    expect(screen.getByTestId('item-c1')).toHaveTextContent('Chicken');
    expect(screen.getByTestId('item-c2')).toBeInTheDocument();
    expect(screen.getByTestId('item-c2')).toHaveTextContent('Rice');
  });

  /* ---- Purchased section ---- */

  it('shows "Purchased" section with checked items', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('purchased-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('purchased-section')).toHaveTextContent('Purchased (2)');
    expect(screen.getByTestId('item-c3')).toBeInTheDocument();
    expect(screen.getByTestId('item-c3')).toHaveTextContent('Milk');
    expect(screen.getByTestId('item-c4')).toBeInTheDocument();
    expect(screen.getByTestId('item-c4')).toHaveTextContent('Soy Sauce');
  });

  /* ---- Add item form ---- */

  it('shows add item form with input and button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('add-item-form')).toBeInTheDocument();
    });
    expect(screen.getByTestId('add-item-name')).toBeInTheDocument();
    expect(screen.getByTestId('add-item-qty')).toBeInTheDocument();
    expect(screen.getByTestId('add-item-btn')).toBeInTheDocument();
    expect(screen.getByTestId('add-item-btn')).toHaveTextContent('Add');
  });

  /* ---- Import to Inventory ---- */

  it('shows "Import to Inventory" button in purchased section', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('import-inventory-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('import-inventory-btn')).toHaveTextContent('Import to Inventory');
  });

  /* ---- Auto-Add Below Min Stock ---- */

  it('shows "Auto-Add Below Min Stock" button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('auto-add-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('auto-add-btn')).toHaveTextContent('Auto-Add Below Min Stock');
  });

  /* ---- Toggle purchased ---- */

  it('calls Supabase update when a shopping item checkbox is toggled', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('item-c1')).toBeInTheDocument();
    });

    // Clear mocks so we only track the toggle call
    mockChain.update.mockClear();
    mockChain.eq.mockClear();

    // IonCheckbox mock renders the data-testid directly on the <input type="checkbox">.
    // c1 is unpurchased (purchased=false); toggling sets purchased to true.
    const checkbox = screen.getByTestId('check-c1');
    fireEvent.click(checkbox);

    // The togglePurchased function calls:
    // chefbyte().from('shopping_list').update({ purchased: true }).eq('cart_item_id', 'c1')
    await waitFor(() => {
      expect(mockChain.update).toHaveBeenCalledWith({ purchased: true });
    });
    expect(mockChain.eq).toHaveBeenCalledWith('cart_item_id', 'c1');
  });

  /* ---- Remove buttons ---- */

  it('shows remove buttons for each item', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('remove-c1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('remove-c1')).toHaveTextContent('Remove');
    expect(screen.getByTestId('remove-c2')).toHaveTextContent('Remove');
    expect(screen.getByTestId('remove-c3')).toHaveTextContent('Remove');
    expect(screen.getByTestId('remove-c4')).toHaveTextContent('Remove');
  });
});
