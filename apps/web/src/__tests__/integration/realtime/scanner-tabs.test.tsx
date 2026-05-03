// @vitest-environment jsdom
/**
 * Realtime end-to-end integration tests for the Scanner UI tabs.
 *
 * These tests close audit gap C1: the unit tests for `ScannerTab` and
 * `ScannerTransactionsTab` only assert that `useRealtimeInvalidation` was
 * CALLED with the right channel-name + table — they never fire a real
 * Realtime event nor verify the React component re-renders. That's a
 * tautology: a typo in the channel filter, a missing publication entry,
 * an auth-token expiry, or a schema-mismatch in `chefbyte` would all pass
 * the unit assertion while breaking the user-visible behaviour.
 *
 * What we do here:
 *   1. Provision a real test user against the local Supabase stack
 *      (`http://127.0.0.1:54321`).
 *   2. Inject a real authenticated supabase-js client into
 *      `@/shared/supabase` so `chefbyte()` and the production
 *      `useRealtimeInvalidation` hook hit the live cloud.
 *   3. Mock `@/shared/auth/AuthProvider` so `useAuth()` returns the real
 *      user id (the hook uses it as the channel filter).
 *   4. Render the production tab component wrapped in
 *      `QueryClientProvider`; the production `useRealtimeInvalidation`
 *      runs, opening a real WebSocket subscription to
 *      `chefbyte.scanner_state` / `chefbyte.scan_transactions`.
 *   5. Insert / update a row via the service-role admin client.
 *   6. Assert the React component re-renders with the new data — for
 *      `ScannerTransactionsTab` we assert the new barcode appears in the
 *      DOM; for `ScannerTab` we assert the lock-state UI reflects the
 *      cross-device update.
 *
 * Failure modes this catches:
 *   - Table missing from the `supabase_realtime` publication
 *     (subscribe returns `CHANNEL_ERROR`; React never re-renders).
 *   - Channel filter typo (`schema=chefbyte` vs `schema=public` etc.) —
 *     event delivered but for the wrong table; React never re-renders.
 *   - Auth-token issue (user's JWT expired or RLS blocks the subscription
 *     filter; channel transitions to `CLOSED` after token TTL).
 *   - Production hook bug (e.g. invalidating the wrong query key).
 *
 * Timeout budget: each test waits up to 3s for the Realtime event to
 * propagate (per brief — 30s is too slow). Pre-warm in `beforeAll` pays
 * the cold-start cost so the per-test budget is realistic.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { adminClient, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../setup.integration';
import { createTestUser, cleanupUser } from '../../test-helpers';

/* ─── Test-state captured from beforeAll ─────────────────────────────────── */
let testUserId: string;
let testUserEmail: string;
let realtimeClient: SupabaseClient;

/* ─── Module mocks ─────────────────────────────────────────────────────────
 * The production code imports `supabase` and `chefbyte` from
 * `@/shared/supabase`; we shadow that module to return a real authenticated
 * client. `auth/AuthProvider` is shadowed so `useAuth()` returns the real
 * test-user id (the hook uses it for the `user_id=eq.<id>` filter).
 *
 * `chefbyte()` is invoked at render time (e.g. from
 * `ScannerTransactionsTab`'s queryFn). It MUST return a real, authenticated
 * client so the row read succeeds under RLS — service-role would also work
 * but the production code path uses the user-scoped client.
 */
vi.mock('@/shared/supabase', () => {
  return {
    get supabase() {
      return realtimeClient;
    },
    chefbyte: () => realtimeClient.schema('chefbyte') as any,
    coachbyte: () => realtimeClient.schema('coachbyte') as any,
    escapeIlike: (s: string) => s.replace(/[%_\\]/g, '\\$&'),
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: testUserId, email: testUserEmail },
    session: null,
    loading: false,
    sessionError: null,
    clearSessionError: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  }),
}));

/* ─── Imports AFTER mocks ──────────────────────────────────────────────────
 * Vitest hoists vi.mock calls but the actual production module load happens
 * here; the `realtimeClient` getter resolves at use-time so tests can inject
 * a fresh client.
 */
