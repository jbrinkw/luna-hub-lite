import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const updateSummary: ToolDefinition = {
  name: 'COACHBYTE_update_summary',
  description: 'Update the summary note on a daily plan.',
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: { type: 'string', description: 'The plan ID to update' },
      summary: { type: 'string', description: 'New summary text' },
    },
    required: ['plan_id', 'summary'],
  },
  handler: async (args, ctx) => {
    const { plan_id, summary } = args;

    const { data, error } = await ctx.supabase
      .schema('coachbyte')
      .from('daily_plans')
      .update({ summary })
      .eq('plan_id', plan_id)
      .eq('user_id', ctx.userId)
      .select('plan_id, summary')
      .single();

    if (error) return toolError(`Failed to update summary: ${error.message}`);
    if (!data) return toolError('Plan not found or not owned by user');

    return toolSuccess({
      message: 'Summary updated',
      plan_id: data.plan_id,
      summary: data.summary,
    });
  },
};
