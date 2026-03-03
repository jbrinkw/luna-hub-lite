import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from '@/pages/chefbyte/SettingsPage';

const mockUser = { id: 'u1' };
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: mockUser, signOut: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockProducts = [
  {
    product_id: 'p-1',
    user_id: 'u1',
    name: 'Milk',
    barcode: '123456',
    description: null,
    servings_per_container: 4,
    calories_per_serving: 150,
    carbs_per_serving: 12,
    protein_per_serving: 8,
    fat_per_serving: 8,
    min_stock_amount: 2,
    is_placeholder: false,
    walmart_link: null,
    price: 3.99,
  },
  {
    product_id: 'p-2',
    user_id: 'u1',
    name: 'Eggs',
    barcode: null,
    description: null,
    servings_per_container: 12,
    calories_per_serving: 70,
    carbs_per_serving: 0,
    protein_per_serving: 6,
    fat_per_serving: 5,
    min_stock_amount: 1,
    is_placeholder: false,
    walmart_link: null,
    price: null,
  },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock — exact CoachByte pattern: single shared chain       */
/* ------------------------------------------------------------------ */

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt',
];
chainMethods.forEach(m => { mockChain[m] = vi.fn(() => mockChain); });
mockChain.then = vi.fn((cb: any) => cb({ data: mockProducts, error: null }));

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
    <MemoryRouter initialEntries={['/chef/settings']}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading spinner while fetching', () => {
    renderPage();
    expect(screen.getByTestId('settings-loading')).toBeInTheDocument();
  });

  it('renders Products tab by default with search bar', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('products-tab')).toBeInTheDocument();
    });
    expect(screen.getByTestId('product-search')).toBeInTheDocument();
  });

  it('shows product list with product data', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('product-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('product-p-1')).toBeInTheDocument();
    expect(screen.getByTestId('product-p-2')).toBeInTheDocument();
  });

  it('shows "Add Product" section with collapsed form', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('add-product-section')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('add-product-form')).not.toBeInTheDocument();
  });

  it('expands add product form when toggle button is clicked', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('toggle-add-product')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-add-product'));
    expect(screen.getByTestId('add-product-form')).toBeInTheDocument();
    expect(screen.getByTestId('save-new-product')).toBeInTheDocument();
  });

  it('shows edit and delete buttons for each product', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('edit-product-p-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-product-p-1')).toBeInTheDocument();
    expect(screen.getByTestId('edit-product-p-2')).toBeInTheDocument();
    expect(screen.getByTestId('delete-product-p-2')).toBeInTheDocument();
  });

  it('renders settings tab segment with both tab options', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('settings-tabs')).toBeInTheDocument();
    });
    const tabs = screen.getByTestId('settings-tabs');
    const buttons = tabs.querySelectorAll('[role="tab"]');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('data-value', 'products');
    expect(buttons[1]).toHaveAttribute('data-value', 'liquidtrack');
  });

  it('shows product names in product cards', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('product-p-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('product-p-1')).toHaveTextContent('Milk');
    expect(screen.getByTestId('product-p-2')).toHaveTextContent('Eggs');
  });

  it('does not show LiquidTrack tab content when Products is active', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('products-tab')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('liquidtrack-tab')).not.toBeInTheDocument();
  });

  it('switches to LiquidTrack tab and shows device list', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('products-tab')).toBeInTheDocument();
    });
    // Click the LiquidTrack segment button
    const ltButton = screen.getByText('LiquidTrack').closest('[role="tab"]')!;
    fireEvent.click(ltButton);
    await waitFor(() => {
      expect(screen.getByTestId('liquidtrack-tab')).toBeInTheDocument();
    });
    expect(screen.getByTestId('device-list')).toBeInTheDocument();
    expect(screen.queryByTestId('products-tab')).not.toBeInTheDocument();
  });

  it('shows add device section in LiquidTrack tab', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('products-tab')).toBeInTheDocument();
    });
    const ltButton = screen.getByText('LiquidTrack').closest('[role="tab"]')!;
    fireEvent.click(ltButton);
    await waitFor(() => {
      expect(screen.getByTestId('liquidtrack-tab')).toBeInTheDocument();
    });
    expect(screen.getByTestId('add-device-section')).toBeInTheDocument();
  });
});
