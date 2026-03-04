import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getExercises: ToolDefinition = {
  name: 'COACHBYTE_get_exercises',
  description: 'Get all exercises for the user.',
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search term to filter by name (case-insensitive)' },
    },
  },
  handler: async (args, ctx) => {
    // Schema cast needed: coachbyte tables aren't in generated Database types
    const coachbyte = ctx.supabase.schema('coachbyte') as any;
    let query = coachbyte
      .from('exercises')
      .select('exercise_id, name, created_at')
      .eq('user_id', ctx.userId)
      .order('name', { ascending: true });

    if (args.search) {
      query = query.ilike('name', `%${args.search}%`);
    }

    const { data, error } = await query;

    if (error) return toolError(`Failed to fetch exercises: ${error.message}`);

    return toolSuccess({ exercises: data || [], total: (data || []).length });
  },
};
