import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChefNav } from '@/components/chefbyte/ChefNav';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
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

  it('Scanner tab is active when at /chef (index)', () => {
    renderNav('/chef');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/chef');
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

  it('falls back to Scanner tab for unknown sub-routes', () => {
    renderNav('/chef/unknown');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/chef');
  });
});
