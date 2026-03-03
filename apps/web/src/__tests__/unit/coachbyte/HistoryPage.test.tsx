import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HistoryPage } from '@/pages/coachbyte/HistoryPage';

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' }, signOut: vi.fn() }),
}));

describe('HistoryPage', () => {
  it('renders the HISTORY heading', () => {
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    expect(screen.getByText('HISTORY')).toBeInTheDocument();
  });

  it('renders filter select', () => {
    render(<MemoryRouter><HistoryPage /></MemoryRouter>);
    expect(screen.getByTestId('exercise-filter')).toBeInTheDocument();
  });
});
