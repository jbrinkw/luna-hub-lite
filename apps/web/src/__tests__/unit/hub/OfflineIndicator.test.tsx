import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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
    reconnectRealtime: vi.fn(async () => {}),
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

  it('invokes reconnectRealtime when Reconnect button is clicked', async () => {
    const reconnect = vi.fn(async () => {});
    mockUseAppContext.mockReturnValue(makeCtx({ realtimeDegraded: true, reconnectRealtime: reconnect }));

    render(<OfflineIndicator />);
    fireEvent.click(screen.getByTestId('realtime-reconnect-button'));
    expect(reconnect).toHaveBeenCalledTimes(1);
    // Drain the microtask queue so the post-await setReconnecting(false)
    // runs, leaving the DOM in a stable end state for subsequent tests.
    await waitFor(() => expect(screen.getByTestId('realtime-reconnect-button')).not.toBeDisabled());
  });

  it('shows a "Reconnecting…" loading state on the button while the reconnect Promise is in flight', async () => {
    // Promise we resolve manually to control the in-flight window.
    let resolveReconnect: () => void = () => {};
    const reconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReconnect = resolve;
        }),
    );
    mockUseAppContext.mockReturnValue(makeCtx({ realtimeDegraded: true, reconnectRealtime: reconnect }));

    render(<OfflineIndicator />);
    const button = screen.getByTestId('realtime-reconnect-button');

    // Before click — idle state.
    expect(button).toHaveTextContent('Reconnect');
    expect(button).not.toBeDisabled();

    // Click — enters "Reconnecting…" state, button disabled, aria-busy=true.
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('Reconnecting…'));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    // While in flight, additional clicks are ignored (no extra calls).
    fireEvent.click(button);
    fireEvent.click(button);
    expect(reconnect).toHaveBeenCalledTimes(1);

    // Resolve the Promise — button returns to idle.
    await act(async () => {
      resolveReconnect();
    });
    await waitFor(() => expect(button).toHaveTextContent('Reconnect'));
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
  });

  it('clears the in-flight state even if reconnectRealtime throws', async () => {
    // The button must not get stuck on "Reconnecting…" if the underlying
    // reconnect rejects — otherwise a transient failure would brick the
    // recovery affordance until the user reloads.
    const reconnect = vi.fn(async () => {
      throw new Error('boom');
    });
    mockUseAppContext.mockReturnValue(makeCtx({ realtimeDegraded: true, reconnectRealtime: reconnect }));
    // Suppress the expected console.error from the catch path so the
    // failure log doesn't pollute test output.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<OfflineIndicator />);
    const button = screen.getByTestId('realtime-reconnect-button');

    // fireEvent doesn't await the click handler — wrap in act + waitFor so
    // React state updates flush.
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(button).toHaveTextContent('Reconnect'));
    expect(button).not.toBeDisabled();
    expect(reconnect).toHaveBeenCalledTimes(1);
    // The handler should have logged the failure.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('reconnectRealtime failed'), expect.any(Error));
    errSpy.mockRestore();
  });

  it('prefers the offline banner when both offline and realtime are degraded', () => {
    mockUseAppContext.mockReturnValue(makeCtx({ online: false, realtimeDegraded: true }));

    render(<OfflineIndicator />);
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('realtime-degraded-banner')).not.toBeInTheDocument();
  });
});
