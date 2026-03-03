import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';

export const getTodayPlan: ToolDefinition = {
  name: 'COACHBYTE_get_today_plan',
  description:
    "Get today's workout plan with all planned and completed sets. Creates plan from weekly split if none exists.",
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, ctx) => {
    const logicalDate = await getLogicalDate(ctx.supabase, ctx.userId);

    // Ensure a plan exists (creates from split template if needed)
    const { data: rpcResult, error: rpcError } = await ctx.supabase.rpc(
      'ensure_daily_plan_admin',
      { p_user_id: ctx.userId, p_day: logicalDate },
      { schema: 'coachbyte' },
    );

    if (rpcError) return toolError(`Failed to ensure daily plan: ${rpcError.message}`);

    const planId = rpcResult?.plan_id;
    if (!planId) return toolError('No plan_id returned from ensure_daily_plan_admin');

    // Fetch the plan
    const { data: plan, error: planError } = await ctx.supabase
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id, plan_date, summary, logical_date')
      .eq('plan_id', planId)
      .single();

    if (planError) return toolError(`Failed to fetch plan: ${planError.message}`);

    // Fetch planned sets with exercise names
    const { data: plannedSets, error: psError } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .select('planned_set_id, exercise_id, target_reps, target_load, rest_seconds, order, exercises(name)')
      .eq('plan_id', planId)
      .order('order', { ascending: true });

    if (psError) return toolError(`Failed to fetch planned sets: ${psError.message}`);

    // Fetch completed sets
    const { data: completedSets, error: csError } = await ctx.supabase
      .schema('coachbyte')
      .from('completed_sets')
      .select('completed_set_id, planned_set_id, exercise_id, actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', planId)
      .order('completed_at', { ascending: true });

    if (csError) return toolError(`Failed to fetch completed sets: ${csError.message}`);

    const completedPlannedIds = new Set(
      (completedSets || [])
        .filter((cs: any) => cs.planned_set_id)
        .map((cs: any) => cs.planned_set_id),
    );

    const sets = (plannedSets || []).map((ps: any) => ({
      planned_set_id: ps.planned_set_id,
      exercise_id: ps.exercise_id,
      exercise_name: ps.exercises?.name ?? null,
      target_reps: ps.target_reps,
      target_load: ps.target_load,
      rest_seconds: ps.rest_seconds,
      order: ps.order,
      completed: completedPlannedIds.has(ps.planned_set_id),
    }));

    // Include ad-hoc sets (completed sets with no planned_set_id)
    const adHocSets = (completedSets || [])
      .filter((cs: any) => !cs.planned_set_id)
      .map((cs: any) => ({
        completed_set_id: cs.completed_set_id,
        exercise_id: cs.exercise_id,
        exercise_name: cs.exercises?.name ?? null,
        actual_reps: cs.actual_reps,
        actual_load: cs.actual_load,
        completed_at: cs.completed_at,
        ad_hoc: true,
      }));

    return toolSuccess({
      plan_id: plan.plan_id,
      plan_date: plan.plan_date,
      summary: plan.summary,
      logical_date: plan.logical_date,
      sets,
      ad_hoc_sets: adHocSets,
      total_planned: sets.length,
      completed_count: completedPlannedIds.size,
      ad_hoc_count: adHocSets.length,
    });
  },
};
