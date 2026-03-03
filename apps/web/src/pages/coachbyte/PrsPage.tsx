import { useEffect, useState, useCallback } from 'react';
import { IonSpinner, IonCard, IonCardContent, IonCardHeader, IonCardTitle, IonChip, IonButton, IonInput } from '@ionic/react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

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
  const [prs, setPrs] = useState<ExercisePR[]>([]);
  const [trackedExercises, setTrackedExercises] = useState<{ exercise_id: string; name: string }[]>([]);
  const [allExercises, setAllExercises] = useState<{ exercise_id: string; name: string }[]>([]);
  const [searchText, setSearchText] = useState('');

  const computePRs = useCallback(async () => {
    if (!user) return;

    const { data: completedSets } = await supabase
      .schema('coachbyte')
      .from('completed_sets')
      .select('exercise_id, actual_reps, actual_load, exercises(name)')
      .eq('user_id', user.id);

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
  }, [user]);

  useEffect(() => {
    computePRs();
  }, [computePRs]);

  useEffect(() => {
    if (!user) return;
    supabase
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order('name')
      .then(({ data }) => {
        setAllExercises((data ?? []) as any);
        setTrackedExercises((data ?? []) as any);
      });
  }, [user]);

  const addTrackedExercise = (exerciseId: string) => {
    const ex = allExercises.find(e => e.exercise_id === exerciseId);
    if (ex && !trackedExercises.find(t => t.exercise_id === exerciseId)) {
      setTrackedExercises(prev => [...prev, ex]);
    }
    setSearchText('');
  };

  const removeTrackedExercise = (exerciseId: string) => {
    setTrackedExercises(prev => prev.filter(e => e.exercise_id !== exerciseId));
  };

  const trackedIds = new Set(trackedExercises.map(e => e.exercise_id));
  const filteredPRs = prs.filter(pr => trackedIds.has(pr.exercise_id));

  const searchResults = searchText.length > 0
    ? allExercises.filter(e =>
        e.name.toLowerCase().includes(searchText.toLowerCase()) &&
        !trackedIds.has(e.exercise_id)
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

      {filteredPRs.length === 0 ? (
        <p data-testid="no-prs">No PRs recorded yet. Complete some sets to see your records.</p>
      ) : (
        filteredPRs.map(pr => (
          <IonCard key={pr.exercise_id} data-testid={`pr-card-${pr.exercise_id}`}>
            <IonCardHeader>
              <IonCardTitle style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span data-testid={`pr-name-${pr.exercise_id}`}>{pr.exercise_name.toUpperCase()}</span>
                <span data-testid={`pr-e1rm-${pr.exercise_id}`}>e1RM: {pr.e1rm}</span>
              </IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {pr.rep_records.map(r => (
                  <IonChip key={r.reps} data-testid={`pr-${pr.exercise_id}-${r.reps}rep`}>
                    {r.reps} rep: {r.load} lb
                  </IonChip>
                ))}
              </div>
            </IonCardContent>
          </IonCard>
        ))
      )}

      <IonCard data-testid="tracked-exercises-card">
        <IonCardHeader>
          <IonCardTitle>Tracked Exercises</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <IonInput
              value={searchText}
              onIonInput={e => setSearchText(e.detail.value ?? '')}
              placeholder="Enter exercise name..."
              data-testid="pr-search-input"
            />
            {searchResults.length > 0 && (
              <div data-testid="pr-search-results">
                {searchResults.slice(0, 5).map(ex => (
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
            {trackedExercises.map(ex => (
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
