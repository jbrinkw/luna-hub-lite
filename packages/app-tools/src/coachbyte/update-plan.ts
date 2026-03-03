import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const updatePlan: ToolDefinition = {
  name: 'COACHBYTE_update_plan',
  description: 'Replace all planned sets for a given plan.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'The plan ID to update' },
      sets: {
        type: 'array',
        description: 'New planned sets',
        items: {
          type: 'object',
          properties: {
            exercise_id: { type: 'string' },
            target_reps: { type: 'integer' },
            target_load: { type: 'number' },
            rest_seconds: { type: 'integer' },
            order: { type: 'integer' },
          },
          required: ['exercise_id', 'target_reps', 'target_load', 'rest_seconds', 'order'],
        },
      },
    },
    required: ['plan_id', 'sets'],
  },
  handler: async (args, ctx) => {
    const { plan_id, sets } = args;

    // Verify the plan belongs to this user
    const { data: plan, error: planError } = await ctx.supabase
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id')
      .eq('plan_id', plan_id)
      .eq('user_id', ctx.userId)
      .single();

    if (planError || !plan) return toolError('Plan not found or not owned by user');

    // Delete existing planned sets
    const { error: deleteError } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .delete()
      .eq('plan_id', plan_id);

    if (deleteError) return toolError(`Failed to clear existing sets: ${deleteError.message}`);

    // Insert new planned sets
    const rows = sets.map((s: any) => ({
      plan_id,
      user_id: ctx.userId,
      exercise_id: s.exercise_id,
      target_reps: s.target_reps,
      target_load: s.target_load,
      rest_seconds: s.rest_seconds,
      order: s.order,
    }));

    const { data: inserted, error: insertError } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .insert(rows)
      .select('planned_set_id, exercise_id, target_reps, target_load, rest_seconds, order');

    if (insertError) return toolError(`Failed to insert new sets: ${insertError.message}`);

    return toolSuccess({
      message: `Plan updated with ${inserted.length} sets`,
      plan_id,
      sets: inserted,
    });
  },
};
