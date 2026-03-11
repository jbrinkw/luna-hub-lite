import { useEffect, useState, useRef } from 'react';
import { WEIGHT_UNIT } from '@/shared/constants';
import { formatWeightWithPlates } from '@/shared/plateCalc';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

export interface PlannedSet {
  planned_set_id: string;
  exercise_id: string;
  exercise_name: string;
  target_reps: number | null;
  target_load: number | null;
  target_load_percentage: number | null;
  rest_seconds: number | null;
  order: number;
  completed: boolean;
}

interface SetQueueProps {
  sets: PlannedSet[];
  onComplete: (reps: number, load: number) => void;
  onAdHoc: () => void;
  onUpdateSet?: (plannedSetId: string, field: string, value: number | null) => void;
  onDeleteSet?: (plannedSetId: string) => void;
  onAddSet?: () => void;
  timerState?: 'running' | 'paused' | 'expired' | 'idle';
  timerDisplay?: string;
  disabled?: boolean;
}

export function SetQueue({
  sets,
  onComplete,
  onAdHoc,
  onUpdateSet,
  onDeleteSet,
  onAddSet,
  timerState,
  timerDisplay,
  disabled,
}: SetQueueProps) {
  const nextSet = sets.find((s) => !s.completed);
  const [reps, setReps] = useState<string>(nextSet?.target_reps?.toString() ?? '');
  const [load, setLoad] = useState<string>(nextSet?.target_load?.toString() ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReps(nextSet?.target_reps?.toString() ?? '');

    setLoad(nextSet?.target_load?.toString() ?? '');

    setValidationError(null);
  }, [nextSet?.planned_set_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      clearTimeout(errorTimeoutRef.current);
    };
  }, []);

  const pendingSets = sets.filter((s) => !s.completed && s !== nextSet);

  const formatLoadDisplay = (set: PlannedSet) => {
    if (set.target_load_percentage && set.target_load) {
      return `${formatWeightWithPlates(set.target_load)} ${WEIGHT_UNIT} (${set.target_load_percentage}%)`;
    }
    if (set.target_load_percentage && !set.target_load) {
      return `--- (${set.target_load_percentage}% — no PR)`;
    }
    if (set.target_load) {
      return `${formatWeightWithPlates(set.target_load)} ${WEIGHT_UNIT}`;
    }
    return '---';
  };

  const handleComplete = () => {
    const r = parseInt(reps, 10);
    const l = parseFloat(load);
    if (isNaN(r) || isNaN(l)) {
      setValidationError('Please enter valid numbers for reps and load.');
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = setTimeout(() => setValidationError(null), 4000);
      return;
    }
    setValidationError(null);
    onComplete(r, l);
  };

  if (sets.length === 0) {
    return (
      <div className="text-center py-10 border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 text-slate-500">
        <h3 className="text-lg font-semibold mb-1">No workout planned for today.</h3>
        <p className="text-sm">Add sets manually or configure your weekly split.</p>
      </div>
    );
  }

  return (
    <>
      {/* Next In Queue Section */}
      <div className="border border-emerald-400 rounded-xl p-5 mb-5 bg-emerald-50/50" data-testid="next-in-queue">
        <h3 className="mt-0 mb-5 text-xl text-emerald-800 font-bold">Next in Queue:</h3>

        {nextSet ? (
          <>
            <div
              className="bg-emerald-100 p-4 rounded-lg mb-4 border-2 border-emerald-400 flex justify-between items-start"
              data-testid="next-exercise"
            >
              <div className="flex-1">
                <div className="text-2xl font-bold text-emerald-800 mb-1.5">{nextSet.exercise_name}</div>
                <div className="text-lg font-bold text-slate-900">
                  {nextSet.target_reps} reps @ {formatLoadDisplay(nextSet)}
                </div>
                <div className="text-sm text-slate-500 mt-1">Rest: {nextSet.rest_seconds ?? 60} seconds</div>
              </div>
              <div
                className={[
                  'font-bold text-right ml-5 min-w-[100px]',
                  timerState === 'running'
                    ? 'text-violet-600'
                    : timerState === 'expired'
                      ? 'text-red-600'
                      : 'text-slate-500',
                ].join(' ')}
                data-testid="inline-timer"
              >
                <div className="text-xs mb-0.5">{timerState === 'expired' ? 'Timer' : 'Rest Timer'}</div>
                <div className="text-5xl font-mono leading-none">
                  {timerState === 'expired' ? 'expired!' : timerDisplay || '0:00'}
                </div>
              </div>
            </div>

            <form
              className="flex gap-3 items-end flex-wrap mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                handleComplete();
              }}
              data-testid="completion-form"
            >
              <div className="flex flex-col gap-1">
                <label className="text-sm font-semibold text-slate-700">Exercise</label>
                <input
                  type="text"
                  value={nextSet.exercise_name}
                  readOnly
                  className="w-44 px-3 py-2 text-base border border-slate-300 rounded-lg bg-slate-50 text-slate-900"
                  data-testid="override-exercise"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-semibold text-slate-700">Reps Done</label>
                <input
                  type="number"
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  className="w-20 px-3 py-2 text-base text-center border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                  data-testid="override-reps"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-semibold text-slate-700">Weight ({WEIGHT_UNIT})</label>
                <input
                  type="number"
                  value={load}
                  onChange={(e) => setLoad(e.target.value)}
                  className="w-20 px-3 py-2 text-base text-center border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                  data-testid="override-load"
                />
              </div>
              <Button type="submit" variant="success" size="lg" disabled={disabled} data-testid="complete-set-btn">
                Complete Set
              </Button>
              <Button variant="primary" onClick={onAdHoc} disabled={disabled} data-testid="adhoc-btn">
                + Ad-Hoc Set
              </Button>
            </form>

            {validationError && (
              <p className="text-red-600 text-sm mt-2" data-testid="validation-error">
                {validationError}
              </p>
            )}
          </>
        ) : (
          <div className="bg-slate-50 border-2 border-slate-400 p-4 rounded-lg text-center">
            <div className="text-xl font-bold text-slate-500 py-2.5">All sets completed!</div>
          </div>
        )}
      </div>

      {/* Pending Queue Table */}
      <Card className="mb-5">
        <CardHeader>
          <CardTitle>Set Queue ({pendingSets.length} remaining)</CardTitle>
        </CardHeader>
        <CardContent>
          {pendingSets.length === 0 && !nextSet ? (
            <p className="text-slate-500 italic text-center text-sm">No sets remaining</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
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
                      Rest
                    </th>
                    <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pendingSets.map((set) => (
                    <tr
                      key={set.planned_set_id}
                      data-testid={`queue-row-${set.order}`}
                      className="border-b border-slate-100 last:border-b-0"
                    >
                      <td className="px-3 py-2 align-middle">{set.exercise_name}</td>
                      <td className="px-3 py-2 align-middle">
                        <input
                          type="number"
                          className="w-15 text-center px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                          defaultValue={set.target_reps ?? ''}
                          onBlur={(e) => {
                            const val = e.target.value ? Number(e.target.value) : null;
                            if (val !== set.target_reps) onUpdateSet?.(set.planned_set_id, 'target_reps', val);
                          }}
                          data-testid={`edit-reps-${set.order}`}
                        />
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <input
                          type="number"
                          className="w-20 text-center px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                          defaultValue={set.target_load_percentage ?? set.target_load ?? ''}
                          onBlur={(e) => {
                            const val = e.target.value ? Number(e.target.value) : null;
                            const field = set.target_load_percentage ? 'target_load_percentage' : 'target_load';
                            if (val !== (set.target_load_percentage ?? set.target_load))
                              onUpdateSet?.(set.planned_set_id, field, val);
                          }}
                          data-testid={`edit-load-${set.order}`}
                        />
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <input
                          type="number"
                          className="w-[70px] text-center px-2 py-1 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                          defaultValue={set.rest_seconds ?? 60}
                          onBlur={(e) => {
                            const val = e.target.value ? Number(e.target.value) : null;
                            if (val !== set.rest_seconds) onUpdateSet?.(set.planned_set_id, 'rest_seconds', val);
                          }}
                          data-testid={`edit-rest-${set.order}`}
                        />
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => onDeleteSet?.(set.planned_set_id)}
                          data-testid={`delete-set-${set.order}`}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {onAddSet && (
            <Button variant="success" size="sm" onClick={onAddSet} className="mt-2">
              + Add Set
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}
