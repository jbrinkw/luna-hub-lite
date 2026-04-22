// Estimate 1-rep-max from completed sets via the Epley formula and resolve
// percentage-based loads into absolute lbs. Mirrors the SQL logic in
// `private.ensure_daily_plan` so percentages applied at update_plan time
// produce the same numbers as percentages materialized from the split.

export function epley1RM(load: number, reps: number): number {
  if (load <= 0 || reps <= 0) return 0;
  // ensure_daily_plan uses load * (1 + reps/30) for ALL rep counts (including 1).
  return load * (1 + reps / 30);
}

// Round to nearest 5 lbs to match ensure_daily_plan's plate-friendly resolution.
export function resolvePercentLoad(percent: number, e1rm: number): number {
  return Math.round(((percent / 100) * e1rm) / 5) * 5;
}

export async function computeEstimated1RMs(
  supabase: any,
  userId: string,
  exerciseIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = Array.from(new Set(exerciseIds.filter(Boolean)));
  if (ids.length === 0) return out;

  const { data, error } = await supabase
    .schema('coachbyte')
    .from('completed_sets')
    .select('exercise_id, actual_reps, actual_load')
    .eq('user_id', userId)
    .in('exercise_id', ids)
    .gt('actual_reps', 0);

  if (error) throw new Error(`epley: completed_sets fetch failed: ${error.message}`);

  for (const r of (data as any[]) ?? []) {
    const reps = Number(r.actual_reps);
    const load = Number(r.actual_load);
    const e = epley1RM(load, reps);
    if (e <= 0) continue;
    const cur = out.get(r.exercise_id) ?? 0;
    if (e > cur) out.set(r.exercise_id, e);
  }
  return out;
}
