import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';
import { loadSpecFromDb } from './load-spec';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const getSplit: ToolDefinition = {
  name: 'COACHBYTE_get_split',
  description:
    "Get weekly split configuration. Returns one entry per weekday in the requested range; rest days (never created or emptied) come back as `{split_id: null, template_sets: []}` rather than being omitted, so callers don't need to special-case missing days. Each template set carries `load` and `relative`.",
  inputSchema: {
    type: 'object',
    properties: {
      weekday: {
        type: 'integer',
        description: 'Weekday number 0-6 (Sunday-Saturday). Omit for all 7 days.',
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

    // Resolve exercise names referenced by any template_set
    const exerciseIds = new Set<string>();
    for (const split of splits ?? []) {
      for (const ts of split.template_sets || []) {
        if (ts.exercise_id) exerciseIds.add(ts.exercise_id);
      }
    }
    const exerciseMap = new Map<string, string>();
    if (exerciseIds.size > 0) {
      const { data: exercises } = await ctx.supabase
        .schema('coachbyte')
        .from('exercises')
        .select('exercise_id, name')
        .in('exercise_id', Array.from(exerciseIds));
      for (const ex of (exercises as any[]) ?? []) {
        exerciseMap.set(ex.exercise_id, ex.name);
      }
    }

    const splitByWeekday = new Map<number, any>();
    for (const s of splits ?? []) {
      splitByWeekday.set(s.weekday, s);
    }

    const buildEntry = (weekday: number) => {
      const s = splitByWeekday.get(weekday);
      if (!s) {
        return {
          weekday,
          day_name: DAY_NAMES[weekday],
          split_id: null,
          template_sets: [],
        };
      }
      return {
        weekday,
        day_name: DAY_NAMES[weekday],
        split_id: s.split_id,
        template_sets: (s.template_sets || []).map((ts: any) => ({
          exercise_id: ts.exercise_id,
          exercise_name: exerciseMap.get(ts.exercise_id) ?? null,
          target_reps: ts.target_reps,
          ...loadSpecFromDb({
            target_load: ts.target_load ?? null,
            target_load_percentage: ts.target_load_percentage ?? null,
          }),
          rest_seconds: ts.rest_seconds,
        })),
      };
    };

    let result: any[];
    if (args.weekday !== undefined && args.weekday !== null) {
      result = [buildEntry(args.weekday)];
    } else {
      // Always 7 entries, in weekday order, for predictable consumption
      result = Array.from({ length: 7 }, (_, i) => buildEntry(i));
    }

    return toolSuccess({ splits: result });
  },
};
