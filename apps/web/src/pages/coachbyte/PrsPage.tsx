import { useEffect, useState, useCallback } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonChip,
  IonButton,
  IonInput,
} from '@ionic/react';
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
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    computePRs();
  }, [computePRs]);

  useEffect(() => {
    if (!user) return;

    const loadExercisesAndSettings = async () => {
      // Fetch all exercises and saved PR tracking preference in parallel
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

      // If user has saved tracked exercise IDs, filter to those; otherwise default to all
      const savedIds: string[] | null = settingsRes.data?.pr_tracked_exercise_ids ?? null;
      if (savedIds && Array.isArray(savedIds)) {
        const savedSet = new Set(savedIds);
        setTrackedExercises(exercises.filter((e) => savedSet.has(e.exercise_id)));
      } else {
        setTrackedExercises(exercises);
      }
    };

    // Async data fetching with setState is the standard pattern for this use case

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
      // Fire-and-forget persist to DB
      void saveTrackedExercises(updated.map((e) => e.exercise_id));
    }
    setSearchText('');
  };

  const removeTrackedExercise = (exerciseId: string) => {
    const updated = trackedExercises.filter((e) => e.exercise_id !== exerciseId);
    setTrackedExercises(updated);
    // Fire-and-forget persist to DB
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
        <IonSpinner data-testid="prs-loading" />
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="PRs">
      <h2>PR TRACKER</h2>

      {loadError && (
        <IonCard color="danger" data-testid="load-error">
          <IonCardContent>
            <p>Failed to load data: {loadError}</p>
            <IonButton onClick={computePRs}>Retry</IonButton>
          </IonCardContent>
        </IonCard>
      )}

      {filteredPRs.length === 0 ? (
        <p data-testid="no-prs">No PRs recorded yet. Complete some sets to see your records.</p>
      ) : (
        filteredPRs.map((pr) => (
          <IonCard key={pr.exercise_id} data-testid={`pr-card-${pr.exercise_id}`}>
            <IonCardHeader>
              <IonCardTitle style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span data-testid={`pr-name-${pr.exercise_id}`}>{pr.exercise_name.toUpperCase()}</span>
                <span data-testid={`pr-e1rm-${pr.exercise_id}`}>e1RM: {pr.e1rm}</span>
              </IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {pr.rep_records.map((r) => (
                  <IonChip key={r.reps} data-testid={`pr-${pr.exercise_id}-${r.reps}rep`}>
                    {r.reps} rep: {r.load} {WEIGHT_UNIT}
                  </IonChip>
                ))}
              </div>
            </IonCardContent>
          </IonCard>
        ))
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' }}>
        <p data-testid="date-range-info" style={{ margin: 0, fontSize: '0.9em', color: 'var(--ion-color-medium)' }}>
          {dateRange < 9999 ? `Showing PRs from last ${dateRange} days` : 'Showing PRs from all history'}
        </p>
        {dateRange < 9999 && (
          <IonButton
            size="small"
            fill="outline"
            data-testid="load-all-history-btn"
            onClick={() => {
              setLoading(true);
              setDateRange(9999);
            }}
          >
            Load All History
          </IonButton>
        )}
      </div>

      <IonCard data-testid="tracked-exercises-card">
        <IonCardHeader>
          <IonCardTitle>Tracked Exercises</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <IonInput
              value={searchText}
              onIonInput={(e) => setSearchText(e.detail.value ?? '')}
              placeholder="Enter exercise name..."
              data-testid="pr-search-input"
            />
            {searchResults.length > 0 && (
              <div data-testid="pr-search-results">
                {searchResults.slice(0, 5).map((ex) => (
                  <IonButton
                    key={ex.exercise_id}
                    size="small"
                    fill="outline"
                    onClick={() => addTrackedExercise(ex.exercise_id)}
                    data-testid={`add-exercise-${ex.exercise_id}`}
                  >
                    {ex.name}
                  </IonButton>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }} data-testid="tracked-chips">
            {trackedExercises.map((ex) => (
              <IonChip
                key={ex.exercise_id}
                onClick={() => removeTrackedExercise(ex.exercise_id)}
                data-testid={`tracked-${ex.exercise_id}`}
              >
                {ex.name} ✕
              </IonChip>
            ))}
          </div>
        </IonCardContent>
      </IonCard>
    </CoachLayout>
  );
}
