import { useEffect, useState, useRef } from 'react';
import { WEIGHT_UNIT } from '@/shared/constants';
import { formatWeightWithPlates } from '@/shared/plateCalc';

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
  disabled?: boolean;
}

export function SetQueue({ sets, onComplete, onAdHoc, onUpdateSet, onDeleteSet, onAddSet, disabled }: SetQueueProps) {
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
      <div className="empty-state">
        <h3>No workout planned for today.</h3>
        <p>Add sets manually or configure your weekly split.</p>
      </div>
    );
  }

  return (
    <>
      {/* Next In Queue Section */}
      <div className="next-in-queue-section" data-testid="next-in-queue">
        <h3 style={{ marginTop: 0, marginBottom: 20, fontSize: 20, color: '#155724' }}>Next in Queue:</h3>

        {nextSet ? (
          <>
            <div className="next-set-box" data-testid="next-exercise">
              <div className="next-set-exercise">{nextSet.exercise_name}</div>
              <div className="next-set-detail">
                {nextSet.target_reps} reps @ {formatLoadDisplay(nextSet)}
              </div>
              <div className="next-set-rest">Rest: {nextSet.rest_seconds ?? 60} seconds</div>
            </div>

            <form
              className="completion-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleComplete();
              }}
              data-testid="completion-form"
            >
              <div className="form-group">
                <label>Exercise</label>
                <input
                  type="text"
                  value={nextSet.exercise_name}
                  readOnly
                  style={{ width: 180, padding: 8, fontSize: 16 }}
                  data-testid="override-exercise"
                />
              </div>
              <div className="form-group">
                <label>Reps Done</label>
                <input
                  type="number"
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  style={{ width: 80, padding: 8, fontSize: 16, textAlign: 'center' }}
                  data-testid="override-reps"
                />
              </div>
              <div className="form-group">
                <label>Weight ({WEIGHT_UNIT})</label>
                <input
                  type="number"
                  value={load}
                  onChange={(e) => setLoad(e.target.value)}
                  style={{ width: 80, padding: 8, fontSize: 16, textAlign: 'center' }}
                  data-testid="override-load"
                />
              </div>
              <button type="submit" className="btn btn-green btn-lg" disabled={disabled} data-testid="complete-set-btn">
                Complete Set
              </button>
              <button
                type="button"
                className="btn btn-cyan"
                onClick={onAdHoc}
                disabled={disabled}
                data-testid="adhoc-btn"
              >
                + Ad-Hoc Set
              </button>
            </form>

            {validationError && (
              <p className="error-text" style={{ margin: '8px 0 0' }} data-testid="validation-error">
                {validationError}
              </p>
            )}
          </>
        ) : (
          <div className="all-done-box">
            <div className="all-done-text">All sets completed!</div>
          </div>
        )}
      </div>

      {/* Pending Queue Table */}
      <div className="card">
        <h3 className="card-header">Set Queue ({pendingSets.length} remaining)</h3>
        <div className="card-body">
          {pendingSets.length === 0 && !nextSet ? (
            <p className="muted-text" style={{ fontStyle: 'italic', textAlign: 'center' }}>
              No sets remaining
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Exercise</th>
                  <th>Reps</th>
                  <th>Load</th>
                  <th>Rest</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingSets.map((set) => (
                  <tr key={set.planned_set_id} data-testid={`queue-row-${set.order}`}>
                    <td>{set.exercise_name}</td>
                    <td>
                      <input
                        type="number"
                        className="input-narrow"
                        defaultValue={set.target_reps ?? ''}
                        onBlur={(e) => {
                          const val = e.target.value ? Number(e.target.value) : null;
                          if (val !== set.target_reps) onUpdateSet?.(set.planned_set_id, 'target_reps', val);
                        }}
                        data-testid={`edit-reps-${set.order}`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="input-load"
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
                    <td>
                      <input
                        type="number"
                        className="input-rest"
                        defaultValue={set.rest_seconds ?? 60}
                        onBlur={(e) => {
                          const val = e.target.value ? Number(e.target.value) : null;
                          if (val !== set.rest_seconds) onUpdateSet?.(set.planned_set_id, 'rest_seconds', val);
                        }}
                        data-testid={`edit-rest-${set.order}`}
                      />
                    </td>
                    <td>
                      <button
                        className="btn btn-red btn-sm"
                        onClick={() => onDeleteSet?.(set.planned_set_id)}
                        data-testid={`delete-set-${set.order}`}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {onAddSet && (
            <button className="btn btn-green btn-sm" onClick={onAddSet} style={{ marginTop: 8 }}>
              + Add Set
            </button>
          )}
        </div>
      </div>
    </>
  );
}
