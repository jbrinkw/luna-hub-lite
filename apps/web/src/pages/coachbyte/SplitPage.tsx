import { useEffect, useState, useCallback } from 'react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { Button } from '@/components/ui/Button';
import { ChevronDown, ChevronRight } from 'lucide-react';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const REST_PRESETS = [30, 60, 90, 120];

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
  const [collapsedDays, setCollapsedDays] = useState<Set<number>>(new Set());

  const toggleDay = (weekday: number) => {
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(weekday)) {
        next.delete(weekday);
      } else {
        next.add(weekday);
      }
      return next;
    });
  };

  const loadSplits = useCallback(async () => {
    if (!user) return;

    const { data, error: loadErr } = await supabase
      .schema('coachbyte')
      .from('splits')
      .select('split_id, weekday, template_sets, split_notes')
      .eq('user_id', user.id)
      .order('weekday');

    if (loadErr) {
      setSaveError(loadErr.message);
      setLoading(false);
      return;
    }

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

    // Default collapse rest days (days with no exercises)
    const restDays = new Set<number>();
    for (const day of all) {
      if (day.template_sets.length === 0) {
        restDays.add(day.weekday);
      }
    }
    setCollapsedDays(restDays);

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
      .then(({ data, error: err }) => {
        if (err) console.error('Failed to load exercises:', err.message);
        setExercises((data ?? []) as Exercise[]);
      });
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
    // Expand the day when adding a set
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      next.delete(weekday);
      return next;
    });
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
        <p className="text-slate-500 text-sm" data-testid="split-loading">
          Loading split...
        </p>
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Split">
      <div className="flex justify-between items-center border-b-2 border-slate-200 pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-slate-900 m-0">Weekly Split Planner</h2>
      </div>

      {saveError && <p className="text-red-600 text-sm mb-3">{saveError}</p>}

      {splits.map((day) => {
        const isCollapsed = collapsedDays.has(day.weekday);
        const isRestDay = day.template_sets.length === 0;

        return (
          <div className="mb-6" key={day.weekday} data-testid={`day-${day.weekday}`}>
            <button
              type="button"
              onClick={() => toggleDay(day.weekday)}
              className="flex items-center gap-2 w-full text-left py-1.5 group"
              data-testid={`day-${day.weekday}-toggle`}
            >
              {isCollapsed ? (
                <ChevronRight className="w-5 h-5 text-slate-400 group-hover:text-slate-600 transition-colors" />
              ) : (
                <ChevronDown className="w-5 h-5 text-slate-400 group-hover:text-slate-600 transition-colors" />
              )}
              <h3 className="text-lg font-semibold text-slate-900 m-0">{WEEKDAYS[day.weekday]}</h3>
              {isRestDay && <span className="text-sm text-slate-400 italic ml-1">Rest day</span>}
              {!isRestDay && (
                <span className="text-sm text-slate-500 ml-1">
                  ({day.template_sets.length} exercise{day.template_sets.length !== 1 ? 's' : ''})
                </span>
              )}
            </button>

            {!isCollapsed && (
              <>
                {isRestDay ? (
                  <p className="text-slate-500 italic text-sm ml-7" data-testid={`day-${day.weekday}-empty`}>
                    No exercises scheduled
                  </p>
                ) : (
                  <div className="overflow-x-auto sm:ml-7">
                    {/* Desktop table */}
                    <table className="hidden sm:table w-full text-sm" data-testid={`day-${day.weekday}-table`}>
                      <thead>
                        <tr>
                          <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                            #
                          </th>
                          <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                            Exercise
                          </th>
                          <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                            Reps
                          </th>
                          <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                            Load
                          </th>
                          <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                            % of 1RM
                          </th>
                          <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                            Rest
                          </th>
                          <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                            Action
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {day.template_sets.map((set, i) => (
                          <tr
                            key={i}
                            data-testid={`day-${day.weekday}-set-${i}`}
                            className="border-b border-slate-100 last:border-b-0"
                          >
                            <td className="px-3 py-2 align-middle" data-testid={`day-${day.weekday}-set-${i}-order`}>
                              {set.order}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <select
                                value={set.exercise_id}
                                aria-label="Exercise"
                                onChange={(e) => {
                                  const ex = exercises.find((ex) => ex.exercise_id === e.target.value);
                                  updateSet(day.weekday, i, 'exercise_id', e.target.value);
                                  if (ex) updateSet(day.weekday, i, 'exercise_name', ex.name);
                                }}
                                className="appearance-none rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                                data-testid={`day-${day.weekday}-set-${i}-exercise`}
                              >
                                {exercises.map((ex) => (
                                  <option key={ex.exercise_id} value={ex.exercise_id}>
                                    {ex.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <input
                                type="number"
                                className="w-15 text-center px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                                min="0"
                                aria-label="Target reps"
                                value={set.target_reps ?? ''}
                                onChange={(e) =>
                                  updateSet(
                                    day.weekday,
                                    i,
                                    'target_reps',
                                    e.target.value ? Number(e.target.value) : null,
                                  )
                                }
                                data-testid={`day-${day.weekday}-set-${i}-reps`}
                              />
                            </td>
                            <td className="px-3 py-2 align-middle">
                              {set.target_load_percentage ? (
                                <input
                                  type="number"
                                  className="w-20 text-center px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
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
                                  className="w-20 text-center px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                                  min="0"
                                  aria-label="Target load"
                                  value={set.target_load ?? ''}
                                  onChange={(e) =>
                                    updateSet(
                                      day.weekday,
                                      i,
                                      'target_load',
                                      e.target.value ? Number(e.target.value) : null,
                                    )
                                  }
                                  data-testid={`day-${day.weekday}-set-${i}-load`}
                                />
                              )}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <input
                                type="checkbox"
                                checked={set.target_load_percentage !== null}
                                aria-label="Use % of 1RM"
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    updateSet(
                                      day.weekday,
                                      i,
                                      'target_load_percentage',
                                      set.target_load_percentage ?? 80,
                                    );
                                    updateSet(day.weekday, i, 'target_load', null);
                                  } else {
                                    updateSet(day.weekday, i, 'target_load_percentage', null);
                                  }
                                }}
                                className="h-5 w-5 rounded border-slate-300 text-violet-600 focus:ring-violet-500/40"
                                data-testid={`day-${day.weekday}-set-${i}-rel`}
                              />
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  className="w-[70px] text-center px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                                  min="0"
                                  aria-label="Rest seconds"
                                  value={set.rest_seconds}
                                  onChange={(e) =>
                                    updateSet(
                                      day.weekday,
                                      i,
                                      'rest_seconds',
                                      e.target.value ? Number(e.target.value) : 90,
                                    )
                                  }
                                  data-testid={`day-${day.weekday}-set-${i}-rest`}
                                />
                                <div className="flex gap-0.5">
                                  {REST_PRESETS.map((preset) => (
                                    <button
                                      key={preset}
                                      type="button"
                                      onClick={() => updateSet(day.weekday, i, 'rest_seconds', preset)}
                                      className={`px-2 py-1.5 text-xs rounded border transition-colors min-w-[36px] ${
                                        set.rest_seconds === preset
                                          ? 'bg-violet-100 border-violet-300 text-violet-700 font-semibold'
                                          : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100 hover:border-slate-300'
                                      }`}
                                      data-testid={`day-${day.weekday}-set-${i}-rest-preset-${preset}`}
                                    >
                                      {preset}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => removeSet(day.weekday, i)}
                                data-testid={`day-${day.weekday}-set-${i}-delete`}
                                aria-label={`Remove set ${i + 1} from ${WEEKDAYS[day.weekday]}`}
                              >
                                Remove
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Mobile card layout */}
                    <div className="sm:hidden flex flex-col gap-3">
                      {day.template_sets.map((set, i) => (
                        <div
                          key={i}
                          data-testid={`day-${day.weekday}-set-${i}`}
                          className="border border-slate-200 rounded-lg p-3 bg-white"
                        >
                          {/* Top row: order badge + exercise select */}
                          <div className="flex items-center gap-2 mb-2">
                            <span
                              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-violet-100 text-violet-700 text-xs font-bold shrink-0"
                              data-testid={`day-${day.weekday}-set-${i}-order`}
                            >
                              {set.order}
                            </span>
                            <select
                              value={set.exercise_id}
                              aria-label="Exercise"
                              onChange={(e) => {
                                const ex = exercises.find((ex) => ex.exercise_id === e.target.value);
                                updateSet(day.weekday, i, 'exercise_id', e.target.value);
                                if (ex) updateSet(day.weekday, i, 'exercise_name', ex.name);
                              }}
                              className="flex-1 min-w-0 appearance-none rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                              data-testid={`day-${day.weekday}-set-${i}-exercise`}
                            >
                              {exercises.map((ex) => (
                                <option key={ex.exercise_id} value={ex.exercise_id}>
                                  {ex.name}
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Middle row: Reps, Load, Rest inputs */}
                          <div className="grid grid-cols-3 gap-2 mb-2">
                            <div>
                              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-0.5">
                                Reps
                              </label>
                              <input
                                type="number"
                                className="w-full text-center px-2 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                                min="0"
                                aria-label="Target reps"
                                value={set.target_reps ?? ''}
                                onChange={(e) =>
                                  updateSet(
                                    day.weekday,
                                    i,
                                    'target_reps',
                                    e.target.value ? Number(e.target.value) : null,
                                  )
                                }
                                data-testid={`day-${day.weekday}-set-${i}-reps`}
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-0.5">
                                {set.target_load_percentage ? 'Load %' : 'Load'}
                              </label>
                              {set.target_load_percentage ? (
                                <input
                                  type="number"
                                  className="w-full text-center px-2 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
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
                                  className="w-full text-center px-2 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                                  min="0"
                                  aria-label="Target load"
                                  value={set.target_load ?? ''}
                                  onChange={(e) =>
                                    updateSet(
                                      day.weekday,
                                      i,
                                      'target_load',
                                      e.target.value ? Number(e.target.value) : null,
                                    )
                                  }
                                  data-testid={`day-${day.weekday}-set-${i}-load`}
                                />
                              )}
                            </div>
                            <div>
                              <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide block mb-0.5">
                                Rest (s)
                              </label>
                              <input
                                type="number"
                                className="w-full text-center px-2 py-1.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                                min="0"
                                aria-label="Rest seconds"
                                value={set.rest_seconds}
                                onChange={(e) =>
                                  updateSet(
                                    day.weekday,
                                    i,
                                    'rest_seconds',
                                    e.target.value ? Number(e.target.value) : 90,
                                  )
                                }
                                data-testid={`day-${day.weekday}-set-${i}-rest`}
                              />
                            </div>
                          </div>

                          {/* Bottom row: %1RM toggle, rest presets, remove */}
                          <div className="flex items-center justify-between gap-2">
                            <label className="flex items-center gap-1.5 shrink-0">
                              <input
                                type="checkbox"
                                checked={set.target_load_percentage !== null}
                                aria-label="Use % of 1RM"
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    updateSet(
                                      day.weekday,
                                      i,
                                      'target_load_percentage',
                                      set.target_load_percentage ?? 80,
                                    );
                                    updateSet(day.weekday, i, 'target_load', null);
                                  } else {
                                    updateSet(day.weekday, i, 'target_load_percentage', null);
                                  }
                                }}
                                className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500/40"
                                data-testid={`day-${day.weekday}-set-${i}-rel`}
                              />
                              <span className="text-xs text-slate-600">%1RM</span>
                            </label>
                            <div className="flex gap-1">
                              {REST_PRESETS.map((preset) => (
                                <button
                                  key={preset}
                                  type="button"
                                  onClick={() => updateSet(day.weekday, i, 'rest_seconds', preset)}
                                  className={`px-1.5 py-1 text-[11px] rounded border transition-colors ${
                                    set.rest_seconds === preset
                                      ? 'bg-violet-100 border-violet-300 text-violet-700 font-semibold'
                                      : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100 hover:border-slate-300'
                                  }`}
                                  data-testid={`day-${day.weekday}-set-${i}-rest-preset-${preset}`}
                                >
                                  {preset}
                                </button>
                              ))}
                            </div>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => removeSet(day.weekday, i)}
                              data-testid={`day-${day.weekday}-set-${i}-delete`}
                              aria-label={`Remove set ${i + 1} from ${WEEKDAYS[day.weekday]}`}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-2 flex gap-2 sm:ml-7">
                  <Button
                    variant="success"
                    size="sm"
                    onClick={() => addSet(day.weekday)}
                    disabled={exercises.length === 0}
                    data-testid={`day-${day.weekday}-add`}
                  >
                    + Add Exercise
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => saveSplit(day)}
                    disabled={savingDay === day.weekday}
                    data-testid={`day-${day.weekday}-save`}
                  >
                    {savingDay === day.weekday ? 'Saving...' : 'Save'}
                  </Button>
                </div>

                <div className="mt-2 sm:ml-7">
                  <label className="text-sm font-semibold text-slate-700 block mb-1">Notes</label>
                  <textarea
                    value={day.split_notes}
                    onChange={(e) => updateNotes(day.weekday, e.target.value)}
                    data-testid={`day-${day.weekday}-notes`}
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 min-h-[60px]"
                  />
                </div>
              </>
            )}
          </div>
        );
      })}
    </CoachLayout>
  );
}
