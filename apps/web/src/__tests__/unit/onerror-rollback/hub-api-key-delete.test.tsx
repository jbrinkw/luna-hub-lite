/**
 * onError rollback: McpSettingsPage deleteMutation.
 *
 * hub.mcp_api_keys delete fails → api-keys cache restored.
 * The optimistic update removes the key from the list; onError must
 * re-insert it via the previous snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/queryKeys';

vi.mock('@/shared/supabase', () => ({ supabase: { schema: vi.fn() } }));
vi.mock('@/shared/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

const USER_ID = 'user-api-key-rollback';

interface ApiKey {
  key_id: string;
  name: string;
  created_at: string;
}

function buildHandlers(qc: QueryClient) {
  const key = queryKeys.apiKeys(USER_ID);
  return {
    onMutate: async (keyId: string) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ApiKey[]>(key);
      qc.setQueryData<ApiKey[]>(key, (old) => (old ?? []).filter((k) => k.key_id !== keyId));
      return { previous };
    },
    onError: (_err: unknown, _vars: unknown, context: { previous?: ApiKey[] } | undefined) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
  };
}

describe('McpSettingsPage deleteMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores the deleted key when the delete fails', async () => {
    const keys: ApiKey[] = [
      { key_id: 'k1', name: 'Production', created_at: '2026-01-01Z' },
      { key_id: 'k2', name: 'Dev', created_at: '2026-01-02Z' },
    ];
    qc.setQueryData(queryKeys.apiKeys(USER_ID), keys);

    const { onMutate, onError } = buildHandlers(qc);
    const ctx = await onMutate('k1');
    // Optimistic: k1 removed
    expect((qc.getQueryData<ApiKey[]>(queryKeys.apiKeys(USER_ID)) ?? []).map((k) => k.key_id)).toEqual(['k2']);

    onError(new Error('delete failed'), 'k1', ctx);
    // Rolled back: k1 restored
    const after = qc.getQueryData<ApiKey[]>(queryKeys.apiKeys(USER_ID)) ?? [];
    expect(after.map((k) => k.key_id)).toContain('k1');
    expect(after.map((k) => k.key_id)).toContain('k2');
  });

  it('is a no-op when context.previous is undefined', () => {
    const { onError } = buildHandlers(qc);
    expect(() => onError(new Error('fail'), 'k1', undefined)).not.toThrow();
  });

  it('sequence [1 key, 2 keys] proves optimistic remove + restore', async () => {
    const keys: ApiKey[] = [
      { key_id: 'k1', name: 'A', created_at: '2026-01-01Z' },
      { key_id: 'k2', name: 'B', created_at: '2026-01-02Z' },
    ];
    qc.setQueryData(queryKeys.apiKeys(USER_ID), keys);

    const counts: number[] = [];
    qc.getQueryCache().subscribe((event) => {
      const data = event.query.state.data as ApiKey[] | undefined;
      if (!Array.isArray(data)) return;
      const n = data.length;
      if (counts.length === 0 || counts[counts.length - 1] !== n) counts.push(n);
    });

    const { onMutate, onError } = buildHandlers(qc);
    const ctx = await onMutate('k1');
    onError(new Error('fail'), 'k1', ctx);

    expect(counts).toEqual([1, 2]);
  });
});
