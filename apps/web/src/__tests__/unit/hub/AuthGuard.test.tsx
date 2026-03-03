import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock useAuth hook
const mockUseAuth = vi.fn();
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

// Track navigation — capture all props to verify `replace`
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, Navigate: (props: { to: string; replace?: boolean }) => { mockNavigate(props); return null; } };
});

import { AuthGuard } from '@/components/AuthGuard';

describe('AuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when authenticated', () => {
    mockUseAuth.mockReturnValue({ user: { id: '123' }, loading: false });

    render(
      <MemoryRouter>
        <AuthGuard><div>Protected Content</div></AuthGuard>
      </MemoryRouter>,
    );

    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });

  it('redirects to /login when not authenticated', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });

    render(
      <MemoryRouter>
        <AuthGuard><div>Protected Content</div></AuthGuard>
      </MemoryRouter>,
    );

    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/login' }));
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('renders loading indicator when session check in progress', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });

    render(
      <MemoryRouter>
        <AuthGuard><div>Protected Content</div></AuthGuard>
      </MemoryRouter>,
    );

    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('redirects to /login when session expires', () => {
    // Start authenticated
    mockUseAuth.mockReturnValue({ user: { id: '123' }, loading: false });

    const { rerender } = render(
      <MemoryRouter>
        <AuthGuard><div>Protected Content</div></AuthGuard>
      </MemoryRouter>,
    );

    expect(screen.getByText('Protected Content')).toBeInTheDocument();

    // Session expires
    mockUseAuth.mockReturnValue({ user: null, loading: false });

    rerender(
      <MemoryRouter>
        <AuthGuard><div>Protected Content</div></AuthGuard>
      </MemoryRouter>,
    );

    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/login' }));
  });

  it('passes replace prop to Navigate for history replacement', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });

    render(
      <MemoryRouter>
        <AuthGuard><div>Protected Content</div></AuthGuard>
      </MemoryRouter>,
    );

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/login', replace: true }),
    );
  });
});
