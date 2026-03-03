import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SplitPage } from '@/pages/coachbyte/SplitPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

describe('SplitPage', () => {
  it('renders the loading spinner while fetching data', () => {
    render(<MemoryRouter><SplitPage /></MemoryRouter>);
    expect(screen.getByTestId('split-loading')).toBeInTheDocument();
  });
});
