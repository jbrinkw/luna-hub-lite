import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OfflineIndicator } from '../../../components/OfflineIndicator';

// The global setup.ts mocks useAppContext with defaults (online: true).
// We import and override it per-test to control the offline/online state.
import { useAppContext } from '@/shared/AppProvider';

const mockUseAppContext = vi.mocked(useAppContext);

function makeCtx(overrides: Partial<ReturnType<typeof useAppContext>> = {}) {
  return {
    activations: {},
    activationsLoading: false,
    online: true,
    lastSynced: new Date(),
    dayStartHour: 0,
    refreshActivations: vi.fn(),
    realtimeDegraded: false,
    reconnectRealtime: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useAppContext>;
}

describe('OfflineIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders null when online and realtime is healthy', () => {
    mockUseAppContext.mockReturnValue(makeCtx());

    const { container } = render(<OfflineIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it("renders 'No connection' banner when offline", () => {
    mockUseAppContext.mockReturnValue(makeCtx({ online: false }));

    render(<OfflineIndicator />);
    expect(screen.getByText(/No connection/)).toBeInTheDocument();
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });

  it("shows 'Never synced' when lastSynced is null", () => {
    mockUseAppContext.mockReturnValue(makeCtx({ online: false, lastSynced: null }));

    render(<OfflineIndicator />);
    expect(screen.getByText(/No connection/)).toBeInTheDocument();
    expect(screen.getByText(/Never synced/)).toBeInTheDocument();
  });

  it('shows formatted time when lastSynced has a date', () => {
    const syncDate = new Date(2026, 2, 5, 14, 30, 0); // March 5, 2026 2:30 PM
    mockUseAppContext.mockReturnValue(makeCtx({ online: false, lastSynced: syncDate }));

    render(<OfflineIndicator />);
    expect(screen.getByText(/No connection/)).toBeInTheDocument();
    const expectedTime = syncDate.toLocaleTimeString();
    expect(screen.getByText(new RegExp(expectedTime))).toBeInTheDocument();
  });

  it('renders realtime-degraded banner when realtime is down but network is up', () => {
    mockUseAppContext.mockReturnValue(makeCtx({ realtimeDegraded: true }));

    render(<OfflineIndicator />);
    const banner = screen.getByTestId('realtime-degraded-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Live updates paused/);
    expect(screen.getByTestId('realtime-reconnect-button')).toBeInTheDocument();
  });

  it('invokes reconnectRealtime when Reconnect button is clicked', () => {
    const reconnect = vi.fn();
    mockUseAppContext.mockReturnValue(makeCtx({ realtimeDegraded: true, reconnectRealtime: reconnect }));

    render(<OfflineIndicator />);
    fireEvent.click(screen.getByTestId('realtime-reconnect-button'));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('prefers the offline banner when both offline and realtime are degraded', () => {
    mockUseAppContext.mockReturnValue(makeCtx({ online: false, realtimeDegraded: true }));

    render(<OfflineIndicator />);
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('realtime-degraded-banner')).not.toBeInTheDocument();
  });
});
