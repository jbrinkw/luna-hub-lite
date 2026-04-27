// Load-spec translation between the MCP tool surface and the DB schema.
//
// Tool surface uses `{ load, relative }` — one value plus a flag:
//   relative=false → `load` is absolute lbs
//   relative=true  → `load` is a percentage of the user's estimated 1RM
//
// DB schema splits it into two columns (planned_sets / splits.template_sets):
//   target_load              NUMERIC  absolute lbs (or resolved value after
//                                     ensure_daily_plan materializes a %)
//   target_load_percentage   NUMERIC  percent of 1RM, 0-100ish
//
// When a relative set has been materialized by ensure_daily_plan, BOTH columns
// are populated: target_load_percentage carries the intent, target_load the
// resolved absolute. In that case we surface `resolved_load` on the output.

export type LoadSpecInput = {
  load: number;
  relative?: boolean;
};

export type LoadSpecOutput = {
  load: number | null;
  relative: boolean;
  resolved_load?: number | null;
};

export function loadSpecToDb(spec: LoadSpecInput): {
  target_load: number | null;
  target_load_percentage: number | null;
} {
  if (spec.relative) {
    return { target_load: null, target_load_percentage: spec.load };
  }
  return { target_load: spec.load, target_load_percentage: null };
}

export function loadSpecFromDb(row: {
  target_load: number | string | null;
  target_load_percentage: number | string | null;
}): LoadSpecOutput {
  const absolute = row.target_load == null ? null : Number(row.target_load);
  const percent = row.target_load_percentage == null ? null : Number(row.target_load_percentage);

  if (percent !== null) {
    return { load: percent, relative: true, resolved_load: absolute };
  }
  return { load: absolute, relative: false };
}

// Shared JSON Schema fragment for a load-bearing input. Callers merge this
// into their item.properties and add exercise_id / target_reps / rest_seconds
// / (optional) order as siblings.
export const loadSpecInputSchema = {
  load: {
    type: 'number',
    minimum: 0,
    description:
      "If relative=false (default), absolute load in lbs. If relative=true, percentage of the user's estimated 1RM (0 for no load).",
  },
  relative: {
    type: 'boolean',
    description:
      "When true, `load` is a percentage of the user's estimated 1RM for that exercise. Defaults to false. Percentages are resolved to absolute lbs when the daily plan is materialized.",
  },
} as const;