import { ScannerTab } from '@/pages/chefbyte/ScannerTab';
import { ScannerTransactionsTab } from '@/pages/chefbyte/ScannerTransactionsTab';

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithClient(ui: React.ReactElement, qc: QueryClient) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/**
 * Pre-warm the realtime stack — the first WS handshake on a cold local
 * Supabase can take >15s under load. Run in beforeAll so per-test waits
 * stay within the 3s budget the brief specifies.
 */
async function prewarmRealtime(client: SupabaseClient, userId: string): Promise<void> {
  const backoffMs = [1000, 2000, 4000, 8000, 16000];
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    const ch = client.channel(`scanner-warm-${crypto.randomUUID()}`);
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'chefbyte', table: 'scanner_state', filter: `user_id=eq.${userId}` },
      () => {
        /* discard */
      },
    );
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      ch.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
    client.removeChannel(ch);
    if (ok) {
      // 150ms settle so the WAL capture position commits before the first
      // probe. See realtime-invalidation.test.tsx for full rationale.
      await new Promise((r) => setTimeout(r, 150));
      lastErr = null;
      break;
    }
    lastErr = new Error('warmup channel did not subscribe');
    try {
      (client as any).realtime?.disconnect?.();
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: realtime disconnect throws on already-disconnected — best-effort retry path
    } catch {}
    if (attempt < backoffMs.length - 1) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
      try {
        (client as any).realtime?.connect?.();
        // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: realtime connect throws on already-connecting — best-effort retry path
      } catch {}
    }
  }
  if (lastErr) throw new Error(`realtime pre-warm failed: ${lastErr.message}`);
}

/* ─── Suite ───────────────────────────────────────────────────────────── */

