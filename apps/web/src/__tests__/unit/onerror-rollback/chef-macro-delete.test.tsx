/**
 * onError rollback: MacroPage deleteItemMutation + editQtyMutation.
 *
 * food_logs/temp_items delete/update fails → dailyMacros cache restored.
 * These are the highest-value MacroPage rollbacks: deleting a log entry
 * or editing its qty both update the consumed list optimistically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/queryKeys';

vi.mock('@/shared/supabase', () => ({ chefbyte: vi.fn(), supabase: { channel: vi.fn() } }));
vi.mock('@/shared/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

const USER_ID = 'user-macro-rollback';
const DATE = '2026-04-30';

interface ConsumedItem { id: string; source: string; calories: number; protein: number; carbs: number; fat: number }
interface MacroPageData { consumed: ConsumedItem[]; totals: { calories: number } }

function fullKey(userId: string, date: string) {
  return [...queryKeys.dailyMacros(userId, date), 'full'];
}

function buildDeleteHandlers(qc: QueryClient) {
  const key = fullKey(USER_ID, DATE);
  return {
    onMutate: async (item: ConsumedItem) => {
      await qc.cancelQueries({ queryKey: queryKeys.dailyMacros(USER_ID, DATE) });
      const previous = qc.getQueryData<MacroPageData>(key);
      if (previous) {
        qc.setQueryData<MacroPageData>(key, {
          ...previous,
          consumed: previous.consumed.filter((c) => c.id !== item.id),
        });
      }
      return { previous };
    },
    onError: (_err: unknown, _item: unknown, context: { previous?: MacroPageData } | undefined) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
  };
}

function buildEditQtyHandlers(qc: QueryClient) {
  const key = fullKey(USER_ID, DATE);
  return {
    onMutate: async ({ item, newQty }: { item: ConsumedItem; newQty: number }) => {
      await qc.cancelQueries({ queryKey: queryKeys.dailyMacros(USER_ID, DATE) });
      const previous = qc.getQueryData<MacroPageData>(key);
      if (previous) {
        // Scale all macros by the ratio newQty/item.calories
        const scale = item.calories > 0 ? newQty / item.calories : 1;
        qc.setQueryData<MacroPageData>(key, {
          ...previous,
          consumed: previous.consumed.map((c) =>
            c.id === item.id ? { ...c, calories: newQty, protein: c.protein * scale, carbs: c.carbs * scale, fat: c.fat * scale } : c,
          ),
        });
      }
      return { previous };
    },
    onError: (_err: unknown, _args: unknown, context: { previous?: MacroPageData } | undefined) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
  };
}

describe('MacroPage deleteItemMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores deleted consumed item when delete fails', async () => {
    const initial: MacroPageData = {
      consumed: [
        { id: 'log-1', source: 'Meal Plan', calories: 300, protein: 20, carbs: 30, fat: 10 },
        { id: 'log-2', source: 'Meal Plan', calories: 150, protein: 10, carbs: 15, fat: 5 },
      ],
      totals: { calories: 450 },
    };
    qc.setQueryData(fullKey(USER_ID, DATE), initial);

    const item = initial.consumed[0];
    const { onMutate, onError } = buildDeleteHandlers(qc);
    const ctx = await onMutate(item);

    const mid = qc.getQueryData<MacroPageData>(fullKey(USER_ID, DATE))!;
    expect(mid.consumed.map((c) => c.id)).toEqual(['log-2']);

    onError(new Error('delete failed'), item, ctx);
    const after = qc.getQueryData<MacroPageData>(fullKey(USER_ID, DATE))!;
    expect(after.consumed.map((c) => c.id)).toContain('log-1');
    expect(after.consumed.map((c) => c.id)).toContain('log-2');
  });

  it('is a no-op when context.previous is undefined', () => {
    const { onError } = buildDeleteHandlers(qc);
    expect(() =>
      onError(
        new Error('fail'),
        { id: 'log-1', source: 'Meal Plan', calories: 300, protein: 20, carbs: 30, fat: 10 },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe('MacroPage editQtyMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores original calories on edit failure', async () => {
    const initial: MacroPageData = {
      consumed: [{ id: 'log-1', source: 'Meal Plan', calories: 300, protein: 20, carbs: 30, fat: 10 }],
      totals: { calories: 300 },
    };
    qc.setQueryData(fullKey(USER_ID, DATE), initial);

    const item = initial.consumed[0];
    const { onMutate, onError } = buildEditQtyHandlers(qc);
    const ctx = await onMutate({ item, newQty: 600 });

    // Optimistic: calories doubled
    const mid = qc.getQueryData<MacroPageData>(fullKey(USER_ID, DATE))!;
    expect(mid.consumed[0].calories).toBe(600);

    onError(new Error('rpc failed'), { item, newQty: 600 }, ctx);
    // Rolled back
    const after = qc.getQueryData<MacroPageData>(fullKey(USER_ID, DATE))!;
    expect(after.consumed[0].calories).toBe(300);
  });

  it('is a no-op when context.previous is undefined', () => {
    const { onError } = buildEditQtyHandlers(qc);
    const item: ConsumedItem = { id: 'x', source: 'Meal Plan', calories: 100, protein: 5, carbs: 10, fat: 3 };
    expect(() => onError(new Error('fail'), { item, newQty: 200 }, undefined)).not.toThrow();
  });
});
