import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useAppContext } from '@/shared/AppProvider';
import { HubHomePage } from '@/pages/hub/HubHomePage';

// The global setup.ts already mocks @/shared/AppProvider, so we cast the
// imported hook as a Vitest mock so we can override its return value per test.
const mockUseAppContext = vi.mocked(useAppContext);

// Mock AuthProvider
const mockSignOut = vi.fn();
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'test@test.com' },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: mockSignOut,
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/hub']}>
      <HubHomePage />
    </MemoryRouter>,
  );
}

describe('HubHomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: both apps active, not loading
    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true, chefbyte: true },
      activationsLoading: false,
      online: true,
      lastSynced: new Date(),
      dayStartHour: 0,
      refreshActivations: vi.fn(),
    });
  });

  it('renders app launcher cards for active apps', () => {
    renderPage();
    expect(screen.getByTestId('app-card-coachbyte')).toBeInTheDocument();
    expect(screen.getByTestId('app-card-chefbyte')).toBeInTheDocument();
  });

  it('shows app names and descriptions', () => {
    renderPage();
    expect(screen.getByText('CoachByte')).toBeInTheDocument();
    expect(screen.getByText('ChefByte')).toBeInTheDocument();
    expect(screen.getByText('Workout plans, set tracking, PRs & rest timer')).toBeInTheDocument();
    expect(screen.getByText('Inventory, recipes, meal plans & macro tracking')).toBeInTheDocument();
  });

  it('cards link to correct routes', () => {
    renderPage();
    const coachCard = screen.getByTestId('app-card-coachbyte');
    const chefCard = screen.getByTestId('app-card-chefbyte');
    expect(coachCard).toHaveAttribute('href', '/coach');
    expect(chefCard).toHaveAttribute('href', '/chef');
  });

  it('hides inactive apps', () => {
    mockUseAppContext.mockReturnValue({
      activations: { coachbyte: true, chefbyte: false },
      activationsLoading: false,
      online: true,
      lastSynced: new Date(),
      dayStartHour: 0,
      refreshActivations: vi.fn(),
    });
    renderPage();
    expect(screen.getByTestId('app-card-coachbyte')).toBeInTheDocument();
    expect(screen.queryByTestId('app-card-chefbyte')).not.toBeInTheDocument();
  });

  it('shows empty state when no apps active', () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      activationsLoading: false,
      online: true,
      lastSynced: new Date(),
      dayStartHour: 0,
      refreshActivations: vi.fn(),
    });
    renderPage();
    expect(screen.getByTestId('no-active-apps')).toBeInTheDocument();
    expect(screen.getByText('No apps activated yet.')).toBeInTheDocument();
    expect(screen.getByText('Activate Apps')).toHaveAttribute('href', '/hub/apps');
  });

  it('shows settings link pointing to /hub/account', () => {
    renderPage();
    const settingsLink = screen.getByTestId('hub-settings-link');
    expect(settingsLink).toHaveAttribute('href', '/hub/account');
  });

  it('shows skeleton when activations loading', () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      activationsLoading: true,
      online: true,
      lastSynced: null,
      dayStartHour: 0,
      refreshActivations: vi.fn(),
    });
    renderPage();
    expect(screen.getByTestId('launcher-loading')).toBeInTheDocument();
    // No app cards or empty state when loading
    expect(screen.queryByTestId('app-card-coachbyte')).not.toBeInTheDocument();
    expect(screen.queryByTestId('no-active-apps')).not.toBeInTheDocument();
  });

  it('calls signOut when logout button is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('hub-logout-btn'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('renders Luna Hub title', () => {
    renderPage();
    expect(screen.getByText('Luna Hub')).toBeInTheDocument();
  });
});