describe('Realtime end-to-end — Scanner tabs (C1 audit gap)', () => {
  beforeAll(async () => {
    const user = await createTestUser('rt-scanner');
    testUserId = user.userId;
    testUserEmail = user.email;

    // Activate chefbyte so RLS-relevant infrastructure is in place. Not
    // strictly required for scanner_state/scan_transactions (those tables
    // exist regardless), but mirrors the production user lifecycle.
    await (user.client as any).schema('hub').rpc('activate_app', { p_app_name: 'chefbyte' });

    realtimeClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    await realtimeClient.auth.signInWithPassword({ email: testUserEmail, password: 'test-password-123' });

    await prewarmRealtime(realtimeClient, testUserId);
  }, 180_000);

  afterEach(async () => {
    // RTL cleanup unmounts the React tree; the production hook's effect
    // cleanup (in useRealtimeInvalidation) then calls removeChannel for
    // each subscribed channel. RTL auto-cleanup also runs but we call
    // explicitly so the production hook's teardown is observable.
    cleanup();

    // Defensive: drop any channel still attached to the shared client
    // (if a prior test threw before its component unmounted, leftover
    // subscriptions on the same socket can deliver phantom events to
    // the next test's queryClient via the shared underlying socket).
    realtimeClient.removeAllChannels();

    // Brief settle so the server-side phx_leave acks land before the
    // next test's subscribe. supabase-js doesn't expose a synchronous
    // wait for this, so a short sleep is the standard pattern.
    await new Promise((r) => setTimeout(r, 200));

    // Wipe per-test rows so the next test starts clean.
    await (adminClient as any).schema('chefbyte').from('scan_transactions').delete().eq('user_id', testUserId);
    await (adminClient as any).schema('chefbyte').from('scanner_state').delete().eq('user_id', testUserId);
  });

  afterAll(async () => {
    if (realtimeClient) {
      realtimeClient.removeAllChannels();
      try {
        (realtimeClient as any).realtime?.disconnect?.();
        // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: realtime disconnect throws on already-disconnected in afterAll — best-effort
      } catch {}
    }
    if (testUserId) await cleanupUser(testUserId);
  });

  /* ─── ScannerTab — UPDATE propagation (cross-device lock toggle) ──── */

  it('ScannerTab reflects a remote scanner_state UPDATE within 3s (cross-device lock sync)', async () => {
    // Seed the row with locked_mode=null so the initial UI shows
    // "unlocked". The test is the cross-device flip → lock label appears.
    await (adminClient as any).schema('chefbyte').from('scanner_state').insert({
      user_id: testUserId,
      last_active_mode: 'purchase',
      locked_mode: null,
    });

    const qc = makeQueryClient();
    renderWithClient(<ScannerTab />, qc);

    // Wait for the Save button — proves the component is mounted past its
    // initial query hydration.
    await screen.findByTestId('scanner-save-lock');

    // Confirm the "Currently locked to:" label is NOT yet visible (no
    // locked_mode set on the seeded row).
    expect(screen.queryByText(/Currently locked to:/i)).not.toBeInTheDocument();

    // Settle delay before the remote update. Slightly longer than the
    // INSERT-path test because a stale pending channel from a prior test
    // can take ~500ms to fully settle on the server side after
    // removeChannel; under-budget settles intermittently dropped events.
    await new Promise((r) => setTimeout(r, 500));

    // Simulate another device flipping the lock — UPDATE the row via
    // service-role admin. The production hook should observe the
    // postgres_changes event and invalidate the scannerState query, which
    // refetches and the UI re-renders showing the lock label.
    const { error: updErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('scanner_state')
      .update({ locked_mode: 'shopping' })
      .eq('user_id', testUserId);
    expect(updErr).toBeNull();

    // The "Currently locked to: <label>" paragraph must appear after the
    // Realtime event propagates. React renders that paragraph as two
    // separate text nodes (literal + interpolated label), so a single
    // string matcher won't match — use a function matcher that examines
    // the paragraph's full textContent. The match also pins the LABEL
    // text "Add to shopping list" to prove the refetch read the
    // post-UPDATE row (not a stale cached one).
    await waitFor(
      () => {
        const matches = screen.getAllByText((_text, el) => {
          if (el?.tagName !== 'P') return false;
          const tc = el?.textContent ?? '';
          return /Currently locked to:\s*Add to shopping list/i.test(tc);
        });
        expect(matches.length).toBeGreaterThan(0);
      },
      { timeout: 3_000, interval: 50 },
    );
  }, 30_000);

  /* ─── ScannerTransactionsTab — INSERT propagation ───────────────────── */

  it('ScannerTransactionsTab re-renders when a new scan_transactions row arrives via Realtime', async () => {
    const qc = makeQueryClient();
    renderWithClient(<ScannerTransactionsTab />, qc);

    // Wait for the initial empty-state to render — proves the component
    // mounted, the queryFn ran, and useRealtimeInvalidation has had time to
    // call channel.subscribe(). Without this we'd race the Realtime
    // subscription against the admin INSERT below.
    await screen.findByText(/No transactions yet/i);

    // Settle delay — the WAL capture position commits a hair after the
    // SUBSCRIBED ack. Mutations fired in the same microtask can race ahead.
    await new Promise((r) => setTimeout(r, 250));

    const barcode = `RT-TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const today = new Date().toISOString().slice(0, 10);
    const { error: insErr } = await (adminClient as any)
      .schema('chefbyte')
      .from('scan_transactions')
      .insert({
        user_id: testUserId,
        barcode,
        mode: 'purchase',
        status: 'applied',
        source: 'pi_usb',
        logical_date: today,
        pi_event_id: `rt-tx-${crypto.randomUUID()}`,
      });
    expect(insErr).toBeNull();

    // The Realtime event should propagate within 3s, invalidate the
    // scanTransactions query, the queryFn refetches, and the new barcode
    // row mounts. Per brief: 3s is the budget; failure points to
    // publication misconfiguration / subscription filter mismatch / auth.
    await waitFor(
      () => {
        expect(screen.getByText(barcode)).toBeInTheDocument();
      },
      { timeout: 3_000, interval: 50 },
    );
  }, 30_000);
});
