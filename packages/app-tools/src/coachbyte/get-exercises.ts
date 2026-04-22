import type { ToolDefinition } from '../types';
import { toolSuccess, toolError, escapeIlike } from '../shared';

export const getExercises: ToolDefinition = {
  name: 'COACHBYTE_get_exercises',
  description:
    "Get all exercises available to the user: the seeded global exercise library plus the user's custom exercises. Optionally filter by name (case-insensitive).",
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search term to filter by name (case-insensitive)' },
    },
  },
  handler: async (args, ctx) => {
    // Schema cast needed: coachbyte tables aren't in generated Database types
    const coachbyte = ctx.supabase.schema('coachbyte') as any;
    // RLS already restricts reads to globals (user_id IS NULL) + this user's rows,
    // but we mirror the filter here so the intent is explicit and the query can
    // skip a full scan when RLS is bypassed (admin client).
    let query = coachbyte
      .from('exercises')
      .select('exercise_id, name, created_at, user_id')
      .or(`user_id.is.null,user_id.eq.${ctx.userId}`)
      .order('name', { ascending: true });

    if (args.search) {
      query = query.ilike('name', `%${escapeIlike(args.search)}%`);
    }

    const { data, error } = await query;

    if (error) return toolError(`Failed to fetch exercises: ${error.message}`);

    const exercises = (data || []).map((row: any) => ({
      exercise_id: row.exercise_id,
      name: row.name,
      created_at: row.created_at,
      is_global: row.user_id === null,
    }));

    return toolSuccess({ exercises, total: exercises.length });
  },
};
