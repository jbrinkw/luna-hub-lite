import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';

export const getPrs: ToolDefinition = {
  name: 'COACHBYTE_get_prs',
  description: 'Get personal records for all exercises using Epley formula.',
  inputSchema: {
    type: 'object',
    properties: {
      exercise_id: {
        type: 'string',
        description: 'Optional exercise UUID to filter to a specific exercise',
      },
    },
  },
  handler: async (args, ctx) => {
    // Schema cast needed: coachbyte tables aren't in generated Database types
    const coachbyte = ctx.supabase.schema('coachbyte') as any;
    let query = coachbyte
      .from('completed_sets')
      .select('completed_set_id, exercise_id, actual_reps, actual_load, completed_at, exercises(name)')
      .eq('user_id', ctx.userId);

    if (args.exercise_id) {
      query = query.eq('exercise_id', args.exercise_id);
    }

    const { data: sets, error } = await query;

    if (error) return toolError(`Failed to fetch completed sets: ${error.message}`);
    if (!sets || sets.length === 0) {
      return toolSuccess({ message: 'No completed sets found', prs: [] });
    }

    // Group by exercise and find best estimated 1RM via Epley formula
    const exerciseBest = new Map<
      string,
      { exercise_id: string; exercise_name: string | null; e1rm: number; reps: number; load: number; date: string }
    >();

    for (const set of sets) {
      const reps = set.actual_reps;
      const load = set.actual_load;

      if (load <= 0 || reps <= 0) continue;

      // Epley formula: e1RM = load * (1 + reps/30)
      // For 1-rep sets, e1RM = load (the formula gives load * (1 + 1/30) but conventionally 1 rep = the load itself)
      const e1rm = reps === 1 ? load : load * (1 + reps / 30);

      const existing = exerciseBest.get(set.exercise_id);
      if (!existing || e1rm > existing.e1rm) {
        exerciseBest.set(set.exercise_id, {
          exercise_id: set.exercise_id,
          exercise_name: set.exercises?.name ?? null,
          e1rm,
          reps,
          load,
          date: set.completed_at,
        });
      }
    }

    // Build PR results with 1RM-10RM table for each exercise
    const prs = Array.from(exerciseBest.values()).map((best) => {
      // Derive rep max table: for N reps, weight = e1RM / (1 + N/30)
      const rmTable: Record<string, number> = {};
      for (let n = 1; n <= 10; n++) {
        const weight = n === 1 ? best.e1rm : best.e1rm / (1 + n / 30);
        rmTable[`${n}RM`] = Math.round(weight * 10) / 10;
      }

      return {
        exercise_id: best.exercise_id,
        exercise_name: best.exercise_name,
        estimated_1rm: Math.round(best.e1rm * 10) / 10,
        best_set: {
          reps: best.reps,
          load: best.load,
          date: best.date,
        },
        rm_table: rmTable,
      };
    });

    // Sort by exercise name for consistent ordering
    prs.sort((a, b) => (a.exercise_name ?? '').localeCompare(b.exercise_name ?? ''));

    return toolSuccess({ prs });
  },
};
