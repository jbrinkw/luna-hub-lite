import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InventoryPage } from '@/pages/chefbyte/InventoryPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockProducts = [
  {
    product_id: 'p1',
    user_id: 'u1',
    name: 'Chicken Breast',
    barcode: '012345678901',
    servings_per_container: 4,
    min_stock_amount: 2,
  },
  {
    product_id: 'p2',
    user_id: 'u1',
    name: 'Rice',
    barcode: null,
    servings_per_container: 8,
    min_stock_amount: 1,
  },
  {
    product_id: 'p3',
    user_id: 'u1',
    name: 'Protein Bars',
    barcode: '999888',
    servings_per_container: 12,
    min_stock_amount: 2,
  },
];

const mockLots = [
  {
    lot_id: 'l1',
    product_id: 'p1',
    qty_containers: 3,
    expires_on: '2026-04-01',
    locations: { name: 'Fridge' },
  },
  {
    lot_id: 'l2',
    product_id: 'p1',
    qty_containers: 1,
    expires_on: '2026-03-15',
    locations: { name: 'Freezer' },
  },
  {
    lot_id: 'l3',
    product_id: 'p2',
    qty_containers: 0.5,
    expires_on: null,
    locations: { name: 'Pantry' },
  },
];

const mockLocations = [{ location_id: 'loc1' }];

/* ------------------------------------------------------------------ */
/*  Supabase mock — chain pattern matching SettingsPage tests          */
/* ------------------------------------------------------------------ */

const mockRpc = vi.fn(() => Promise.resolve({ data: null, error: null }));

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt', 'upsert',
];
chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });

// Three sequential calls: products, stock_lots, locations
let callCount = 0;
mockChain.then = vi.fn((cb: any) => {
  callCount++;
  if (callCount % 3 === 1) return cb({ data: mockProducts, error: null });
  if (callCount % 3 === 2) return cb({ data: mockLots, error: null });
  return cb({ data: mockLocations, error: null });
});

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: () => mockChain,
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
    <MemoryRouter initialEntries={['/chef/inventory']}>
      <InventoryPage />
    </MemoryRouter>,
  );
}

describe('InventoryPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    callCount = 0;
  });

  /* ---- Loading ---- */

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByTestId('inventory-loading')).toBeInTheDocument();
  });

  /* ---- Grouped view ---- */

  it('renders grouped view by default with product info', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('grouped-view')).toBeInTheDocument();
    });
    expect(screen.getByTestId('inv-product-p1')).toBeInTheDocument();
    expect(screen.getByTestId('inv-product-p2')).toBeInTheDocument();
  });

  it('shows product names in cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('inv-product-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('inv-product-p1')).toHaveTextContent('Chicken Breast');
    expect(screen.getByTestId('inv-product-p2')).toHaveTextContent('Rice');
  });

  it('shows barcode when product has one', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('barcode-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('barcode-p1')).toHaveTextContent('012345678901');
    // p2 has no barcode
    expect(screen.queryByTestId('barcode-p2')).not.toBeInTheDocument();
  });

  it('shows servings per container info', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('inv-product-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('inv-product-p1')).toHaveTextContent('4 srvg/ctn');
    expect(screen.getByTestId('inv-product-p2')).toHaveTextContent('8 srvg/ctn');
  });

  /* ---- Stock badges ---- */

  it('shows stock badge with correct total for each product', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('stock-badge-p1')).toBeInTheDocument();
    });
    // Chicken: 3 + 1 = 4.0 ctn
    expect(screen.getByTestId('stock-badge-p1')).toHaveTextContent('4.0 ctn');
    // Rice: 0.5 ctn
    expect(screen.getByTestId('stock-badge-p2')).toHaveTextContent('0.5 ctn');
  });

  it('shows green badge when stock >= min_stock_amount', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('stock-badge-p1')).toBeInTheDocument();
    });
    // Chicken: 4.0 >= 2 min_stock => success
    expect(screen.getByTestId('stock-badge-p1')).toHaveAttribute('data-color', 'success');
  });

  it('shows warning badge when stock > 0 but < min_stock_amount', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('stock-badge-p2')).toBeInTheDocument();
    });
    // Rice: 0.5 > 0 but < 1 min_stock => warning
    expect(screen.getByTestId('stock-badge-p2')).toHaveAttribute('data-color', 'warning');
  });

  /* ---- Expiry & lot count ---- */

  it('shows nearest expiry date for products with expiring lots', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('expiry-p1')).toBeInTheDocument();
    });
    // Chicken has lots expiring 2026-03-15 and 2026-04-01; nearest = 2026-03-15
    expect(screen.getByTestId('expiry-p1')).toHaveTextContent('2026-03-15');
    // Rice has no expiry
    expect(screen.getByTestId('expiry-p2')).toHaveTextContent('\u2014');
  });

  it('shows lot count for each product', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('lot-count-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('lot-count-p1')).toHaveTextContent('2');
    expect(screen.getByTestId('lot-count-p2')).toHaveTextContent('1');
  });

  /* ---- Action buttons ---- */

  it('shows action buttons for each product', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('add-ctn-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('add-ctn-p1')).toHaveTextContent('+1 Ctn');
    expect(screen.getByTestId('sub-ctn-p1')).toHaveTextContent('-1 Ctn');
    expect(screen.getByTestId('add-srv-p1')).toHaveTextContent('+1 Srv');
    expect(screen.getByTestId('sub-srv-p1')).toHaveTextContent('-1 Srv');
    expect(screen.getByTestId('consume-all-p1')).toHaveTextContent('Consume All');
  });

  it('shows consume all confirmation dialog when button clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('consume-all-p1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('consume-all-p1'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Are you sure you want to consume all remaining stock for this product?',
    );
  });

  /* ---- View toggle ---- */

  it('has toggle between Grouped and Lots views', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('inventory-view-toggle')).toBeInTheDocument();
    });
    const toggle = screen.getByTestId('inventory-view-toggle');
    const buttons = toggle.querySelectorAll('[role="tab"]');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('data-value', 'grouped');
    expect(buttons[1]).toHaveAttribute('data-value', 'lots');
  });

  it('does not show lots view when grouped is active', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('grouped-view')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('lots-view')).not.toBeInTheDocument();
  });

  it('shows danger badge for product with zero stock', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('stock-badge-p3')).toBeInTheDocument();
    });
    // p3 (Protein Bars) has no lots → 0 stock → danger badge
    expect(screen.getByTestId('stock-badge-p3')).toHaveAttribute('data-color', 'danger');
    expect(screen.getByTestId('stock-badge-p3')).toHaveTextContent('0.0 ctn');
  });

  it('shows min stock column in grouped view', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('min-stock-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('min-stock-p1')).toHaveTextContent('2.0 ctn');
    expect(screen.getByTestId('min-stock-p2')).toHaveTextContent('1.0 ctn');
  });

  it('switches to lots view and shows lot data', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('grouped-view')).toBeInTheDocument();
    });
    // Click lots tab — use getAllByText since "Lots" also appears as a column header
    const lotsButton = screen.getAllByText('Lots').map(el => el.closest('[role="tab"]')).find(Boolean)!;
    fireEvent.click(lotsButton);
    await waitFor(() => {
      expect(screen.getByTestId('lots-view')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('grouped-view')).not.toBeInTheDocument();
    // Should show lot rows with location names
    expect(screen.getByText('Fridge')).toBeInTheDocument();
    expect(screen.getByText('Freezer')).toBeInTheDocument();
    expect(screen.getByText('Pantry')).toBeInTheDocument();
  });
});
