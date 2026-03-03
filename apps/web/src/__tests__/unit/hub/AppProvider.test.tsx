import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Unmock AppProvider for this test file (setup.ts has a global mock)
vi.unmock('@/shared/AppProvider');

// We need to mock the auth provider and supabase that AppProvider depends on
vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-1' }, session: null, loading: false })),
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

describe('AppProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
