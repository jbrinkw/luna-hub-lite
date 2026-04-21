import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';
import { loadSpecFromDb, loadSpecInputSchema, loadSpecToDb } from './load-spec';

export const updatePlan: ToolDefinition = {
  name: 'COACHBYTE_update_plan',
  description:
    "Replace all planned sets for a given plan. Each set carries a `load` value plus a `relative` flag: when relative=false (default), `load` is absolute lbs; when relative=true, `load` is a percentage of the user's estimated 1RM for that exercise.",
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
            load: loadSpecInputSchema.load,
            relative: loadSpecInputSchema.relative,
            rest_seconds: { type: 'integer' },
            order: { type: 'integer' },
          },
          required: ['exercise_id', 'target_reps', 'load', 'rest_seconds', 'order'],
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

    // Translate {load, relative} → {target_load, target_load_percentage}
    const rows = (sets as any[]).map((s) => {
      const { target_load, target_load_percentage } = loadSpecToDb({
        load: s.load,
        relative: s.relative,
      });
      return {
        plan_id,
        user_id: ctx.userId,
        exercise_id: s.exercise_id,
        target_reps: s.target_reps,
        target_load,
        target_load_percentage,
        rest_seconds: s.rest_seconds,
        order: s.order,
      };
    });

    // Delete old planned sets first, then insert new ones.
    // The FK on completed_sets.planned_set_id uses ON DELETE SET NULL,
    // so deleting planned_sets safely nullifies the reference on any
    // completed_sets that pointed to them (they become ad-hoc).
    const { error: deleteError } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .delete()
      .eq('plan_id', plan_id);

    if (deleteError) return toolError(`Failed to clear old sets: ${deleteError.message}`);

    const { data: inserted, error: insertError } = await ctx.supabase
      .schema('coachbyte')
      .from('planned_sets')
      .insert(rows)
      .select(
        'planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, order',
      );

    if (insertError) return toolError(`Failed to insert new sets: ${insertError.message}`);

    const outSets = (inserted || []).map((ps: any) => ({
      planned_set_id: ps.planned_set_id,
      exercise_id: ps.exercise_id,
      target_reps: ps.target_reps,
      ...loadSpecFromDb({
        target_load: ps.target_load,
        target_load_percentage: ps.target_load_percentage,
      }),
      rest_seconds: ps.rest_seconds,
      order: ps.order,
    }));

    return toolSuccess({
      message: `Plan updated with ${outSets.length} sets`,
      plan_id,
      sets: outSets,
    });
  },
};
