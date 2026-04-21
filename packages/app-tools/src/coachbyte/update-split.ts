import type { ToolDefinition } from '../types';
import { toolSuccess, toolError } from '../shared';
import { loadSpecFromDb, loadSpecInputSchema, loadSpecToDb } from './load-spec';

export const updateSplit: ToolDefinition = {
  name: 'COACHBYTE_update_split',
  description:
    "Set the template sets for a specific weekday in the weekly split. Each set carries a `load` value plus a `relative` flag: when relative=false (default), `load` is absolute lbs; when relative=true, `load` is a percentage of the user's estimated 1RM for that exercise. Percentages are resolved to absolute loads when the daily plan is materialized.",
  inputSchema: {
    type: 'object',
    properties: {
      weekday: {
        type: 'integer',
        description: 'Weekday number 0-6 (Sunday-Saturday)',
      },
      template_sets: {
        type: 'array',
        description: 'Template sets for this day. Array order determines set order.',
        items: {
          type: 'object',
          properties: {
            exercise_id: { type: 'string' },
            target_reps: { type: 'integer' },
            load: loadSpecInputSchema.load,
            relative: loadSpecInputSchema.relative,
            rest_seconds: { type: 'integer' },
          },
          required: ['exercise_id', 'target_reps', 'load', 'rest_seconds'],
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

    // Translate {load, relative} → DB JSONB shape
    // (ensure_daily_plan reads target_load / target_load_percentage keys)
    const jsonbTemplateSets = (template_sets as any[]).map((ts) => {
      const { target_load, target_load_percentage } = loadSpecToDb({
        load: ts.load,
        relative: ts.relative,
      });
      return {
        exercise_id: ts.exercise_id,
        target_reps: ts.target_reps,
        target_load,
        target_load_percentage,
        rest_seconds: ts.rest_seconds,
      };
    });

    const { data, error } = await ctx.supabase
      .schema('coachbyte')
      .from('splits')
      .upsert(
        {
          user_id: ctx.userId,
          weekday,
          template_sets: jsonbTemplateSets,
        },
        { onConflict: 'user_id,weekday' },
      )
      .select('split_id, weekday, template_sets')
      .single();

    if (error) return toolError(`Failed to update split: ${error.message}`);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const outSets = ((data.template_sets as any[]) || []).map((ts: any) => ({
      exercise_id: ts.exercise_id,
      target_reps: ts.target_reps,
      ...loadSpecFromDb({
        target_load: ts.target_load ?? null,
        target_load_percentage: ts.target_load_percentage ?? null,
      }),
      rest_seconds: ts.rest_seconds,
    }));

    return toolSuccess({
      message: `Split updated for ${dayNames[weekday]}`,
      split_id: data.split_id,
      weekday: data.weekday,
      day_name: dayNames[weekday],
      template_sets: outSets,
    });
  },
};
