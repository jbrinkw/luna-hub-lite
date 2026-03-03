import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WalmartPage } from '@/pages/chefbyte/WalmartPage';

vi.mock('@/shared/auth/AuthProvider', () => {
  const mockUser = { id: 'u1' };
  return { useAuth: () => ({ user: mockUser, signOut: vi.fn() }) };
});

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const mockMissingLinks = [
  { product_id: 'p1', name: 'Oat Milk', barcode: '123456789' },
  { product_id: 'p2', name: 'Almond Butter', barcode: null },
];

const mockMissingPrices = [
  { product_id: 'p3', name: 'Greek Yogurt', walmart_link: 'https://walmart.com/yogurt', price: null },
  { product_id: 'p4', name: 'Chicken Breast', walmart_link: 'https://walmart.com/chicken', price: null },
];

/* ------------------------------------------------------------------ */
/*  Supabase mock                                                      */
/* ------------------------------------------------------------------ */

let lastTable = '';
let queryCtx = '';

const mockChain: any = {};
const chainMethods = [
  'select', 'eq', 'neq', 'order', 'or', 'single', 'update',
  'insert', 'delete', 'limit', 'is', 'in', 'gt', 'lt',
  'gte', 'lte', 'upsert',
];
const thenImpl = (cb: any) => {
  let data: any = null;
  if (lastTable === 'products' && queryCtx === 'links') {
    data = mockMissingLinks;
  } else if (lastTable === 'products' && queryCtx === 'prices') {
    data = mockMissingPrices;
  }
  return cb({ data, error: null });
};

chainMethods.forEach(m => {
  mockChain[m] = vi.fn((...args: any[]) => {
    // Track query context
    if (m === 'is' && args[0] === 'walmart_link') queryCtx = 'links';
    if (m === 'is' && args[0] === 'price') queryCtx = 'prices';
    return mockChain;
  });
});
mockChain.then = vi.fn(thenImpl);

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: () => ({
      from: (table: string) => {
        lastTable = table;
        queryCtx = '';
        return mockChain;
      },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
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
    <MemoryRouter initialEntries={['/chef/walmart']}>
      <WalmartPage />
    </MemoryRouter>,
  );
}

describe('WalmartPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Restore chain implementations
    chainMethods.forEach(m => {
      mockChain[m] = vi.fn((...args: any[]) => {
        if (m === 'is' && args[0] === 'walmart_link') queryCtx = 'links';
        if (m === 'is' && args[0] === 'price') queryCtx = 'prices';
        return mockChain;
      });
    });
    mockChain.then = vi.fn(thenImpl);
    lastTable = '';
    queryCtx = '';
  });

  /* ---------------------------------------------------------------- */
  /*  Loading state                                                    */
  /* ---------------------------------------------------------------- */

  it('renders loading spinner initially', () => {
    renderPage();
    expect(screen.getByTestId('walmart-loading')).toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- */
  /*  Missing links section                                            */
  /* ---------------------------------------------------------------- */

  it('renders missing links section with count', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('missing-links-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('missing-links-section')).toHaveTextContent('Missing Walmart Links (2)');
  });

  it('shows products missing Walmart links', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('link-item-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('link-item-p1')).toHaveTextContent('Oat Milk');
    expect(screen.getByTestId('link-item-p1')).toHaveTextContent('123456789');
    expect(screen.getByTestId('link-item-p2')).toHaveTextContent('Almond Butter');
  });

  it('shows stubbed search results placeholder', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('link-item-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('link-item-p1')).toHaveTextContent('Search results will appear when Walmart integration is enabled');
  });

  it('shows Link Selected and Not on Walmart buttons', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('link-selected-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('link-selected-p1')).toHaveTextContent('Link Selected');
    expect(screen.getByTestId('not-on-walmart-p1')).toHaveTextContent('Not on Walmart');
  });

  it('Link Selected button is disabled (stubbed)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('link-selected-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('link-selected-p1')).toBeDisabled();
  });

  /* ---------------------------------------------------------------- */
  /*  Missing prices section                                           */
  /* ---------------------------------------------------------------- */

  it('renders missing prices section with count', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('missing-prices-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('missing-prices-section')).toHaveTextContent('Missing Prices (2)');
  });

  it('shows products needing prices', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('price-item-p3')).toBeInTheDocument();
    });
    expect(screen.getByTestId('price-item-p3')).toHaveTextContent('Greek Yogurt');
    expect(screen.getByTestId('price-item-p4')).toHaveTextContent('Chicken Breast');
  });

  it('shows price input and Save Price button for each product', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('price-input-p3')).toBeInTheDocument();
    });
    expect(screen.getByTestId('save-price-p3')).toHaveTextContent('Save Price');
    expect(screen.getByTestId('price-input-p4')).toBeInTheDocument();
    expect(screen.getByTestId('save-price-p4')).toHaveTextContent('Save Price');
  });

  /* ---------------------------------------------------------------- */
  /*  Refresh button                                                   */
  /* ---------------------------------------------------------------- */

  it('renders Refresh All Prices button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('refresh-all-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('refresh-all-btn')).toHaveTextContent('Refresh All Prices');
  });
});
