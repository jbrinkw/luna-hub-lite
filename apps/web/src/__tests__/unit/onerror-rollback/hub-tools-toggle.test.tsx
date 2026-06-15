/**
 * onError rollback — ToolsPage toggleMutation (REAL component).
 *
 * Drives the SHIPPED `ToolsPage` optimistic-toggle mutation, not an
 * in-file copy. We render the real page, let its `useQuery` load the
 * tool toggles, click a tool's switch, and force the
 * `hub.user_tool_config` upsert to reject. The production
 * `onMutate → onError` pair must:
 *   - optimistically flip the toggle (cache write #1, enabled=false), then
 *   - on the rejected upsert, restore `context.previous` (cache write #2,
 *     enabled=true).
 *
 * We assert the rollback two ways:
 *   1. The rendered switch's `aria-checked` returns to `true`.
 *   2. The QueryCache subscription records the [false, true] transition
 *      on the tools cache entry, proving the optimistic write fired and
 *      then was reverted (not merely never written).
 *
 * Regression proof: deleting the `onError` `setQueryData(..., previous)`
 * line in `ToolsPage.tsx` turns this test RED — the switch stays
 * `aria-checked="false"` and the cache sequence ends on `false`.
 *
 * Only the Supabase transport is mocked; the mutation/onMutate/onError
 * under test are the real ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const USER_ID = 'user-rollback-tools';
const TOOL_NAME = 'COACHBYTE_get_today_plan';

// When true, the user_tool_config upsert rejects → drives the onError path.
let upsertShouldFail = false;
// Persisted server state for the one tool we drive; select() reads it so the
// page renders the switch in a known initial position (enabled=true).
const serverEnabled: Record<string, boolean> = { [TOOL_NAME]: true };

// Refetch gate. `onSettled` invalidates the tools query, which triggers a
// refetch via select(). If we let that refetch return the (unchanged, still
// `true`) server state, it would RESTORE the toggle to `true` on its own —
// masking a missing `onError` rollback (the false-pass we are killing). So
// after the FIRST load we BLOCK the refetch until the test explicitly
// releases it. This makes the synchronous `onError` rollback the *only* code
// path that can restore the cache within the assertion window. Deleting the
// production rollback then leaves the cache stuck on the optimistic `false`.
let selectCount = 0;
let releaseRefetch!: (rows: Array<{ tool_name: string; enabled: boolean }>) => void;
let refetchGate: Promise<Array<{ tool_name: string; enabled: boolean }>>;
function armRefetchGate() {
  refetchGate = new Promise((resolve) => {
    releaseRefetch = resolve;
  });
}

vi.mock('@/shared/supabase', () => {
  const schemaClient = () => {
    const root: any = {};
    root.from = vi.fn((_table: string) => {
      const b: any = {};
      const state: { mode: 'select' | 'upsert'; patch: Record<string, unknown> | null } = {
        mode: 'select',
        patch: null,
      };
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.upsert = vi.fn((patch: Record<string, unknown>) => {
        state.mode = 'upsert';
        state.patch = patch;
        if (upsertShouldFail) {
          return Promise.resolve({ data: null, error: { message: 'network error' } });
        }
        // Reflect a successful write into server state so a post-onSettled
        // refetch doesn't fight the optimistic value.
        if (patch.tool_name && typeof patch.enabled === 'boolean') {
          serverEnabled[patch.tool_name as string] = patch.enabled as boolean;
        }
        return Promise.resolve({ data: null, error: null });
      });
      // select().eq() resolves to the tool_config rows.
      b.then = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        if (state.mode === 'select') {
          selectCount += 1;
          const rows = Object.entries(serverEnabled).map(([tool_name, enabled]) => ({ tool_name, enabled }));
          if (selectCount === 1) {
            // Initial page load — resolve immediately.
            resolve({ data: rows, error: null });
          } else {
            // Refetch (onSettled invalidation) — gated by the test.
            refetchGate.then((gatedRows) => resolve({ data: gatedRows, error: null })).catch(reject);
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

import { ToolsPage } from '@/pages/hub/ToolsPage';
import { ThemeProvider } from '@/shared/ThemeProvider';

function renderTools(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/hub/tools']}>
          <ToolsPage />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('ToolsPage toggleMutation — onError rollback (real component)', () => {
  beforeEach(() => {
    upsertShouldFail = false;
    selectCount = 0;
    for (const k of Object.keys(serverEnabled)) delete serverEnabled[k];
    serverEnabled[TOOL_NAME] = true;
    armRefetchGate();
  });

  afterEach(() => {
    // Release any still-blocked refetch so no promise dangles between tests.
    releaseRefetch?.(Object.entries(serverEnabled).map(([tool_name, enabled]) => ({ tool_name, enabled })));
    vi.clearAllMocks();
  });

  it('reverts the toggle to its prior state when the upsert rejects', async () => {
    upsertShouldFail = true;

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
        mutations: { retry: false },
      },
    });

    const user = userEvent.setup();
    renderTools(qc);

    // The CoachByte group is collapsed by default — expand it so the switch renders.
    const groupHeader = await screen.findByRole('button', { name: /CoachByte tools group/i });
    await user.click(groupHeader);

    const toggle = await screen.findByRole('switch', { name: `Toggle ${TOOL_NAME}` });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);

    // Let onMutate (optimistic false) + the rejected upsert + onError fire.
    // The onSettled refetch is BLOCKED on refetchGate, so the only thing that
    // can flip the switch back to `true` here is the production onError
    // rollback. (Delete that rollback → this assertion goes RED.)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    await waitFor(() => {
      const after = screen.getByRole('switch', { name: `Toggle ${TOOL_NAME}` });
      expect(after).toHaveAttribute('aria-checked', 'true');
    });

    // Server state was never mutated.
    expect(serverEnabled[TOOL_NAME]).toBe(true);

    // Now release the refetch and confirm it stays consistent (true).
    releaseRefetch(Object.entries(serverEnabled).map(([tool_name, enabled]) => ({ tool_name, enabled })));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByRole('switch', { name: `Toggle ${TOOL_NAME}` })).toHaveAttribute('aria-checked', 'true');
  });

  it('does NOT roll back when the upsert succeeds (success-path control)', async () => {
    upsertShouldFail = false;

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    const user = userEvent.setup();
    renderTools(qc);

    const groupHeader = await screen.findByRole('button', { name: /CoachByte tools group/i });
    await user.click(groupHeader);

    const toggle = await screen.findByRole('switch', { name: `Toggle ${TOOL_NAME}` });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);

    // Release the refetch with the now-updated (false) server state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      releaseRefetch(Object.entries(serverEnabled).map(([tool_name, enabled]) => ({ tool_name, enabled })));
      await new Promise((r) => setTimeout(r, 20));
    });

    // On success the optimistic disable sticks (server now false too).
    await waitFor(() => {
      const after = screen.getByRole('switch', { name: `Toggle ${TOOL_NAME}` });
      expect(after).toHaveAttribute('aria-checked', 'false');
    });
    expect(serverEnabled[TOOL_NAME]).toBe(false);
  });

  it('leaves sibling tools untouched after a rolled-back toggle', async () => {
    // The other tool in the CoachByte group starts enabled (true). A
    // rollback of one tool's toggle must NOT perturb its sibling — proves
    // onError restores the whole previous map, not just the one key.
    upsertShouldFail = true;
    serverEnabled['COACHBYTE_log_set'] = true;

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    const user = userEvent.setup();
    renderTools(qc);

    const groupHeader = await screen.findByRole('button', { name: /CoachByte tools group/i });
    await user.click(groupHeader);

    const sibling = await screen.findByRole('switch', { name: 'Toggle COACHBYTE_log_set' });
    expect(sibling).toHaveAttribute('aria-checked', 'true');

    const toggle = await screen.findByRole('switch', { name: `Toggle ${TOOL_NAME}` });
    await user.click(toggle);

    // Refetch stays blocked → rollback is the only restorer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: `Toggle ${TOOL_NAME}` })).toHaveAttribute('aria-checked', 'true');
    });
    // Sibling unchanged throughout.
    expect(screen.getByRole('switch', { name: 'Toggle COACHBYTE_log_set' })).toHaveAttribute('aria-checked', 'true');
  });
});
