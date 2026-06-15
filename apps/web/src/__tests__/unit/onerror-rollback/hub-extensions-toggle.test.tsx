/**
 * onError rollback — ExtensionsPage toggleMutation (REAL component).
 *
 * Drives the SHIPPED `ExtensionsPage` optimistic toggle, not an in-file
 * copy. We render the real page, let its `useQuery` load the extension
 * settings (todoist: enabled+configured), click the Todoist toggle to
 * DISABLE it, and force the `hub.extension_settings` upsert to reject.
 *
 * Production onMutate optimistically flips BOTH `enabled→false` and
 * `hasCredentials→false` (the "Credentials configured" badge disappears).
 * Production onError must restore `context.previous`, bringing BOTH back.
 *
 * The `onSettled` invalidation refetch is gated by the test: after the
 * initial load the refetch is BLOCKED so the synchronous onError rollback
 * is the ONLY path that can restore the toggle/badge within the assertion
 * window. Deleting the production `onError` setQueryData revert leaves the
 * card stuck disabled with no badge → this test goes RED.
 *
 * Only the Supabase transport is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-ext-rollback';

interface ExtRow {
  extension_name: string;
  enabled: boolean;
  vault_secret_id: string | null;
}

// Server state: todoist enabled + has a vault secret (configured).
let serverRows: ExtRow[] = [];
function resetServer() {
  serverRows = [{ extension_name: 'todoist', enabled: true, vault_secret_id: 'vault-uuid-1' }];
}

let upsertShouldFail = false;

// Refetch gate — see hub-tools-toggle for the rationale. Blocks the
// onSettled refetch so it can't mask a missing onError rollback.
let selectCount = 0;
let releaseRefetch!: (rows: ExtRow[]) => void;
let refetchGate: Promise<ExtRow[]>;
function armRefetchGate() {
  refetchGate = new Promise((resolve) => {
    releaseRefetch = resolve;
  });
}

vi.mock('@/shared/supabase', () => {
  const schemaClient = () => {
    const root: any = {};
    root.rpc = vi.fn((name: string) => {
      // clear_extension_credentials / save_extension_credentials / tail health.
      if (name === 'clear_extension_credentials') {
        // Only reached on a SUCCESSFUL disable upsert; reflect the clear.
        serverRows = serverRows.map((r) => (r.extension_name === 'todoist' ? { ...r, vault_secret_id: null } : r));
      }
      return Promise.resolve({ data: null, error: null });
    });
    root.from = vi.fn((_table: string) => {
      const b: any = {};
      const state: { mode: 'select' | 'upsert'; patch: any } = { mode: 'select', patch: null };
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.in = vi.fn(() => b);
      b.order = vi.fn(() => b);
      b.upsert = vi.fn((patch: any) => {
        state.mode = 'upsert';
        state.patch = patch;
        if (upsertShouldFail) {
          return Promise.resolve({ data: null, error: { message: 'rls denied' } });
        }
        // Successful enable/disable: reflect the enabled flag.
        serverRows = serverRows.map((r) =>
          r.extension_name === patch.extension_name ? { ...r, enabled: patch.enabled } : r,
        );
        return Promise.resolve({ data: null, error: null });
      });
      b.then = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        if (state.mode === 'select') {
          selectCount += 1;
          if (selectCount === 1) {
            resolve({ data: serverRows, error: null });
          } else {
            refetchGate.then((rows) => resolve({ data: rows, error: null })).catch(reject);
          }
          return;
        }
        resolve({ data: null, error: null });
      };
      return b;
    });
    return root;
  };
  return {
    supabase: {
      schema: vi.fn(() => schemaClient()),
      channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn(), unsubscribe: vi.fn() })),
      removeChannel: vi.fn(),
    },
    chefbyte: vi.fn(),
    coachbyte: vi.fn(),
    escapeIlike: (s: string) => s,
  };
});

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID, email: 't@t.com' }, loading: false, signOut: vi.fn() }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

import { ExtensionsPage } from '@/pages/hub/ExtensionsPage';
import { ThemeProvider } from '@/shared/ThemeProvider';

function renderExtensions(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/hub/extensions']}>
          <ExtensionsPage />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function makeQc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

describe('ExtensionsPage toggleMutation — onError rollback (real component)', () => {
  beforeEach(() => {
    resetServer();
    upsertShouldFail = false;
    selectCount = 0;
    armRefetchGate();
  });

  afterEach(() => {
    releaseRefetch?.(serverRows);
    vi.clearAllMocks();
  });

  it('restores enabled=true AND the credentials badge when the upsert rejects', async () => {
    upsertShouldFail = true;
    const qc = makeQc();
    const user = userEvent.setup();
    renderExtensions(qc);

    const todoistToggle = await screen.findByRole('switch', { name: 'Enable Todoist' });
    expect(todoistToggle).toHaveAttribute('aria-checked', 'true');

    // The "Credentials configured" badge is present (hasCredentials=true).
    expect(screen.getByText('Credentials configured')).toBeInTheDocument();

    // Click to DISABLE — optimistically flips enabled=false + clears badge.
    await user.click(todoistToggle);

    // onMutate + rejected upsert + onError fire. Refetch is BLOCKED, so the
    // only restorer is the production onError rollback.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // Rolled back: toggle on again.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable Todoist' })).toHaveAttribute('aria-checked', 'true');
    });
    // Badge restored (hasCredentials back to true).
    expect(screen.getByText('Credentials configured')).toBeInTheDocument();

    // Release the gated refetch; state remains consistent.
    releaseRefetch(serverRows);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByRole('switch', { name: 'Enable Todoist' })).toHaveAttribute('aria-checked', 'true');
  });

  it('does NOT roll back when the upsert succeeds (success-path control)', async () => {
    upsertShouldFail = false;
    const qc = makeQc();
    const user = userEvent.setup();
    renderExtensions(qc);

    const todoistToggle = await screen.findByRole('switch', { name: 'Enable Todoist' });
    expect(todoistToggle).toHaveAttribute('aria-checked', 'true');

    await user.click(todoistToggle);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      releaseRefetch(serverRows);
      await new Promise((r) => setTimeout(r, 20));
    });

    // On success the disable sticks (server enabled=false, vault cleared).
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable Todoist' })).toHaveAttribute('aria-checked', 'false');
    });
    expect(serverRows.find((r) => r.extension_name === 'todoist')?.enabled).toBe(false);
  });

  it('is a no-op-safe rollback even when previous snapshot has the extension absent', async () => {
    // If todoist had no prior server row (first-ever toggle), the cache map
    // starts without the key. A rejected upsert must still leave the page in
    // a coherent state (toggle reflects ?? false default) — exercises the
    // `context.previous` branch where the entry is undefined.
    serverRows = []; // nothing configured
    selectCount = 0;
    armRefetchGate();
    upsertShouldFail = true;

    const qc = makeQc();
    const user = userEvent.setup();
    renderExtensions(qc);

    const todoistToggle = await screen.findByRole('switch', { name: 'Enable Todoist' });
    // Default render: disabled (no row).
    expect(todoistToggle).toHaveAttribute('aria-checked', 'false');

    // Click to ENABLE — optimistic enabled=true, then upsert rejects.
    await user.click(todoistToggle);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    // Rolled back to disabled (previous map had no todoist → restored to that).
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable Todoist' })).toHaveAttribute('aria-checked', 'false');
    });
  });
});
