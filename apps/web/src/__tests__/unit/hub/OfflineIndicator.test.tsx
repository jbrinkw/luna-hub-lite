import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAppContext } from '../../../shared/AppProvider';
import { OfflineIndicator } from '../../../components/OfflineIndicator';

const mockUseAppContext = vi.mocked(useAppContext);

describe('OfflineIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when online', () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      online: true,
      lastSynced: new Date(),
      refreshActivations: vi.fn(),
    });
    const { container } = render(<OfflineIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('shows banner when offline', () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      online: false,
      lastSynced: new Date('2026-03-03T10:00:00Z'),
      refreshActivations: vi.fn(),
    });
    render(<OfflineIndicator />);
    expect(screen.getByText(/no connection/i)).toBeInTheDocument();
  });

  it('shows last synced time when offline', () => {
    const syncDate = new Date('2026-03-03T10:00:00Z');
    mockUseAppContext.mockReturnValue({
      activations: {},
      online: false,
      lastSynced: syncDate,
      refreshActivations: vi.fn(),
    });
    render(<OfflineIndicator />);
    // Verify both the prefix and the actual formatted time value
    const expectedTime = syncDate.toLocaleTimeString();
    expect(screen.getByText(/last synced/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(expectedTime))).toBeInTheDocument();
  });

  it('shows never synced when lastSynced is null', () => {
    mockUseAppContext.mockReturnValue({
      activations: {},
      online: false,
      lastSynced: null,
      refreshActivations: vi.fn(),
    });
    render(<OfflineIndicator />);
    expect(screen.getByText(/never synced/i)).toBeInTheDocument();
  });
});
