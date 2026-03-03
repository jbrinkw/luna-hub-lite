import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getSplit: ToolDefinition = {
  name: 'COACHBYTE_get_split',
  description: 'Get weekly split configuration (all 7 days or a specific weekday).',
  inputSchema: {
    type: 'object',
    properties: {
      weekday: {
        type: 'integer',
        description: 'Weekday number 0-6 (Sunday-Saturday). Omit for all days.',
      },
    },
  },
  handler: async (args, ctx) => {
    let query = ctx.supabase
      .schema('coachbyte')
      .from('splits')
      .select('split_id, weekday, template_sets')
      .eq('user_id', ctx.userId)
      .order('weekday', { ascending: true });

    if (args.weekday !== undefined && args.weekday !== null) {
      query = query.eq('weekday', args.weekday);
    }

    const { data: splits, error } = await query;

    if (error) return toolError(`Failed to fetch splits: ${error.message}`);
    if (!splits || splits.length === 0) {
      return toolSuccess({ message: 'No split configuration found', splits: [] });
    }

    // Collect all exercise IDs from template_sets to resolve names
    const exerciseIds = new Set<string>();
    for (const split of splits) {
      for (const ts of split.template_sets || []) {
        if (ts.exercise_id) exerciseIds.add(ts.exercise_id);
      }
    }

    // Fetch exercise names
    const exerciseMap = new Map<string, string>();
    if (exerciseIds.size > 0) {
      const { data: exercises } = await ctx.supabase
        .schema('coachbyte')
        .from('exercises')
        .select('exercise_id, name')
        .in('exercise_id', Array.from(exerciseIds));

      for (const ex of exercises || []) {
        exerciseMap.set(ex.exercise_id, ex.name);
      }
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const result = splits.map((s: any) => ({
      split_id: s.split_id,
      weekday: s.weekday,
      day_name: dayNames[s.weekday],
      template_sets: (s.template_sets || []).map((ts: any) => ({
        ...ts,
        exercise_name: exerciseMap.get(ts.exercise_id) ?? null,
      })),
    }));

    return toolSuccess({ splits: result });
  },
};
