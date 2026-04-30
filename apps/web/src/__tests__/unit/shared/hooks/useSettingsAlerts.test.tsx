/**
 * Unit tests for useSettingsAlerts.
 *
 * The hook issues three Supabase count queries and sets `hasAlerts=true`
 * when any count > 0:
 *   1. Products missing walmart_link (non-placeholder)
 *   2. Products missing price (non-placeholder)
 *   3. Placeholder products
 *
 * Coverage:
 *   - returns false when no user is signed in
 *   - returns false when all counts are 0
 *   - returns true when missingLinks count > 0
 *   - returns true when missingPrices count > 0
 *   - returns true when placeholders count > 0
 *   - returns false (does not throw) when a query returns an error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockUseAuth, mockChefbyte, mockCounts } = vi.hoisted(() => {
  // per-call counts indexed by call order: [missingLinks, missingPrices, placeholders]
  const mockCounts = { values: [0, 0, 0] as [number, number, number], errors: [null, null, null] as [any, any, any] };
  let callIdx = 0;

  const builderFactory = () => {
    const b: any = {};
    b.from = vi.fn((_table: string) => {
      const q: any = {};
      q.select = vi.fn(() => q);
      q.eq = vi.fn(() => q);
      q.is = vi.fn(() => q);
      // Make the builder thenable so `await chefbyte().from('products').select(...).eq(...).is(...)...`
      // resolves to { count, error }.
      q.then = (resolve: (v: any) => void) => {
        const i = callIdx % 3;
        callIdx++;
        resolve({ count: mockCounts.values[i], error: mockCounts.errors[i] });
      };
      return q;
    });
    return b;
  };

  const mockChefbyte = vi.fn(() => builderFactory());

  // Reset callIdx before each test
  const reset = () => { callIdx = 0; };

  const mockUseAuth = vi.fn();

  return { mockUseAuth, mockChefbyte, mockCounts, reset };
});

vi.mock('@/shared/supabase', () => ({
  chefbyte: mockChefbyte,
}));

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: mockUseAuth,
}));

import { useSettingsAlerts } from '@/hooks/useSettingsAlerts';

describe('useSettingsAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCounts.values = [0, 0, 0];
    mockCounts.errors = [null, null, null];
    // Reset call index by re-assigning mockChefbyte impl
    let callIdx = 0;
    const builderFactory = () => {
      const b: any = {};
      b.from = vi.fn((_table: string) => {
        const q: any = {};
        q.select = vi.fn(() => q);
        q.eq = vi.fn(() => q);
        q.is = vi.fn(() => q);
        q.then = (resolve: (v: any) => void) => {
          const i = callIdx % 3;
          callIdx++;
          resolve({ count: mockCounts.values[i], error: mockCounts.errors[i] });
        };
        return q;
      });
      return b;
    };
    mockChefbyte.mockImplementation(() => builderFactory());
  });

  it('returns false when no user is signed in (effect skips)', async () => {
    mockUseAuth.mockReturnValue({ user: null });
    const { result } = renderHook(() => useSettingsAlerts());
    // No async work when user is null — stays false immediately
    expect(result.current).toBe(false);
  });

  it('returns false when all counts are 0', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'u1' } });
    mockCounts.values = [0, 0, 0];

    const { result } = renderHook(() => useSettingsAlerts());

    await waitFor(() => {
      expect(mockChefbyte).toHaveBeenCalled();
    });
    expect(result.current).toBe(false);
  });

  it('returns true when missingLinks count > 0', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'u1' } });
    mockCounts.values = [3, 0, 0];

    const { result } = renderHook(() => useSettingsAlerts());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('returns true when missingPrices count > 0', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'u1' } });
    mockCounts.values = [0, 1, 0];

    const { result } = renderHook(() => useSettingsAlerts());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('returns true when placeholders count > 0', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'u1' } });
    mockCounts.values = [0, 0, 2];

    const { result } = renderHook(() => useSettingsAlerts());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('returns false (does not throw) when a query errors', async () => {
    mockUseAuth.mockReturnValue({ user: { id: 'u1' } });
    mockCounts.errors = [{ message: 'RLS denied' }, null, null];
    mockCounts.values = [0, 0, 0];

    const { result } = renderHook(() => useSettingsAlerts());

    // Should not throw and should remain false
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current).toBe(false);
  });
});
