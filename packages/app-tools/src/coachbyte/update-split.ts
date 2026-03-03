import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const updateSplit: ToolDefinition = {
  name: 'COACHBYTE_update_split',
  description: 'Set the template sets for a specific weekday in the weekly split.',
  inputSchema: {
    type: 'object',
    properties: {
      weekday: {
        type: 'integer',
        description: 'Weekday number 0-6 (Sunday-Saturday)',
      },
      template_sets: {
        type: 'array',
        description: 'Template sets for this day',
        items: {
          type: 'object',
          properties: {
            exercise_id: { type: 'string' },
            target_reps: { type: 'integer' },
            target_load: { type: 'number' },
            rest_seconds: { type: 'integer' },
          },
          required: ['exercise_id', 'target_reps', 'target_load', 'rest_seconds'],
        },
      },
    },
    required: ['weekday', 'template_sets'],
  },
  handler: async (args, ctx) => {
    const { weekday, template_sets } = args;

    if (weekday < 0 || weekday > 6) {
      return toolError('weekday must be between 0 (Sunday) and 6 (Saturday)');
    }

    const { data, error } = await ctx.supabase
      .schema('coachbyte')
      .from('splits')
      .upsert(
        {
          user_id: ctx.userId,
          weekday,
          template_sets,
        },
        { onConflict: 'user_id,weekday' },
      )
      .select('split_id, weekday, template_sets')
      .single();

    if (error) return toolError(`Failed to update split: ${error.message}`);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    return toolSuccess({
      message: `Split updated for ${dayNames[weekday]}`,
      split_id: data.split_id,
      weekday: data.weekday,
      day_name: dayNames[weekday],
      template_sets: data.template_sets,
    });
  },
};
