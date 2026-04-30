/**
 * onError rollback: TodayPage completeSetMutation.
 *
 * coachbyte.complete_next_set RPC fails → dailyPlan cache restored.
 * The optimistic update marks the set completed and adds it to completedSets;
 * onError must restore both sub-arrays via context.prev.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/shared/queryKeys';

vi.mock('@/shared/supabase', () => ({ coachbyte: vi.fn(), supabase: { channel: vi.fn() } }));
vi.mock('@/shared/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/shared/useRealtimeInvalidation', () => ({ useRealtimeInvalidation: vi.fn() }));

const USER_ID = 'user-coach-rollback';
const TODAY = '2026-04-30';

interface PlannedSet {
  planned_set_id: string;
  exercise_name: string;
  exercise_id: string;
  completed: boolean;
}
interface CompletedSet {
  completed_set_id: string;
  exercise_name: string;
  actual_reps: number;
  actual_load: number;
  completed_at: string;
}
interface DailyPlanData {
  sets: PlannedSet[];
  completedSets: CompletedSet[];
}

function buildHandlers(qc: QueryClient) {
  const queryKey = queryKeys.dailyPlan(USER_ID, TODAY);
  return {
    onMutate: async ({ reps, load }: { reps: number; load: number }) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<DailyPlanData>(queryKey);
      if (!prev) return { prev };
      const targetSet = prev.sets.find((s) => !s.completed);
      if (!targetSet) return { prev };
      const optimisticSet: CompletedSet = {
        completed_set_id: `optimistic-${targetSet.planned_set_id}`,
        exercise_name: targetSet.exercise_name,
        actual_reps: reps,
        actual_load: load,
        completed_at: new Date().toISOString(),
      };
      qc.setQueryData<DailyPlanData>(queryKey, {
        ...prev,
        sets: prev.sets.map((s) => (s.planned_set_id === targetSet.planned_set_id ? { ...s, completed: true } : s)),
        completedSets: [...prev.completedSets, optimisticSet],
      });
      return { prev, targetSet };
    },
    onError: (_err: unknown, _vars: unknown, ctx: { prev?: DailyPlanData } | undefined) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
    },
  };
}

describe('TodayPage completeSetMutation — onError rollback', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('restores sets.completed=false and empties completedSets on failure', async () => {
    const initial: DailyPlanData = {
      sets: [
        { planned_set_id: 'ps-1', exercise_name: 'Squat', exercise_id: 'ex-1', completed: false },
        { planned_set_id: 'ps-2', exercise_name: 'Squat', exercise_id: 'ex-1', completed: false },
      ],
      completedSets: [],
    };
    qc.setQueryData(queryKeys.dailyPlan(USER_ID, TODAY), initial);

    const { onMutate, onError } = buildHandlers(qc);
    const ctx = await onMutate({ reps: 8, load: 100 });

    // Optimistic: ps-1 completed
    const mid = qc.getQueryData<DailyPlanData>(queryKeys.dailyPlan(USER_ID, TODAY))!;
    expect(mid.sets.find((s) => s.planned_set_id === 'ps-1')!.completed).toBe(true);
    expect(mid.completedSets).toHaveLength(1);

    onError(new Error('RPC failed'), { reps: 8, load: 100 }, ctx);

    // Rolled back
    const after = qc.getQueryData<DailyPlanData>(queryKeys.dailyPlan(USER_ID, TODAY))!;
    expect(after.sets.find((s) => s.planned_set_id === 'ps-1')!.completed).toBe(false);
    expect(after.completedSets).toHaveLength(0);
  });

  it('is a no-op when no prev in context', () => {
    const { onError } = buildHandlers(qc);
    expect(() => onError(new Error('fail'), { reps: 5, load: 80 }, undefined)).not.toThrow();
  });

  it('sequence [1 completedSet, 0 completedSets] proves optimistic + restore', async () => {
    const initial: DailyPlanData = {
      sets: [{ planned_set_id: 'ps-1', exercise_name: 'Bench', exercise_id: 'ex-2', completed: false }],
      completedSets: [],
    };
    qc.setQueryData(queryKeys.dailyPlan(USER_ID, TODAY), initial);

    const counts: number[] = [];
    qc.getQueryCache().subscribe((event) => {
      const data = event.query.state.data as DailyPlanData | undefined;
      if (!data?.completedSets) return;
      const n = data.completedSets.length;
      if (counts.length === 0 || counts[counts.length - 1] !== n) counts.push(n);
    });

    const { onMutate, onError } = buildHandlers(qc);
    const ctx = await onMutate({ reps: 5, load: 80 });
    onError(new Error('fail'), { reps: 5, load: 80 }, ctx);

    expect(counts).toEqual([1, 0]);
  });
});
