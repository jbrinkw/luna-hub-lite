import { useEffect, useState, useCallback } from 'react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase, coachbyte } from '@/shared/supabase';
import { WEIGHT_UNIT } from '@/shared/constants';

interface ExercisePR {
  exercise_id: string;
  exercise_name: string;
  e1rm: number;
  rep_records: { reps: number; load: number }[];
}

/** Epley 1RM formula: load × (1 + reps/30) */
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
        <p className="muted-text" data-testid="prs-loading">
          Loading your PRs...
        </p>
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="PRs">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '2px solid #eee',
          paddingBottom: 10,
          marginBottom: 20,
        }}
      >
        <h2 style={{ margin: 0 }}>PR Tracker</h2>
      </div>

      {loadError && (
        <div className="card" style={{ borderColor: '#dc3545' }} data-testid="load-error">
          <div className="card-body">
            <p className="error-text">Failed to load data: {loadError}</p>
            <button className="btn btn-blue" onClick={computePRs}>
              Retry
            </button>
          </div>
        </div>
      )}

      {filteredPRs.length === 0 ? (
        <div className="empty-state" data-testid="no-prs">
          <h3>No PRs recorded yet</h3>
          <p>Complete some sets to see your records.</p>
        </div>
      ) : (
        filteredPRs.map((pr) => (
          <div className="pr-card" key={pr.exercise_id} data-testid={`pr-card-${pr.exercise_id}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
              <span className="pr-exercise-name" style={{ marginBottom: 0 }} data-testid={`pr-name-${pr.exercise_id}`}>
                {pr.exercise_name}
              </span>
              <span
                style={{ fontSize: 16, fontWeight: 'bold', color: '#007bff' }}
                data-testid={`pr-e1rm-${pr.exercise_id}`}
              >
                e1RM: {pr.e1rm} {WEIGHT_UNIT}
              </span>
            </div>
            <div className="pr-list">
              {pr.rep_records.map((r) => (
                <div className="pr-chip" key={r.reps} data-testid={`pr-${pr.exercise_id}-${r.reps}rep`}>
                  {r.reps} rep{r.reps !== 1 ? 's' : ''}: {r.load} {WEIGHT_UNIT}
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' }}>
        <p data-testid="date-range-info" className="muted-text" style={{ margin: 0, fontSize: '0.9em' }}>
          {dateRange < 9999 ? `Showing PRs from last ${dateRange} days` : 'Showing PRs from all history'}
        </p>
        {dateRange < 9999 && (
          <button
            className="btn btn-outline btn-sm"
            data-testid="load-all-history-btn"
            onClick={() => {
              setLoading(true);
              setDateRange(9999);
            }}
          >
            Load All History
          </button>
        )}
      </div>

      <div className="tracked-section" data-testid="tracked-exercises-card">
        <h3 style={{ marginBottom: 8, fontSize: 18, marginTop: 0 }}>Tracked Exercises</h3>
        <p className="muted-text" style={{ fontSize: 13, marginBottom: 15 }}>
          Add exercises to track all rep ranges for those exercises automatically.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 15, alignItems: 'center' }}>
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Enter exercise name..."
            aria-label="Search exercises to track"
            data-testid="pr-search-input"
            style={{ flex: 1 }}
          />
        </div>

        {searchResults.length > 0 && (
          <div data-testid="pr-search-results" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 15 }}>
            {searchResults.slice(0, 5).map((ex) => (
              <button
                key={ex.exercise_id}
                className="btn btn-outline btn-sm"
                onClick={() => addTrackedExercise(ex.exercise_id)}
                data-testid={`add-exercise-${ex.exercise_id}`}
              >
                {ex.name}
              </button>
            ))}
          </div>
        )}

        {trackedExercises.length === 0 ? (
          <p className="muted-text" style={{ fontStyle: 'italic', fontSize: 13 }}>
            No exercises being tracked
          </p>
        ) : (
          <>
            <div style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 10 }}>
              Currently Tracking ({trackedExercises.length} exercises)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} data-testid="tracked-chips">
              {trackedExercises.map((ex) => (
                <div
                  className="tracked-chip"
                  key={ex.exercise_id}
                  data-testid={`tracked-${ex.exercise_id}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => removeTrackedExercise(ex.exercise_id)}
                >
                  <span>{ex.name}</span>
                  <button className="btn btn-red btn-sm" style={{ padding: '2px 6px', fontSize: 11 }}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </CoachLayout>
  );
}
