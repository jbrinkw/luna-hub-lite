// Resolve exercise references coming in from MCP tool calls. Callers pass
// either a UUID or a case-insensitive exercise name; we look up names against
// the user's custom library plus the global seed list. When a name matches
// both a user-owned row and a global, the user-owned row wins.
//
// Handlers that accept a single ref use `resolveExerciseRef`; handlers that
// take a list (update_split, update_plan) use `resolveExerciseRefs` to avoid
// N round-trips.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResolveResult = {
  // Parallel to the input array. Null = unresolved name. UUIDs pass through.
  ids: (string | null)[];
  // Original names that didn't match anything.
  unresolved: string[];
};

export async function resolveExerciseRefs(supabase: any, userId: string, refs: string[]): Promise<ResolveResult> {
  const neededLower = new Set<string>();
  for (const r of refs) {
    if (r && !UUID_RE.test(r)) neededLower.add(r.toLowerCase());
  }

  const byLowerName = new Map<string, { exercise_id: string; user_id: string | null }>();
  if (neededLower.size > 0) {
    const { data } = await supabase
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name, user_id')
      .or(`user_id.is.null,user_id.eq.${userId}`);

    for (const row of (data as any[]) ?? []) {
      const key = row.name.toLowerCase();
      if (!neededLower.has(key)) continue;
      const existing = byLowerName.get(key);
      // Keep the user-owned row over a global when both match the same name.
      if (!existing || (row.user_id === userId && existing.user_id === null)) {
        byLowerName.set(key, { exercise_id: row.exercise_id, user_id: row.user_id });
      }
    }
  }

  const ids: (string | null)[] = [];
  const unresolved: string[] = [];
  for (const r of refs) {
    if (!r) {
      ids.push(null);
      continue;
    }
    if (UUID_RE.test(r)) {
      ids.push(r);
      continue;
    }
    const hit = byLowerName.get(r.toLowerCase());
    if (hit) {
      ids.push(hit.exercise_id);
    } else {
      ids.push(null);
      unresolved.push(r);
    }
  }
  return { ids, unresolved };
}

export async function resolveExerciseRef(
  supabase: any,
  userId: string,
  ref: string,
): Promise<{ id: string | null; unresolved: string[] }> {
  const { ids, unresolved } = await resolveExerciseRefs(supabase, userId, [ref]);
  return { id: ids[0], unresolved };
}

export const EXERCISE_REF_DESCRIPTION =
  'Exercise reference: either a UUID or a case-insensitive exercise name (matches seeded globals or your custom exercises). When a name collides between a user-owned exercise and a global, the user-owned row wins.';
