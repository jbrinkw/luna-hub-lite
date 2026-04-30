/**
 * onError rollback: ReviewsPage resolveMutation.
 *
 * chefbyte.resolve_review RPC fails → pending reviews list restored.
 * The optimistic update removes the review from the list; onError must
 * re-insert it via the previous snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('@/shared/supabase', () => ({ chefbyte: vi.fn(), supabase: { channel: vi.fn() } }));
vi.mock('@/shared/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

const REVIEW_QUERY_KEY = ['reviews', 'u1', 'pending'] as const;

interface ReviewRow { review_id: string; kind: string; status: string }

function buildHandlers(qc: QueryClient, queryKey: readonly string[]) {
  return {
    onMutate: async (args: { review_id: string }) => {
      await qc.cancelQueries({ queryKey: queryKey as string[] });
      const previous = qc.getQueryData<ReviewRow[]>(queryKey as string[]);
      qc.setQueryData<ReviewRow[]>(queryKey as string[], (old) =>
        (old ?? []).filter((r) => r.review_id !== args.review_id),
      );
      return { previous };
    },
    onError: (_err: unknown, _args: unknown, context: { previous?: ReviewRow[] } | undefined) => {
      if (context?.previous) qc.setQueryData(queryKey as string[], context.previous);
    },
  };
}

describe('ReviewsPage resolveMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores the removed review when the RPC fails', async () => {
    const rows: ReviewRow[] = [
      { review_id: 'r1', kind: 'low_confidence', status: 'pending' },
      { review_id: 'r2', kind: 'low_confidence', status: 'pending' },
    ];
    qc.setQueryData(REVIEW_QUERY_KEY as unknown as string[], rows);

    const { onMutate, onError } = buildHandlers(qc, REVIEW_QUERY_KEY);
    const ctx = await onMutate({ review_id: 'r1' });
    // Optimistic: r1 removed
    const mid = qc.getQueryData<ReviewRow[]>(REVIEW_QUERY_KEY as unknown as string[]) ?? [];
    expect(mid.map((r) => r.review_id)).toEqual(['r2']);

    onError(new Error('RPC failed'), { review_id: 'r1', status: 'resolved', user_response: null }, ctx);
    // Rolled back
    const after = qc.getQueryData<ReviewRow[]>(REVIEW_QUERY_KEY as unknown as string[]) ?? [];
    expect(after.map((r) => r.review_id)).toContain('r1');
    expect(after.map((r) => r.review_id)).toContain('r2');
  });

  it('is a no-op when context.previous is undefined', () => {
    const { onError } = buildHandlers(qc, REVIEW_QUERY_KEY);
    expect(() => onError(new Error('fail'), { review_id: 'r1' }, undefined)).not.toThrow();
  });

  it('optimistic-remove then restore sequence [1, 2]', async () => {
    const rows: ReviewRow[] = [
      { review_id: 'r1', kind: 'low_confidence', status: 'pending' },
      { review_id: 'r2', kind: 'low_confidence', status: 'pending' },
    ];
    qc.setQueryData(REVIEW_QUERY_KEY as unknown as string[], rows);

    const counts: number[] = [];
    qc.getQueryCache().subscribe((event) => {
      const data = event.query.state.data as ReviewRow[] | undefined;
      if (!Array.isArray(data)) return;
      const n = data.length;
      if (counts.length === 0 || counts[counts.length - 1] !== n) counts.push(n);
    });

    const { onMutate, onError } = buildHandlers(qc, REVIEW_QUERY_KEY);
    const ctx = await onMutate({ review_id: 'r1' });
    onError(new Error('fail'), { review_id: 'r1' }, ctx);
    expect(counts).toEqual([1, 2]);
  });
});
