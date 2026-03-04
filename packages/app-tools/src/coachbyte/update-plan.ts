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

    // Build new rows
    const rows = sets.map((s: any) => ({
      plan_id,
      user_id: ctx.userId,
      exercise_id: s.exercise_id,
      target_reps: s.target_reps,
      target_load: s.target_load,
      rest_seconds: s.rest_seconds,
      order: s.order,
    }));

    // Insert new sets first, then delete old ones to avoid data loss
    // if insert fails. The brief overlap of old+new rows is harmless.
    const { data: inserted, error: insertError } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .insert(rows)
      .select('planned_set_id, exercise_id, target_reps, target_load, rest_seconds, order');

    if (insertError) return toolError(`Failed to insert new sets: ${insertError.message}`);

    // Delete old planned sets (those not in the newly inserted set)
    const newIds = inserted.map((s: any) => s.planned_set_id);
    const { error: deleteError } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .delete()
      .eq('plan_id', plan_id)
      .not('planned_set_id', 'in', `(${newIds.join(',')})`);

    if (deleteError) return toolError(`Failed to clear old sets: ${deleteError.message}`);

    return toolSuccess({
      message: `Plan updated with ${inserted.length} sets`,
      plan_id,
      sets: inserted,
    });
  },
};
