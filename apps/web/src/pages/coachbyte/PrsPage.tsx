import { useEffect, useState, useCallback } from 'react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase, coachbyte } from '@/shared/supabase';
import { WEIGHT_UNIT } from '@/shared/constants';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

interface ExercisePR {
  exercise_id: string;
  exercise_name: string;
  e1rm: number;
  rep_records: { reps: number; load: number }[];
}

/** Epley 1RM formula: load x (1 + reps/30) */
export function epley1RM(load: number, reps: number): number {
  if (reps <= 0 || load <= 0) return 0;
  if (reps === 1) return load;
  return Math.round(load * (1 + reps / 30));
}

export function PrsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prs, setPrs] = useState<ExercisePR[]>([]);
  const [trackedExercises, setTrackedExercises] = useState<{ exercise_id: string; name: string }[]>([]);
  const [allExercises, setAllExercises] = useState<{ exercise_id: string; name: string }[]>([]);
  const [searchText, setSearchText] = useState('');
  const [dateRange, setDateRange] = useState<number>(90);

  const computePRs = useCallback(async () => {
    if (!user) return;
    setLoadError(null);

    let query = supabase
      .schema('coachbyte')
      .from('completed_sets')
      .select('exercise_id, actual_reps, actual_load, exercises(name)')
      .eq('user_id', user.id)
      .order('completed_at', { ascending: false });

    if (dateRange < 9999) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - dateRange);
      query = query.gte('completed_at', cutoffDate.toISOString());
    }

    const { data: completedSets, error: setsErr } = await query;

    if (setsErr) {
      setLoadError(setsErr.message);
      setLoading(false);
      return;
    }

    if (!completedSets || completedSets.length === 0) {
      setPrs([]);
      setLoading(false);
      return;
    }

    // Group by exercise, find best load at each rep count
    const exerciseMap = new Map<string, { name: string; repBests: Map<number, number> }>();

    for (const cs of completedSets as any[]) {
      const id = cs.exercise_id;
      const name = cs.exercises?.name ?? 'Unknown';
      const reps = cs.actual_reps;
      const load = Number(cs.actual_load);

      if (!exerciseMap.has(id)) {
        exerciseMap.set(id, { name, repBests: new Map() });
      }
      const entry = exerciseMap.get(id)!;
      const current = entry.repBests.get(reps) ?? 0;
      if (load > current) {
        entry.repBests.set(reps, load);
      }
    }

    const result: ExercisePR[] = [];
    for (const [exerciseId, data] of exerciseMap) {
      const repRecords = Array.from(data.repBests.entries())
        .map(([reps, load]) => ({ reps, load }))
        .sort((a, b) => a.reps - b.reps);

      // e1RM = max Epley across all rep records
      let maxE1RM = 0;
      for (const r of repRecords) {
        const e = epley1RM(r.load, r.reps);
        if (e > maxE1RM) maxE1RM = e;
      }

      result.push({
        exercise_id: exerciseId,
        exercise_name: data.name,
        e1rm: maxE1RM,
        rep_records: repRecords,
      });
    }

    result.sort((a, b) => a.exercise_name.localeCompare(b.exercise_name));
    setPrs(result);
    setLoading(false);
  }, [user, dateRange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    computePRs();
  }, [computePRs]);

  useEffect(() => {
    if (!user) return;

    const loadExercisesAndSettings = async () => {
      const [exercisesRes, settingsRes] = await Promise.all([
        supabase
          .schema('coachbyte')
          .from('exercises')
          .select('exercise_id, name')
          .or(`user_id.is.null,user_id.eq.${user.id}`)
          .order('name'),
        coachbyte().from('user_settings').select('pr_tracked_exercise_ids').eq('user_id', user.id).maybeSingle(),
      ]);

      const exercises = (exercisesRes.data ?? []) as { exercise_id: string; name: string }[];
      setAllExercises(exercises);

      const savedIds: string[] | null = settingsRes.data?.pr_tracked_exercise_ids ?? null;
      if (savedIds && Array.isArray(savedIds)) {
        const savedSet = new Set(savedIds);
        setTrackedExercises(exercises.filter((e) => savedSet.has(e.exercise_id)));
      } else {
        setTrackedExercises(exercises);
      }
    };

    loadExercisesAndSettings();
  }, [user]);

  const saveTrackedExercises = useCallback(
    async (ids: string[]) => {
      if (!user) return;
      await coachbyte().from('user_settings').update({ pr_tracked_exercise_ids: ids }).eq('user_id', user.id);
    },
    [user],
  );

  const addTrackedExercise = (exerciseId: string) => {
    const ex = allExercises.find((e) => e.exercise_id === exerciseId);
    if (ex && !trackedExercises.find((t) => t.exercise_id === exerciseId)) {
      const updated = [...trackedExercises, ex];
      setTrackedExercises(updated);
      void saveTrackedExercises(updated.map((e) => e.exercise_id));
    }
    setSearchText('');
  };

  const removeTrackedExercise = (exerciseId: string) => {
    const updated = trackedExercises.filter((e) => e.exercise_id !== exerciseId);
    setTrackedExercises(updated);
    void saveTrackedExercises(updated.map((e) => e.exercise_id));
  };

  const trackedIds = new Set(trackedExercises.map((e) => e.exercise_id));
  const filteredPRs = prs.filter((pr) => trackedIds.has(pr.exercise_id));

  const searchResults =
    searchText.length > 0
      ? allExercises.filter(
          (e) => e.name.toLowerCase().includes(searchText.toLowerCase()) && !trackedIds.has(e.exercise_id),
        )
      : [];

  if (loading) {
    return (
      <CoachLayout title="PRs">
        <p className="text-slate-500 text-sm" data-testid="prs-loading">
          Loading your PRs...
        </p>
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="PRs">
      <div className="flex justify-between items-center border-b-2 border-slate-200 pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-slate-900 m-0">PR Tracker</h2>
      </div>

      {loadError && (
        <Card className="border-red-300 mb-5" data-testid="load-error">
          <CardContent>
            <p className="text-red-600 text-sm mb-2">Failed to load data: {loadError}</p>
            <Button variant="primary" size="sm" onClick={computePRs}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {filteredPRs.length === 0 ? (
        <div
          className="text-center py-10 border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 text-slate-500"
          data-testid="no-prs"
        >
          <h3 className="text-lg font-semibold mb-1">No PRs recorded yet</h3>
          <p className="text-sm">Complete sets to start tracking PRs.</p>
        </div>
      ) : (
        filteredPRs.map((pr) => (
          <Card className="mb-5 p-5" key={pr.exercise_id} data-testid={`pr-card-${pr.exercise_id}`}>
            <div className="flex justify-between items-center mb-4">
              <span className="text-xl font-bold text-slate-900 capitalize" data-testid={`pr-name-${pr.exercise_id}`}>
                {pr.exercise_name}
              </span>
              <span className="text-base font-bold text-violet-600" data-testid={`pr-e1rm-${pr.exercise_id}`}>
                e1RM: {pr.e1rm} {WEIGHT_UNIT}
              </span>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {pr.rep_records.map((r) => (
                <Badge
                  key={r.reps}
                  variant="default"
                  className="px-3 py-2 text-sm font-bold"
                  data-testid={`pr-${pr.exercise_id}-${r.reps}rep`}
                >
                  {r.reps} rep{r.reps !== 1 ? 's' : ''}: {r.load} {WEIGHT_UNIT}
                </Badge>
              ))}
            </div>
          </Card>
        ))
      )}

      <div className="flex items-center justify-between my-2">
        <p data-testid="date-range-info" className="text-slate-500 text-sm m-0">
          {dateRange < 9999 ? `Showing PRs from last ${dateRange} days` : 'Showing PRs from all history'}
        </p>
        {dateRange < 9999 && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="load-all-history-btn"
            onClick={() => {
              setLoading(true);
              setDateRange(9999);
            }}
          >
            Load All History
          </Button>
        )}
      </div>

      <div className="bg-slate-50 p-5 rounded-xl border border-slate-200 mt-5" data-testid="tracked-exercises-card">
        <h3 className="text-lg font-semibold text-slate-900 mb-2 mt-0">Tracked Exercises</h3>
        <p className="text-slate-500 text-xs mb-4">
          Add exercises to track all rep ranges for those exercises automatically.
        </p>

        <div className="flex gap-2 mb-4 items-center">
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Enter exercise name..."
            aria-label="Search exercises to track"
            data-testid="pr-search-input"
            className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
          />
        </div>

        {searchResults.length > 0 && (
          <div data-testid="pr-search-results" className="flex flex-wrap gap-2 mb-4">
            {searchResults.slice(0, 5).map((ex) => (
              <Button
                key={ex.exercise_id}
                variant="secondary"
                size="sm"
                onClick={() => addTrackedExercise(ex.exercise_id)}
                data-testid={`add-exercise-${ex.exercise_id}`}
              >
                {ex.name}
              </Button>
            ))}
          </div>
        )}

        {trackedExercises.length === 0 ? (
          <p className="text-slate-500 italic text-sm">No exercises being tracked</p>
        ) : (
          <>
            <div className="text-sm font-bold text-slate-700 mb-2.5">
              Currently Tracking ({trackedExercises.length} exercises)
            </div>
            <div className="flex flex-wrap gap-2" data-testid="tracked-chips">
              {trackedExercises.map((ex) => (
                <div
                  className="flex items-center gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm cursor-pointer hover:border-slate-300 transition-colors"
                  key={ex.exercise_id}
                  data-testid={`tracked-${ex.exercise_id}`}
                  onClick={() => removeTrackedExercise(ex.exercise_id)}
                >
                  <span>{ex.name}</span>
                  <Button variant="danger" size="sm" className="!px-1.5 !py-0.5 !text-[11px]">
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </CoachLayout>
  );
}
