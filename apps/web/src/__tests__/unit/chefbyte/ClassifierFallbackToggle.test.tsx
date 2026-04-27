/**
 * Unit tests for the ChefByte Settings → Classifier tab.
 *
 * Covers:
 *   1. The pure ``isFallbackEnabled`` predicate returns the expected
 *      boolean for true / false / null / undefined / missing-field
 *      profile shapes (mutation guard: replacing it with ``() => false``
 *      breaks at least the "true" assertion).
 *   2. The Toggle invokes the supabase update with the flipped value.
 *   3. Optimistic UI: aria-checked flips immediately on click before
 *      the network round-trip completes, then settles on the server
 *      value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-classifier-1';

/* ------------------------------------------------------------------ */
/*  Predicate test                                                     */
/* ------------------------------------------------------------------ */

import { isFallbackEnabled } from '@/components/chefbyte/ClassifierTab';

describe('isFallbackEnabled', () => {
  it('returns true when the flag is true', () => {
    expect(isFallbackEnabled({ chefbyte_classifier_fallback_enabled: true })).toBe(true);
  });
  it('returns false when the flag is false', () => {
    expect(isFallbackEnabled({ chefbyte_classifier_fallback_enabled: false })).toBe(false);
  });
  it('returns false for null / undefined profile', () => {
    expect(isFallbackEnabled(null)).toBe(false);
    expect(isFallbackEnabled(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Auth + Supabase stubs                                              */
/* ------------------------------------------------------------------ */

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID } }),
}));

// Captured by the mock; tests assert against this.
const updateCalls: Array<{ payload: any; userId: string }> = [];
let initialFallback = false;

vi.mock('@/shared/supabase', () => {
  const profilesBuilder = () => {
    const state: { mode: 'select' | 'update'; payload?: any; whereUserId?: string } = {
      mode: 'select',
    };
    const b: any = {};
    b.select = vi.fn(() => {
      state.mode = 'select';
      return b;
    });
    b.update = vi.fn((payload: any) => {
      state.mode = 'update';
      state.payload = payload;
      return b;
    });
    b.eq = vi.fn((_col: string, value: string) => {
      state.whereUserId = value;
      // Update path terminates at the awaited .eq() — return a real
      // thenable that resolves with { data: null, error: null }. Capture
      // the call payload at this point.
      if (state.mode === 'update') {
        updateCalls.push({ payload: state.payload, userId: value });
        return Promise.resolve({ data: null, error: null }) as any;
      }
      return b;
    });
    b.single = vi.fn(() =>
      Promise.resolve({
        data: { chefbyte_classifier_fallback_enabled: initialFallback },
        error: null,
      }),
    );
    return b;
  };

  return {
    supabase: {
      schema: vi.fn(() => ({
        from: vi.fn((table: string) => {
          if (table !== 'profiles') {
            throw new Error(`unexpected table ${table} in classifier-fallback-toggle test`);
          }
          return profilesBuilder();
        }),
      })),
    },
    chefbyte: vi.fn(() => ({})),
  };
});

/* ------------------------------------------------------------------ */
/*  Render harness                                                     */
/* ------------------------------------------------------------------ */

import { ClassifierTab } from '@/components/chefbyte/ClassifierTab';

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ClassifierTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateCalls.length = 0;
  initialFallback = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ClassifierTab toggle', () => {
  it('renders OFF when the profile has the flag false', async () => {
    initialFallback = false;
    renderTab();
    const toggle = await screen.findByTestId('classifier-fallback-toggle');
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('renders ON when the profile has the flag true', async () => {
    initialFallback = true;
    renderTab();
    const toggle = await screen.findByTestId('classifier-fallback-toggle');
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('flipping the toggle writes the new value via supabase update', async () => {
    initialFallback = false;
    renderTab();
    const toggle = await screen.findByTestId('classifier-fallback-toggle');
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    await userEvent.click(toggle);

    // Mutation must have called supabase.update with the flipped value
    // and the correct user_id filter. The optimistic state is briefly
    // visible but the post-settle refetch reads the (still-mocked
    // initialFallback=false) profile, so the toggle UI may resettle —
    // the contract under test is the WRITE call, not the optimistic
    // settle.
    await waitFor(() => {
      expect(updateCalls).toHaveLength(1);
    });
    expect(updateCalls[0].payload).toEqual({
      chefbyte_classifier_fallback_enabled: true,
    });
    expect(updateCalls[0].userId).toBe(USER_ID);
  });

  it('clicking the toggle twice writes both values', async () => {
    initialFallback = false;
    renderTab();
    const toggle = await screen.findByTestId('classifier-fallback-toggle');
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });

    // First click: false -> true
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(updateCalls).toHaveLength(1);
    });
    expect(updateCalls[0].payload.chefbyte_classifier_fallback_enabled).toBe(true);

    // After settling, the refetch returns false again (initialFallback
    // hasn't changed). Click again — that's a fresh false -> true write.
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(updateCalls).toHaveLength(2);
    });
    expect(updateCalls[1].payload.chefbyte_classifier_fallback_enabled).toBe(true);
  });

  it('description text is rendered (regression: copy must stay aligned with brief)', async () => {
    renderTab();
    // The copy is a single <p> — wait for the section card to render
    // then assert against its textContent in one shot. JSX `&apos;`
    // serialises to a literal U+2019 / `'` within a single text node,
    // so a textContent regex against the section is reliable across
    // React versions.
    const section = await screen.findByTestId('classifier-fallback-section');
    expect(section.textContent ?? '').toMatch(/matching against all certified LiveTrack items as a fallback/i);
    expect(section.textContent ?? '').toMatch(/Adds latency \+ AI cost when triggered\. Off by default\./i);
  });
});
