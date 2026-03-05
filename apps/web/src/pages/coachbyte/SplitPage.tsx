import { useEffect, useState, useCallback } from 'react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface TemplateSet {
  exercise_id: string;
  exercise_name: string;
  target_reps: number | null;
  target_load: number | null;
  target_load_percentage: number | null;
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
  const [savingDay, setSavingDay] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    setSavingDay(day.weekday);
    setSaveError(null);

    if (day.split_id) {
      const { error: err } = await supabase
        .schema('coachbyte')
        .from('splits')
        .update({ template_sets: day.template_sets as any, split_notes: day.split_notes })
        .eq('split_id', day.split_id)
        .eq('user_id', user.id);
      if (err) {
        setSaveError(err.message);
        setSavingDay(null);
        return;
      }
    } else if (day.template_sets.length > 0 || day.split_notes) {
      const { data, error: err } = await supabase
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

      if (err) {
        setSaveError(err.message);
        setSavingDay(null);
        return;
      }
      if (data) {
        setSplits((prev) => prev.map((s) => (s.weekday === day.weekday ? { ...s, split_id: data.split_id } : s)));
      }
    }

    setSavingDay(null);
  };

  const updateSet = (weekday: number, setIndex: number, field: string, value: any) => {
    setSplits((prev) =>
      prev.map((s) => {
        if (s.weekday !== weekday) return s;
        const sets = [...s.template_sets];
        sets[setIndex] = { ...sets[setIndex], [field]: value };
        return { ...s, template_sets: sets };
      }),
    );
  };

  const addSet = (weekday: number) => {
    setSplits((prev) =>
      prev.map((s) => {
        if (s.weekday !== weekday) return s;
        const newSet: TemplateSet = {
          exercise_id: exercises[0]?.exercise_id ?? '',
          exercise_name: exercises[0]?.name ?? '',
          target_reps: 5,
          target_load: null,
          target_load_percentage: null,
          rest_seconds: 90,
          order: s.template_sets.length + 1,
        };
        return { ...s, template_sets: [...s.template_sets, newSet] };
      }),
    );
  };

  const removeSet = (weekday: number, setIndex: number) => {
    setSplits((prev) =>
      prev.map((s) => {
        if (s.weekday !== weekday) return s;
        const sets = s.template_sets.filter((_, i) => i !== setIndex).map((set, i) => ({ ...set, order: i + 1 }));
        return { ...s, template_sets: sets };
      }),
    );
  };

  const updateNotes = (weekday: number, notes: string) => {
    setSplits((prev) => prev.map((s) => (s.weekday === weekday ? { ...s, split_notes: notes } : s)));
  };

  if (loading) {
    return (
      <CoachLayout title="Split">
        <p className="muted-text" data-testid="split-loading">
          Loading split...
        </p>
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Split">
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
        <h2 style={{ margin: 0 }}>Weekly Split Planner</h2>
      </div>

      {saveError && <p className="error-text">{saveError}</p>}

      {splits.map((day) => (
        <div className="split-day" key={day.weekday} data-testid={`day-${day.weekday}`}>
          <h3>{WEEKDAYS[day.weekday]}</h3>

          {day.template_sets.length === 0 ? (
            <p className="muted-text" style={{ fontStyle: 'italic' }} data-testid={`day-${day.weekday}-empty`}>
              Rest day (no exercises)
            </p>
          ) : (
            <table data-testid={`day-${day.weekday}-table`}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Exercise</th>
                  <th>Reps</th>
                  <th>Load</th>
                  <th>Rel%</th>
                  <th>Rest</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {day.template_sets.map((set, i) => (
                  <tr key={i} data-testid={`day-${day.weekday}-set-${i}`}>
                    <td data-testid={`day-${day.weekday}-set-${i}-order`}>{set.order}</td>
                    <td>
                      <select
                        value={set.exercise_id}
                        aria-label="Exercise"
                        onChange={(e) => {
                          const ex = exercises.find((ex) => ex.exercise_id === e.target.value);
                          updateSet(day.weekday, i, 'exercise_id', e.target.value);
                          if (ex) updateSet(day.weekday, i, 'exercise_name', ex.name);
                        }}
                        data-testid={`day-${day.weekday}-set-${i}-exercise`}
                      >
                        {exercises.map((ex) => (
                          <option key={ex.exercise_id} value={ex.exercise_id}>
                            {ex.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        className="input-narrow"
                        min="0"
                        aria-label="Target reps"
                        value={set.target_reps ?? ''}
                        onChange={(e) =>
                          updateSet(day.weekday, i, 'target_reps', e.target.value ? Number(e.target.value) : null)
                        }
                        data-testid={`day-${day.weekday}-set-${i}-reps`}
                      />
                    </td>
                    <td>
                      {set.target_load_percentage ? (
                        <input
                          type="number"
                          className="input-load"
                          min="0"
                          aria-label="Load percentage"
                          value={set.target_load_percentage}
                          onChange={(e) =>
                            updateSet(
                              day.weekday,
                              i,
                              'target_load_percentage',
                              e.target.value ? Number(e.target.value) : null,
                            )
                          }
                          data-testid={`day-${day.weekday}-set-${i}-load-pct`}
                        />
                      ) : (
                        <input
                          type="number"
                          className="input-load"
                          min="0"
                          aria-label="Target load"
                          value={set.target_load ?? ''}
                          onChange={(e) =>
                            updateSet(day.weekday, i, 'target_load', e.target.value ? Number(e.target.value) : null)
                          }
                          data-testid={`day-${day.weekday}-set-${i}-load`}
                        />
                      )}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={set.target_load_percentage !== null}
                        aria-label="Use relative load percentage"
                        onChange={(e) => {
                          if (e.target.checked) {
                            updateSet(day.weekday, i, 'target_load_percentage', set.target_load_percentage ?? 80);
                            updateSet(day.weekday, i, 'target_load', null);
                          } else {
                            updateSet(day.weekday, i, 'target_load_percentage', null);
                          }
                        }}
                        data-testid={`day-${day.weekday}-set-${i}-rel`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="input-rest"
                        min="0"
                        aria-label="Rest seconds"
                        value={set.rest_seconds}
                        onChange={(e) =>
                          updateSet(day.weekday, i, 'rest_seconds', e.target.value ? Number(e.target.value) : 90)
                        }
                        data-testid={`day-${day.weekday}-set-${i}-rest`}
                      />
                    </td>
                    <td>
                      <button
                        className="btn btn-red btn-sm"
                        onClick={() => removeSet(day.weekday, i)}
                        data-testid={`day-${day.weekday}-set-${i}-delete`}
                        aria-label={`Remove set ${i + 1} from ${WEEKDAYS[day.weekday]}`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button
              className="btn btn-green btn-sm"
              onClick={() => addSet(day.weekday)}
              disabled={exercises.length === 0}
              data-testid={`day-${day.weekday}-add`}
            >
              + Add Exercise
            </button>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => saveSplit(day)}
              disabled={savingDay === day.weekday}
              data-testid={`day-${day.weekday}-save`}
            >
              {savingDay === day.weekday ? 'Saving...' : 'Save'}
            </button>
          </div>

          <div className="split-notes" style={{ marginTop: 8 }}>
            <label style={{ fontSize: 14, fontWeight: 'bold', display: 'block', marginBottom: 4 }}>Notes</label>
            <textarea
              value={day.split_notes}
              onChange={(e) => updateNotes(day.weekday, e.target.value)}
              data-testid={`day-${day.weekday}-notes`}
              rows={2}
            />
          </div>
        </div>
      ))}
    </CoachLayout>
  );
}
