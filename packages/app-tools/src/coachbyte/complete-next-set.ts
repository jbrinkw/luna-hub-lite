import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const completeNextSet: ToolDefinition = {
  name: 'COACHBYTE_complete_next_set',
  description: "Complete the next incomplete set in today's plan. Returns rest time.",
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'The plan ID to complete a set for' },
      reps: { type: 'integer', description: 'Actual reps performed' },
      load: { type: 'number', description: 'Actual load used (lbs)' },
    },
    required: ['plan_id', 'reps', 'load'],
  },
  handler: async (args, ctx) => {
    const { plan_id, reps, load } = args;

    const { data, error } = await ctx.supabase.rpc(
      'complete_next_set_admin',
      {
        p_user_id: ctx.userId,
        p_plan_id: plan_id,
        p_actual_reps: reps,
        p_actual_load: load,
      },
      { schema: 'coachbyte' },
    );

    if (error) return toolError(`Failed to complete set: ${error.message}`);

    if (!data || data.length === 0) {
      return toolError('No incomplete sets remaining in this plan');
    }

    const restSeconds = data[0].rest_seconds;

    return toolSuccess({
      message: `Set completed: ${reps} reps @ ${load} lbs`,
      rest_seconds: restSeconds,
    });
  },
};
