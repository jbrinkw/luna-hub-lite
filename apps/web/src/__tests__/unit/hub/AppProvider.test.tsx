import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

// Unmock AppProvider for this test file (setup.ts has a global mock)
vi.unmock('@/shared/AppProvider');

// We need to mock the auth provider and supabase that AppProvider depends on
const mockUseAuth = vi.fn(() => ({ user: { id: 'user-1' }, session: null, loading: false }));
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

import { AppProvider, useAppContext } from '../../../shared/AppProvider';
import { supabase } from '../../../shared/supabase';

function TestConsumer() {
  const { activations, online, lastSynced } = useAppContext();
  return (
    <div>
      <span data-testid="online">{online ? 'yes' : 'no'}</span>
      <span data-testid="activations">{JSON.stringify(activations)}</span>
      <span data-testid="synced">{lastSynced ? 'yes' : 'no'}</span>
    </div>
  );
}

function RefreshConsumer() {
  const { refreshActivations, activations } = useAppContext();
  return (
    <div>
      <span data-testid="activations">{JSON.stringify(activations)}</span>
      <button data-testid="refresh" onClick={() => refreshActivations()}>Refresh</button>
    </div>
  );
}

describe('AppProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' }, session: null, loading: false });
  });

  it('provides default online state', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );
    expect(screen.getByTestId('online').textContent).toBe('yes');
  });

  it('loads activations from supabase on mount', async () => {
    // Each from() call creates a new object, so we must configure mockFrom
    // to return a thenable that resolves with activation data
    const mockFromFn = (supabase as any).schema('hub').from;
    mockFromFn.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: any) =>
        resolve({ data: [{ app_name: 'coachbyte' }], error: null }),
      ),
    });

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('activations').textContent).toContain('coachbyte');
    });
  });

  it('responds to offline/online window events', async () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    // Initially online
    expect(screen.getByTestId('online').textContent).toBe('yes');

    // Dispatch offline event
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('online').textContent).toBe('no');

    // Dispatch online event
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByTestId('online').textContent).toBe('yes');
  });

  it('cleans up event listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    unmount();

    const removedEvents = removeSpy.mock.calls.map((call) => call[0]);
    expect(removedEvents).toContain('online');
    expect(removedEvents).toContain('offline');

    removeSpy.mockRestore();
  });

  it('does not call supabase when user is null', async () => {
    mockUseAuth.mockReturnValue({ user: null as any, session: null, loading: false });

    const mockSchema = (supabase as any).schema;
    mockSchema.mockClear();

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    // Give time for any async effects to fire
    await waitFor(() => {
      expect(screen.getByTestId('activations').textContent).toBe('{}');
    });

    // schema('hub') should not be called since user is null
    expect(mockSchema).not.toHaveBeenCalled();
  });

  it('exposes refreshActivations that triggers a new Supabase fetch', async () => {
    const mockFromFn = (supabase as any).schema('hub').from;
    mockFromFn.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: any) =>
        resolve({ data: [{ app_name: 'chefbyte' }], error: null }),
      ),
    });

    render(
      <AppProvider>
        <RefreshConsumer />
      </AppProvider>,
    );

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByTestId('activations').textContent).toContain('chefbyte');
    });

    // Record call count after initial load
    const callsAfterInit = mockFromFn.mock.calls.length;

    // Click refresh — should trigger a new Supabase call
    await act(async () => {
      screen.getByTestId('refresh').click();
    });

    // Verify a new Supabase from('app_activations') call was made
    expect(mockFromFn.mock.calls.length).toBeGreaterThan(callsAfterInit);
    expect(screen.getByTestId('activations').textContent).toContain('chefbyte');
  });

  it('keeps activations empty when supabase returns an error', async () => {
    const mockFromFn = (supabase as any).schema('hub').from;
    mockFromFn.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: any) =>
        resolve({ data: null, error: { message: 'test error' } }),
      ),
    });

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    // Even after async effects fire, activations should remain empty
    await waitFor(() => {
      expect(screen.getByTestId('activations').textContent).toBe('{}');
    });
  });

  it('calls supabase.schema with hub', async () => {
    const mockSchema = (supabase as any).schema;
    mockSchema.mockClear();

    const mockFromFn = mockSchema('hub').from;
    mockFromFn.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: any) =>
        resolve({ data: [], error: null }),
      ),
    });

    // Clear again after the setup call above
    mockSchema.mockClear();

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(mockSchema).toHaveBeenCalledWith('hub');
    });
  });
});
