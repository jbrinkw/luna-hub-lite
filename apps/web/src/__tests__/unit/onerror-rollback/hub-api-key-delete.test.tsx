/**
 * onError rollback — McpSettingsPage revokeMutation (REAL component).
 *
 * Drives the SHIPPED `McpSettingsPage` optimistic key-revoke, not an
 * in-file copy. (The old test called it "deleteMutation"; the real
 * mutation is `revokeMutation` — a soft-delete via an `api_keys` UPDATE
 * that sets `revoked_at`.) We render the real page, let its `useQuery`
 * load two active keys, click Revoke → confirm on key "Production", and
 * force the `api_keys` UPDATE to reject.
 *
 * Production onMutate optimistically removes the key from the list.
 * Production onError must restore `context.previous` (re-insert the key)
 * AND surface the error message.
 *
 * The `onSettled` invalidation refetch is gated by the test so the
 * synchronous onError rollback is the ONLY path that can re-insert the
 * key within the assertion window. Deleting the production rollback
 * leaves "Production" gone from the list → this test goes RED.
 *
 * Only the Supabase transport is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-api-key-rollback';

interface KeyRow {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

let serverKeys: KeyRow[] = [];
function resetServer() {
  serverKeys = [
    { id: 'k1', label: 'Production', created_at: '2026-01-01T00:00:00Z', last_used_at: null, revoked_at: null },
    { id: 'k2', label: 'Dev', created_at: '2026-01-02T00:00:00Z', last_used_at: null, revoked_at: null },
  ];
}

let updateShouldFail = false;

// Refetch gate — blocks the onSettled refetch so it can't mask a missing
// onError rollback. See hub-tools-toggle for the full rationale.
let selectCount = 0;
let releaseRefetch!: (rows: KeyRow[]) => void;
let refetchGate: Promise<KeyRow[]>;
function armRefetchGate() {
  refetchGate = new Promise((resolve) => {
    releaseRefetch = resolve;
  });
}

function activeRows(): KeyRow[] {
  return serverKeys.filter((k) => k.revoked_at === null);
}

vi.mock('@/shared/supabase', () => {
  const schemaClient = () => {
    const root: any = {};
    root.rpc = vi.fn(() => Promise.resolve({ data: 0, error: null }));
    root.from = vi.fn((_table: string) => {
      const b: any = {};
      const state: { mode: 'select' | 'update'; filterId: string | null } = { mode: 'select', filterId: null };
      b.select = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.order = vi.fn(() => b);
      b.eq = vi.fn((col: string, val: string) => {
        if (col === 'id') state.filterId = val;
        return b;
      });
      b.update = vi.fn(() => {
        state.mode = 'update';
        return b;
      });
      b.insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.then = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        if (state.mode === 'update') {
          if (updateShouldFail) {
            resolve({ error: { message: 'revoke failed (network)' } });
          } else {
            // Reflect the soft-delete server-side.
            serverKeys = serverKeys.map((k) =>
              k.id === state.filterId ? { ...k, revoked_at: '2026-02-01T00:00:00Z' } : k,
            );
            resolve({ error: null });
          }
          return;
        }
        // select() path
        selectCount += 1;
        if (selectCount === 1) {
          resolve({ data: activeRows(), error: null });
        } else {
          refetchGate.then((rows) => resolve({ data: rows, error: null })).catch(reject);
        }
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

import { McpSettingsPage } from '@/pages/hub/McpSettingsPage';
import { ThemeProvider } from '@/shared/ThemeProvider';

function renderMcp(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/hub/mcp']}>
          <McpSettingsPage />
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

/** Click the per-key "Revoke" button for the row containing `label`, then
 *  confirm in the modal. There are two "Revoke" buttons after the modal
 *  opens (the row button + the modal confirm); we click the modal's. */
async function revokeKey(user: ReturnType<typeof userEvent.setup>, label: string) {
  const row = screen.getByText(label).closest('div')!.parentElement!.parentElement as HTMLElement;
  const rowRevokeBtn = within(row).getByRole('button', { name: 'Revoke' });
  await user.click(rowRevokeBtn);
  // Modal now open — its confirm button is also labelled "Revoke". Pick the
  // one inside the dialog.
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
}

describe('McpSettingsPage revokeMutation — onError rollback (real component)', () => {
  beforeEach(() => {
    resetServer();
    updateShouldFail = false;
    selectCount = 0;
    armRefetchGate();
  });

  afterEach(() => {
    releaseRefetch?.(activeRows());
    vi.clearAllMocks();
  });

  it('restores the revoked key when the UPDATE rejects', async () => {
    updateShouldFail = true;
    const qc = makeQc();
    const user = userEvent.setup();
    renderMcp(qc);

    // Both keys visible.
    await screen.findByText('Production');
    expect(screen.getByText('Dev')).toBeInTheDocument();

    await revokeKey(user, 'Production');

    // onMutate removes 'Production' optimistically; UPDATE rejects; onError
    // restores it. Refetch is BLOCKED, so the rollback is the only restorer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Rolled back: 'Production' is back in the list.
    await waitFor(() => {
      expect(screen.getByText('Production')).toBeInTheDocument();
    });
    expect(screen.getByText('Dev')).toBeInTheDocument();
    // Server never revoked it.
    expect(serverKeys.find((k) => k.id === 'k1')?.revoked_at).toBeNull();

    // Release the gated refetch — list stays consistent (still 2 active).
    releaseRefetch(activeRows());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByText('Production')).toBeInTheDocument();
  });

  it('does NOT restore when the UPDATE succeeds (success-path control)', async () => {
    updateShouldFail = false;
    const qc = makeQc();
    const user = userEvent.setup();
    renderMcp(qc);

    await screen.findByText('Production');
    await revokeKey(user, 'Production');

    // Release refetch with the now-revoked server state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
      releaseRefetch(activeRows());
      await new Promise((r) => setTimeout(r, 20));
    });

    // 'Production' stays gone (server revoked it; refetch confirms).
    await waitFor(() => {
      expect(screen.queryByText('Production')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Dev')).toBeInTheDocument();
    expect(serverKeys.find((k) => k.id === 'k1')?.revoked_at).not.toBeNull();
  });
});
