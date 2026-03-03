import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getHistory: ToolDefinition = {
  name: 'COACHBYTE_get_history',
  description: 'Get workout history for the last N days.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'Number of days of history (default 7)' },
    },
  },
  handler: async (args, ctx) => {
    const days = args.days ?? 7;

    // Fetch recent plans
    const { data: plans, error: plansError } = await ctx.supabase
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id, plan_date, summary, logical_date')
      .eq('user_id', ctx.userId)
      .order('plan_date', { ascending: false })
      .limit(days);

    if (plansError) return toolError(`Failed to fetch history: ${plansError.message}`);
    if (!plans || plans.length === 0) return toolSuccess({ message: 'No workout history found', days: [] });

    const planIds = plans.map((p: any) => p.plan_id);

    // Fetch all completed sets for these plans
    const { data: completedSets, error: csError } = await ctx.supabase
      .schema('coachbyte')
      .from('completed_sets')
      .select('completed_set_id, plan_id, exercise_id, actual_reps, actual_load, completed_at, exercises(name)')
      .in('plan_id', planIds)
      .order('completed_at', { ascending: true });

    if (csError) return toolError(`Failed to fetch completed sets: ${csError.message}`);

    // Group completed sets by plan_id
    const setsByPlan = new Map<string, any[]>();
    for (const cs of completedSets || []) {
      const list = setsByPlan.get(cs.plan_id) || [];
      list.push({
        exercise_name: cs.exercises?.name ?? null,
        actual_reps: cs.actual_reps,
        actual_load: cs.actual_load,
        completed_at: cs.completed_at,
      });
      setsByPlan.set(cs.plan_id, list);
    }

    const history = plans.map((p: any) => ({
      plan_id: p.plan_id,
      plan_date: p.plan_date,
      summary: p.summary,
      logical_date: p.logical_date,
      completed_sets: setsByPlan.get(p.plan_id) || [],
      total_sets_completed: (setsByPlan.get(p.plan_id) || []).length,
    }));

    return toolSuccess({ days: history });
  },
};
