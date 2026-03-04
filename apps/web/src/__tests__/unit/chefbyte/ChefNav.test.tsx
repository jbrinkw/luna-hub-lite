import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChefNav } from '@/components/chefbyte/ChefNav';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockUser = { id: 'u1' };
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: mockUser, signOut: vi.fn() }),
}));

const allLabels = ['Scanner', 'Home', 'Inventory', 'Shopping', 'Meal Plan', 'Recipes', 'Macros', 'Walmart', 'Settings'];

function renderNav(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChefNav />
    </MemoryRouter>,
  );
}

describe('ChefNav', () => {
  it('renders all tab labels', () => {
    renderNav('/chef');
    for (const label of allLabels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('Home tab is active when at /chef (index)', () => {
    renderNav('/chef');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/chef/home');
  });

  it('correct tab is active when at a sub-route', () => {
    renderNav('/chef/inventory');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/chef/inventory');
  });

  it('recipes tab is active when at /chef/recipes/new', () => {
    renderNav('/chef/recipes/new');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/chef/recipes');
  });

  it('has correct aria-label', () => {
    renderNav('/chef');
    expect(screen.getByLabelText('ChefByte navigation')).toBeInTheDocument();
  });

  it('falls back to Home tab for unknown sub-routes', () => {
    renderNav('/chef/unknown');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/chef/home');
  });

  it('calls navigate when a different tab is clicked', () => {
    renderNav('/chef');
    mockNavigate.mockClear();

    // Click the "Inventory" tab
    const inventoryTab = screen.getByText('Inventory').closest('[role="tab"]');
    expect(inventoryTab).toBeTruthy();
    fireEvent.click(inventoryTab!);

    expect(mockNavigate).toHaveBeenCalledWith('/chef/inventory');
  });

  it('does not call navigate when clicking the already-active tab', () => {
    renderNav('/chef/recipes');
    mockNavigate.mockClear();

    // Click the "Recipes" tab which is already active
    const recipesTab = screen.getByText('Recipes').closest('[role="tab"]');
    expect(recipesTab).toBeTruthy();
    fireEvent.click(recipesTab!);

    // The component checks `val !== current` before navigating, so navigate should not be called
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
