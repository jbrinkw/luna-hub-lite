import { useEffect, useState, useCallback } from 'react';
import { IonSpinner, IonCard, IonCardContent, IonCardHeader, IonCardTitle, IonButton, IonInput, IonCheckbox, IonSelect, IonSelectOption, IonTextarea } from '@ionic/react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface TemplateSet {
  exercise_id: string;
  exercise_name: string;
  reps: number | null;
  load: number | null;
  load_percentage: number | null;
  rest_seconds: number;
  order: number;
}

interface DaySplit {
  split_id: string | null;
  weekday: number;
  template_sets: TemplateSet[];
  split_notes: string;
}

interface Exercise {
  exercise_id: string;
  name: string;
}

export function SplitPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [splits, setSplits] = useState<DaySplit[]>([]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [saving, setSaving] = useState(false);

  const loadSplits = useCallback(async () => {
    if (!user) return;

    const { data } = await supabase
      .schema('coachbyte')
      .from('splits')
      .select('split_id, weekday, template_sets, split_notes')
      .eq('user_id', user.id)
      .order('weekday');

    const splitMap = new Map<number, any>();
    (data ?? []).forEach((s: any) => splitMap.set(s.weekday, s));

    const all: DaySplit[] = Array.from({ length: 7 }, (_, i) => {
      const s = splitMap.get(i);
      return {
        split_id: s?.split_id ?? null,
        weekday: i,
        template_sets: (s?.template_sets ?? []) as TemplateSet[],
        split_notes: s?.split_notes ?? '',
      };
    });

    setSplits(all);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    loadSplits();
  }, [loadSplits]);

  useEffect(() => {
    if (!user) return;
    supabase
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order('name')
      .then(({ data }) => setExercises((data ?? []) as Exercise[]));
  }, [user]);

  const saveSplit = async (day: DaySplit) => {
    if (!user) return;
    setSaving(true);

    if (day.split_id) {
      await supabase
        .schema('coachbyte')
        .from('splits')
        .update({ template_sets: day.template_sets as any, split_notes: day.split_notes })
        .eq('split_id', day.split_id);
    } else if (day.template_sets.length > 0 || day.split_notes) {
      const { data } = await supabase
        .schema('coachbyte')
        .from('splits')
        .insert({
          user_id: user.id,
          weekday: day.weekday,
          template_sets: day.template_sets as any,
          split_notes: day.split_notes,
        })
        .select('split_id')
        .single();

      if (data) {
        setSplits(prev => prev.map(s => s.weekday === day.weekday ? { ...s, split_id: data.split_id } : s));
      }
    }

    setSaving(false);
  };

  const updateSet = (weekday: number, setIndex: number, field: string, value: any) => {
    setSplits(prev => prev.map(s => {
      if (s.weekday !== weekday) return s;
      const sets = [...s.template_sets];
      sets[setIndex] = { ...sets[setIndex], [field]: value };
      return { ...s, template_sets: sets };
    }));
  };

  const addSet = (weekday: number) => {
    setSplits(prev => prev.map(s => {
      if (s.weekday !== weekday) return s;
      const newSet: TemplateSet = {
        exercise_id: exercises[0]?.exercise_id ?? '',
        exercise_name: exercises[0]?.name ?? '',
        reps: 5,
        load: null,
        load_percentage: null,
        rest_seconds: 90,
        order: s.template_sets.length + 1,
      };
      return { ...s, template_sets: [...s.template_sets, newSet] };
    }));
  };

  const removeSet = (weekday: number, setIndex: number) => {
    setSplits(prev => prev.map(s => {
      if (s.weekday !== weekday) return s;
      const sets = s.template_sets.filter((_, i) => i !== setIndex)
        .map((set, i) => ({ ...set, order: i + 1 }));
      return { ...s, template_sets: sets };
    }));
  };

  const updateNotes = (weekday: number, notes: string) => {
    setSplits(prev => prev.map(s => s.weekday === weekday ? { ...s, split_notes: notes } : s));
  };

  if (loading) {
    return (
      <CoachLayout title="Split">
        <IonSpinner data-testid="split-loading" />
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Split">
      <h2>WEEKLY SPLIT PLANNER</h2>

      {splits.map(day => (
        <IonCard key={day.weekday} data-testid={`day-${day.weekday}`}>
          <IonCardHeader>
            <IonCardTitle>{WEEKDAYS[day.weekday]}</IonCardTitle>
          </IonCardHeader>
          <IonCardContent>
            {day.template_sets.length === 0 ? (
              <p data-testid={`day-${day.weekday}-empty`}>Rest day (no exercises)</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid={`day-${day.weekday}-table`}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Exercise</th>
                    <th style={{ textAlign: 'left' }}>Reps</th>
                    <th style={{ textAlign: 'left' }}>Load</th>
                    <th style={{ textAlign: 'left' }}>Rel%</th>
                    <th style={{ textAlign: 'left' }}>Rest</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {day.template_sets.map((set, i) => (
                    <tr key={i} data-testid={`day-${day.weekday}-set-${i}`}>
                      <td>
                        <IonSelect
                          value={set.exercise_id}
                          onIonChange={e => {
                            const ex = exercises.find(ex => ex.exercise_id === e.detail.value);
                            updateSet(day.weekday, i, 'exercise_id', e.detail.value);
                            if (ex) updateSet(day.weekday, i, 'exercise_name', ex.name);
                          }}
                          interface="popover"
                          data-testid={`day-${day.weekday}-set-${i}-exercise`}
                        >
                          {exercises.map(ex => (
                            <IonSelectOption key={ex.exercise_id} value={ex.exercise_id}>{ex.name}</IonSelectOption>
                          ))}
                        </IonSelect>
                      </td>
                      <td>
                        <IonInput
                          type="number"
                          value={set.reps}
                          onIonInput={e => updateSet(day.weekday, i, 'reps', e.detail.value ? Number(e.detail.value) : null)}
                          data-testid={`day-${day.weekday}-set-${i}-reps`}
                          style={{ width: '60px' }}
                        />
                      </td>
                      <td>
                        {set.load_percentage ? (
                          <span>{set.load_percentage}%</span>
                        ) : (
                          <IonInput
                            type="number"
                            value={set.load}
                            onIonInput={e => updateSet(day.weekday, i, 'load', e.detail.value ? Number(e.detail.value) : null)}
                            data-testid={`day-${day.weekday}-set-${i}-load`}
                            style={{ width: '80px' }}
                          />
                        )}
                      </td>
                      <td>
                        <IonCheckbox
                          checked={set.load_percentage !== null}
                          onIonChange={e => {
                            if (e.detail.checked) {
                              updateSet(day.weekday, i, 'load_percentage', 80);
                              updateSet(day.weekday, i, 'load', null);
                            } else {
                              updateSet(day.weekday, i, 'load_percentage', null);
                            }
                          }}
                          data-testid={`day-${day.weekday}-set-${i}-rel`}
                        />
                      </td>
                      <td>
                        <IonInput
                          type="number"
                          value={set.rest_seconds}
                          onIonInput={e => updateSet(day.weekday, i, 'rest_seconds', e.detail.value ? Number(e.detail.value) : 90)}
                          data-testid={`day-${day.weekday}-set-${i}-rest`}
                          style={{ width: '60px' }}
                        />
                      </td>
                      <td>
                        <IonButton size="small" fill="clear" color="danger" onClick={() => removeSet(day.weekday, i)} data-testid={`day-${day.weekday}-set-${i}-delete`}>
                          ✕
                        </IonButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
              <IonButton size="small" onClick={() => addSet(day.weekday)} data-testid={`day-${day.weekday}-add`}>
                + Add Exercise
              </IonButton>
              <IonButton size="small" fill="outline" onClick={() => saveSplit(day)} disabled={saving} data-testid={`day-${day.weekday}-save`}>
                Save
              </IonButton>
            </div>

            <IonTextarea
              label="Notes"
              value={day.split_notes}
              onIonInput={e => updateNotes(day.weekday, e.detail.value ?? '')}
              data-testid={`day-${day.weekday}-notes`}
              rows={2}
              style={{ marginTop: '8px' }}
            />
          </IonCardContent>
        </IonCard>
      ))}
    </CoachLayout>
  );
}
