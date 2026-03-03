import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CoachNav } from '@/components/coachbyte/CoachNav';

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

const allLabels = ['Today', 'History', 'Split', 'PRs', 'Settings'];

function renderNav(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CoachNav />
    </MemoryRouter>,
  );
}

describe('CoachNav', () => {
  it('renders all tab labels', () => {
    renderNav('/coach');
    for (const label of allLabels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('Today tab is active when at /coach (index)', () => {
    renderNav('/coach');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/coach');
  });

  it('correct tab is active when at a sub-route', () => {
    renderNav('/coach/history');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/coach/history');
  });

  it('settings tab is active when at /coach/settings', () => {
    renderNav('/coach/settings');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/coach/settings');
  });

  it('has correct aria-label', () => {
    renderNav('/coach');
    expect(screen.getByLabelText('CoachByte navigation')).toBeInTheDocument();
  });

  it('falls back to Today tab for unknown sub-routes', () => {
    renderNav('/coach/unknown');
    const segment = screen.getByRole('tablist');
    expect(segment).toHaveAttribute('data-value', '/coach');
  });

  it('calls navigate when a different tab is clicked', () => {
    renderNav('/coach');
    mockNavigate.mockClear();

    const historyTab = screen.getByText('History').closest('[role="tab"]');
    expect(historyTab).toBeTruthy();
    fireEvent.click(historyTab!);

    expect(mockNavigate).toHaveBeenCalledWith('/coach/history');
  });

  it('does not call navigate when clicking the already-active tab', () => {
    renderNav('/coach/split');
    mockNavigate.mockClear();

    const splitTab = screen.getByText('Split').closest('[role="tab"]');
    expect(splitTab).toBeTruthy();
    fireEvent.click(splitTab!);

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
