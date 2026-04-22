import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, getLogicalDate } from '../shared';
import { EXERCISE_REF_DESCRIPTION, resolveExerciseRef } from './exercise-ref';

export const logSet: ToolDefinition = {
  name: 'COACHBYTE_log_set',
  description: "Log an ad-hoc completed set (not part of today's plan).",
  inputSchema: {
    type: 'object',
    properties: {
      exercise_id: { type: 'string', description: EXERCISE_REF_DESCRIPTION },
      reps: { type: 'integer', description: 'Reps performed' },
      load: { type: 'number', description: 'Load used (lbs)' },
    },
    required: ['exercise_id', 'reps', 'load'],
  },
  handler: async (args, ctx) => {
    const { exercise_id, reps, load } = args;

    // Sanity caps — protect PR-derivation from typos like 9999×50.
    if (!Number.isInteger(reps) || reps < 1) {
      return toolError('reps must be an integer >= 1');
    }
    if (reps > 50) {
      return toolError('reps must be <= 50 (sanity cap; edit the DB row directly if you really did this)');
    }
    if (typeof load !== 'number' || Number.isNaN(load) || load < 0) {
      return toolError('load must be a number >= 0');
    }
    if (load > 2000) {
      return toolError('load must be <= 2000 lbs (sanity cap; edit the DB row directly if you really did this)');
    }

    const { id: resolvedExerciseId, unresolved } = await resolveExerciseRef(
      ctx.supabase,
      ctx.userId,
      exercise_id,
    );
    if (unresolved.length > 0 || !resolvedExerciseId) {
      return toolError(`Unknown exercise: "${exercise_id}"`);
    }
    const logicalDate = await getLogicalDate(ctx.supabase, ctx.userId);

    // Ensure a plan exists for today (need plan_id as FK)
    const { data: rpcResult, error: rpcError } = await ctx.supabase
      .schema('coachbyte')
      .rpc('ensure_daily_plan_admin', { p_user_id: ctx.userId, p_day: logicalDate });

    if (rpcError) return toolError(`Failed to ensure daily plan: ${rpcError.message}`);

    const planId = rpcResult?.plan_id;
    if (!planId) return toolError('No plan_id returned from ensure_daily_plan_admin');

    // Insert ad-hoc completed set (no planned_set_id)
    const { data: inserted, error: insertError } = await ctx.supabase
      .schema('coachbyte')
      .from('completed_sets')
      .insert({
        plan_id: planId,
        planned_set_id: null,
        exercise_id: resolvedExerciseId,
        user_id: ctx.userId,
        actual_reps: reps,
        actual_load: load,
        logical_date: logicalDate,
      })
      .select('completed_set_id, actual_reps, actual_load, completed_at')
      .single();

    if (insertError) return toolError(`Failed to log set: ${insertError.message}`);

    return toolSuccess({
      message: `Ad-hoc set logged: ${reps} reps @ ${load} lbs`,
      completed_set_id: inserted.completed_set_id,
      completed_at: inserted.completed_at,
    });
  },
};
