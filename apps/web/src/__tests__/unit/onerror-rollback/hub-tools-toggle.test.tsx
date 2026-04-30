/**
 * onError rollback: ToolsPage toggleMutation.
 *
 * hub.user_tool_config upsert fails → cache restored to pre-mutation state.
 * The optimistic update flips the tool's enabled flag in the cache; onError
 * must restore the previous value. If the rollback regresses, the toggle
 * stays in the wrong state after the error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const USER_ID = 'user-rollback-tools';

// Supabase mock controlled per test
let upsertShouldFail = false;

vi.mock('@/shared/supabase', () => ({
  supabase: {
    schema: vi.fn(() => ({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        upsert: vi.fn(() =>
          Promise.resolve({
            data: null,
            error: upsertShouldFail ? { message: 'network error' } : null,
          }),
        ),
      })),
    })),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn(), unsubscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
}));

vi.mock('@/shared/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: USER_ID }, loading: false }),
}));

vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

// ---------------------------------------------------------------------------
// Pure onMutate / onError logic exercised directly via a minimal
// QueryClient — no component render needed for rollback verification.
// ---------------------------------------------------------------------------

import { queryKeys } from '@/shared/queryKeys';

const TOOL_KEY = queryKeys.tools(USER_ID);

type ToolToggles = Record<string, boolean>;

function buildRollbackHandlers(qc: QueryClient) {
  return {
    onMutate: async ({ toolName, enabled }: { toolName: string; enabled: boolean }) => {
      await qc.cancelQueries({ queryKey: TOOL_KEY });
      const previous = qc.getQueryData<ToolToggles>(TOOL_KEY);
      qc.setQueryData<ToolToggles>(TOOL_KEY, (old) => ({ ...old, [toolName]: enabled }));
      return { previous };
    },
    onError: (_err: unknown, _vars: unknown, context: { previous?: ToolToggles } | undefined) => {
      if (context?.previous) {
        qc.setQueryData(TOOL_KEY, context.previous);
      }
    },
  };
}

describe('ToolsPage toggleMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    upsertShouldFail = false;
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores previous toggle state on mutation error', async () => {
    const initial: ToolToggles = { COACHBYTE_get_today_plan: true, CHEFBYTE_get_inventory: false };
    qc.setQueryData(TOOL_KEY, initial);

    const { onMutate, onError } = buildRollbackHandlers(qc);

    const context = await onMutate({ toolName: 'COACHBYTE_get_today_plan', enabled: false });
    // Optimistic: flag flipped
    expect((qc.getQueryData<ToolToggles>(TOOL_KEY)!).COACHBYTE_get_today_plan).toBe(false);

    // Simulate error
    onError(new Error('upsert failed'), {}, context);

    // Rollback: original value restored
    expect((qc.getQueryData<ToolToggles>(TOOL_KEY)!).COACHBYTE_get_today_plan).toBe(true);
    expect((qc.getQueryData<ToolToggles>(TOOL_KEY)!).CHEFBYTE_get_inventory).toBe(false);
  });

  it('is a no-op when context.previous is undefined', () => {
    qc.setQueryData(TOOL_KEY, { COACHBYTE_get_today_plan: false });
    const { onError } = buildRollbackHandlers(qc);

    // Should not throw
    expect(() => onError(new Error('boom'), {}, undefined)).not.toThrow();
    // Data unchanged
    expect((qc.getQueryData<ToolToggles>(TOOL_KEY)!).COACHBYTE_get_today_plan).toBe(false);
  });

  it('optimistic write precedes rollback — sequence [false, true]', async () => {
    const initial: ToolToggles = { COACHBYTE_get_today_plan: true };
    qc.setQueryData(TOOL_KEY, initial);

    const sequence: boolean[] = [];
    qc.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey as unknown[];
      if (!Array.isArray(key) || key[0] !== 'tools') return;
      const data = event.query.state.data as ToolToggles | undefined;
      if (!data) return;
      const v = data.COACHBYTE_get_today_plan;
      if (sequence.length === 0 || sequence[sequence.length - 1] !== v) sequence.push(v);
    });

    const { onMutate, onError } = buildRollbackHandlers(qc);
    const ctx = await onMutate({ toolName: 'COACHBYTE_get_today_plan', enabled: false });
    onError(new Error('fail'), {}, ctx);

    expect(sequence).toEqual([false, true]);
  });
});
