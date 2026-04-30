/**
 * onError rollback: ExtensionsPage toggleMutation.
 *
 * hub.extension_settings upsert fails → extensions cache restored.
 * The optimistic update flips enabled + hasCredentials for the extension;
 * onError must restore the full previous snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/queryKeys';

vi.mock('@/shared/supabase', () => ({ supabase: { schema: vi.fn() } }));
vi.mock('@/shared/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

const USER_ID = 'user-ext-rollback';

interface ExtState {
  enabled: boolean;
  hasCredentials: boolean;
}
type ExtMap = Record<string, ExtState>;

function buildHandlers(qc: QueryClient) {
  const key = queryKeys.extensions(USER_ID);
  return {
    onMutate: async ({ extName, enabled }: { extName: string; enabled: boolean }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ExtMap>(key);
      qc.setQueryData<ExtMap>(key, (old) => ({
        ...old,
        [extName]: {
          ...old?.[extName],
          enabled,
          hasCredentials: enabled ? (old?.[extName]?.hasCredentials ?? false) : false,
        },
      }));
      return { previous };
    },
    onError: (_err: unknown, _vars: unknown, context: { previous?: ExtMap } | undefined) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
  };
}

describe('ExtensionsPage toggleMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores previous enabled state on failure', async () => {
    const initial: ExtMap = {
      todoist: { enabled: true, hasCredentials: true },
      obsidian: { enabled: false, hasCredentials: false },
    };
    qc.setQueryData(queryKeys.extensions(USER_ID), initial);

    const { onMutate, onError } = buildHandlers(qc);
    const ctx = await onMutate({ extName: 'todoist', enabled: false });
    // Optimistic: todoist disabled, hasCredentials cleared
    const mid = qc.getQueryData<ExtMap>(queryKeys.extensions(USER_ID))!;
    expect(mid.todoist.enabled).toBe(false);
    expect(mid.todoist.hasCredentials).toBe(false);

    onError(new Error('rls denied'), {}, ctx);
    // Rolled back
    const after = qc.getQueryData<ExtMap>(queryKeys.extensions(USER_ID))!;
    expect(after.todoist.enabled).toBe(true);
    expect(after.todoist.hasCredentials).toBe(true);
    // Sibling unchanged
    expect(after.obsidian.enabled).toBe(false);
  });

  it('is a no-op when context.previous is undefined', () => {
    const { onError } = buildHandlers(qc);
    expect(() => onError(new Error('fail'), {}, undefined)).not.toThrow();
  });

  it('enables rollback proves optimistic + restore sequence', async () => {
    const initial: ExtMap = { todoist: { enabled: false, hasCredentials: false } };
    qc.setQueryData(queryKeys.extensions(USER_ID), initial);

    const seq: boolean[] = [];
    qc.getQueryCache().subscribe((event) => {
      const data = event.query.state.data as ExtMap | undefined;
      if (!data?.todoist) return;
      const v = data.todoist.enabled;
      if (seq.length === 0 || seq[seq.length - 1] !== v) seq.push(v);
    });

    const { onMutate, onError } = buildHandlers(qc);
    const ctx = await onMutate({ extName: 'todoist', enabled: true });
    onError(new Error('fail'), {}, ctx);

    expect(seq).toEqual([true, false]);
  });
});
