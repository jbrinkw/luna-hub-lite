/**
 * onError rollback: MealPlanPage markDoneMutation + unmarkDoneMutation.
 *
 * mark_meal_done / unmark_meal_done RPC fails → mealPlan cache restored.
 * These mutations have complex onMutate (completing a meal also seeds a
 * food_logs entry in the cache); onError must restore the full snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/queryKeys';

vi.mock('@/shared/supabase', () => ({ chefbyte: vi.fn(), supabase: { channel: vi.fn() } }));
vi.mock('@/shared/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

const USER_ID = 'user-mealplan-rollback';
const START_DATE = '2026-04-30';

interface MealEntry {
  meal_id: string;
  completed_at: string | null;
  servings: number;
}
interface FoodLogEntry {
  log_id: string;
}
interface MealPlanData {
  meals: MealEntry[];
  foodLogs: FoodLogEntry[];
}

function makeMarkDoneHandlers(qc: QueryClient) {
  const key = queryKeys.mealPlan(USER_ID, START_DATE);
  return {
    onMutate: async (mealId: string) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MealPlanData>(key);
      if (previous) {
        qc.setQueryData<MealPlanData>(key, {
          ...previous,
          meals: previous.meals.map((m) => (m.meal_id === mealId ? { ...m, completed_at: '2026-04-30T12:00:00Z' } : m)),
          foodLogs: [...previous.foodLogs, { log_id: `optimistic-${mealId}` }],
        });
      }
      return { previous };
    },
    onError: (_err: unknown, _mealId: string, context: { previous?: MealPlanData } | undefined) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
  };
}

function makeUnmarkDoneHandlers(qc: QueryClient) {
  const key = queryKeys.mealPlan(USER_ID, START_DATE);
  return {
    onMutate: async (mealId: string) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MealPlanData>(key);
      if (previous) {
        qc.setQueryData<MealPlanData>(key, {
          ...previous,
          meals: previous.meals.map((m) => (m.meal_id === mealId ? { ...m, completed_at: null } : m)),
          foodLogs: previous.foodLogs.filter((l) => l.log_id !== `optimistic-${mealId}`),
        });
      }
      return { previous };
    },
    onError: (_err: unknown, _mealId: string, context: { previous?: MealPlanData } | undefined) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
  };
}

describe('MealPlanPage markDoneMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores completed_at=null and removes optimistic food_log on failure', async () => {
    const initial: MealPlanData = {
      meals: [{ meal_id: 'm1', completed_at: null, servings: 1 }],
      foodLogs: [],
    };
    qc.setQueryData(queryKeys.mealPlan(USER_ID, START_DATE), initial);

    const { onMutate, onError } = makeMarkDoneHandlers(qc);
    const ctx = await onMutate('m1');
    // Optimistic
    const mid = qc.getQueryData<MealPlanData>(queryKeys.mealPlan(USER_ID, START_DATE))!;
    expect(mid.meals[0].completed_at).not.toBeNull();
    expect(mid.foodLogs.some((l) => l.log_id === 'optimistic-m1')).toBe(true);

    onError(new Error('rpc failed'), 'm1', ctx);
    // Rolled back
    const after = qc.getQueryData<MealPlanData>(queryKeys.mealPlan(USER_ID, START_DATE))!;
    expect(after.meals[0].completed_at).toBeNull();
    expect(after.foodLogs.some((l) => l.log_id === 'optimistic-m1')).toBe(false);
  });

  it('is a no-op when context.previous is undefined', () => {
    const { onError } = makeMarkDoneHandlers(qc);
    expect(() => onError(new Error('fail'), 'm1', undefined)).not.toThrow();
  });
});

describe('MealPlanPage unmarkDoneMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores completed_at and re-inserts food_log on failure', async () => {
    const initial: MealPlanData = {
      meals: [{ meal_id: 'm1', completed_at: '2026-04-30T12:00:00Z', servings: 1 }],
      foodLogs: [{ log_id: 'real-log-1' }],
    };
    qc.setQueryData(queryKeys.mealPlan(USER_ID, START_DATE), initial);

    const { onMutate, onError } = makeUnmarkDoneHandlers(qc);
    const ctx = await onMutate('m1');
    // Optimistic: completed_at cleared
    const mid = qc.getQueryData<MealPlanData>(queryKeys.mealPlan(USER_ID, START_DATE))!;
    expect(mid.meals[0].completed_at).toBeNull();

    onError(new Error('fail'), 'm1', ctx);
    // Rolled back
    const after = qc.getQueryData<MealPlanData>(queryKeys.mealPlan(USER_ID, START_DATE))!;
    expect(after.meals[0].completed_at).toBe('2026-04-30T12:00:00Z');
    expect(after.foodLogs.some((l) => l.log_id === 'real-log-1')).toBe(true);
  });
});
