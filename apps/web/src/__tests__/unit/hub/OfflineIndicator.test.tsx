import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OfflineIndicator } from '../../../components/OfflineIndicator';

// The global setup.ts mocks useAppContext with defaults (online: true).
// We import and override it per-test to control the offline/online state.
import { useAppContext } from '@/shared/AppProvider';

const mockUseAppContext = vi.mocked(useAppContext);

describe('OfflineIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders null when online', () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      activationsLoading: false,
      online: true,
      lastSynced: new Date(),
      refreshActivations: vi.fn(),
    });

    const { container } = render(<OfflineIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it("renders 'No connection' banner when offline", () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      activationsLoading: false,
      online: false,
      lastSynced: new Date(),
      refreshActivations: vi.fn(),
    });

    render(<OfflineIndicator />);
    expect(screen.getByText(/No connection/)).toBeInTheDocument();
  });

  it("shows 'Never synced' when lastSynced is null", () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      activationsLoading: false,
      online: false,
      lastSynced: null,
      refreshActivations: vi.fn(),
    });

    render(<OfflineIndicator />);
    expect(screen.getByText(/No connection/)).toBeInTheDocument();
    expect(screen.getByText(/Never synced/)).toBeInTheDocument();
  });

  it('shows formatted time when lastSynced has a date', () => {
    const syncDate = new Date(2026, 2, 5, 14, 30, 0); // March 5, 2026 2:30 PM
    mockUseAppContext.mockReturnValue({
      activations: {},
      activationsLoading: false,
      online: false,
      lastSynced: syncDate,
      refreshActivations: vi.fn(),
    });

    render(<OfflineIndicator />);
    expect(screen.getByText(/No connection/)).toBeInTheDocument();
    // The component uses lastSynced.toLocaleTimeString()
    const expectedTime = syncDate.toLocaleTimeString();
    expect(screen.getByText(new RegExp(expectedTime))).toBeInTheDocument();
  });
});
