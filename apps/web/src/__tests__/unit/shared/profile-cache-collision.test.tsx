/**
 * H-13 / PROFILE-CACHE — regression guard for the `queryKeys.profile`
 * cache-key collision.
 *
 * Background (the bug this pins):
 *   `queryKeys.profile(userId)` was a single key `['profile', userId]` shared
 *   by FOUR consumers that fetch DIFFERENT shapes under it with no `select:`
 *   transform:
 *     - AppProvider           → bare number `day_start_hour`  (10-min staleTime)
 *     - useUnitSystem         → `{ unit_system }`             (5-min staleTime)
 *     - AccountPage           → `{ display_name, timezone, day_start_hour, unit_system }`
 *     - ClassifierTab         → `{ chefbyte_classifier_fallback_enabled }`
 *   TanStack Query v5 dedupes strictly by key and shares ONE data entry.
 *   AppProvider mounts first (it wraps every protected route) and caches a
 *   bare NUMBER under the shared key with a 10-min staleTime. Within that
 *   window `useUnitSystem` reads the cached number instead of fetching, so
 *   `(number).unit_system === undefined` → it returns 'imperial'. A METRIC
 *   user then silently sees imperial units.
 *
 * The fix gives each consumer a DISTINCT key so no two consumers ever share a
 * cache entry with an incompatible shape.
 *
 * Test 1 (load-bearing): reproduce the real runtime path. Prime the cache the
 * way AppProvider does (a bare number under AppProvider's key), then mount the
 * REAL `useUnitSystem` hook for a metric user and assert it resolves 'metric'.
 * Pre-fix: AppProvider's bare number lives under the SAME key useUnitSystem
 * reads, shadows the fetch within staleTime → 'imperial' (RED). Post-fix:
 * distinct keys → useUnitSystem fetches its own `{unit_system:'metric'}` row →
 * 'metric' (GREEN).
 *
 * Test 2 (structural): the four consumer keys must be pairwise distinct.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { profileKeys } from '@/shared/queryKeys';

const USER_ID = 'user-profile-collision-1';

/* ------------------------------------------------------------------ */
/*  Auth + Supabase stubs                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID } }),
}));

// The profiles query that `useUnitSystem` issues: `.select('unit_system')`.
// We hard-code a METRIC user so the ONLY way the hook can return 'imperial'
// is by reading a stale/foreign cache entry (the bug).
vi.mock('@/shared/supabase', () => {
  const builder = () => {
    const b: any = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.single = vi.fn(() => Promise.resolve({ data: { unit_system: 'metric' }, error: null }));
    return b;
  };
  return {
    supabase: {
      schema: vi.fn(() => ({
        from: vi.fn(() => builder()),
      })),
    },
    chefbyte: vi.fn(() => ({})),
  };
});

import { useUnitSystem } from '@/shared/useUnitSystem';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('H-13 PROFILE-CACHE — queryKeys.profile collision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('useUnitSystem returns metric for a metric user even when a bare-number day_start_hour is already cached under the legacy shared profile address', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    // Prime a bare NUMBER (day_start_hour) under the LEGACY shared profile
    // address — `profileKeys.full` is the back-compat alias for the old
    // `['profile', userId]` key, which is exactly the address an un-migrated
    // `useUnitSystem` would still read from. This is the precise pre-fix state
    // that shadowed useUnitSystem's fetch (AppProvider mounts first and caches
    // the number with a long staleTime).
    //
    // Mutation guard: if `useUnitSystem` is reverted to read the shared
    // `queryKeys.profile` / `profileKeys.full` key, this primed number shadows
    // its fetch → `(6).unit_system === undefined` → 'imperial' → this test
    // goes RED. The fix (useUnitSystem reads its own `profileKeys.unitSystem`
    // key) keeps it GREEN.
    qc.setQueryData(profileKeys.full(USER_ID), 6);

    const { result } = renderHook(() => useUnitSystem(), { wrapper: makeWrapper(qc) });

    // A metric user MUST see 'metric'.
    await waitFor(() => {
      expect(result.current).toBe('metric');
    });
  });

  it('the four profile consumer keys are pairwise distinct', () => {
    const keys = [
      profileKeys.full(USER_ID),
      profileKeys.dayStart(USER_ID),
      profileKeys.unitSystem(USER_ID),
      profileKeys.classifierFallback(USER_ID),
    ].map((k) => JSON.stringify(k));

    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
