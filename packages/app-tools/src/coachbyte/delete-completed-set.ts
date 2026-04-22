import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const deleteCompletedSet: ToolDefinition = {
  name: 'COACHBYTE_delete_completed_set',
  description:
    'Delete a single completed set (planned-set completion or ad-hoc log entry). Use to undo accidental log_set or complete_next_set entries — e.g. typos that would poison PR derivation. RLS scopes the delete to the calling user, so a wrong UUID just returns "not found" rather than touching another user.',
  inputSchema: {
    type: 'object',
    properties: {
      completed_set_id: {
        type: 'string',
        description: 'The completed_set_id (UUID) to delete. Find it via get_today_plan or get_history.',
      },
    },
    required: ['completed_set_id'],
  },
  handler: async (args, ctx) => {
    const { completed_set_id } = args;

    if (typeof completed_set_id !== 'string' || completed_set_id.length < 30) {
      return toolError('completed_set_id must be a UUID string');
    }

    const { data, error } = await ctx.supabase
      .schema('coachbyte')
      .from('completed_sets')
      .delete()
      .eq('completed_set_id', completed_set_id)
      .eq('user_id', ctx.userId)
      .select('completed_set_id, exercise_id, actual_reps, actual_load, completed_at')
      .maybeSingle();

    if (error) return toolError(`Failed to delete completed set: ${error.message}`);
    if (!data) return toolError(`Completed set ${completed_set_id} not found (or not owned by you)`);

    return toolSuccess({
      message: `Deleted completed set ${completed_set_id}`,
      deleted: data,
    });
  },
};
