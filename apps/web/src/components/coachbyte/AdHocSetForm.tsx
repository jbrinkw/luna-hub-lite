import { useState, useRef, useEffect } from 'react';

export interface Exercise {
  exercise_id: string;
  name: string;
}

interface AdHocSetFormProps {
  exercises: Exercise[];
  onSubmit: (exerciseId: string, reps: number, load: number) => void;
  onCancel: () => void;
}

export function AdHocSetForm({ exercises, onSubmit, onCancel }: AdHocSetFormProps) {
  const [exerciseId, setExerciseId] = useState('');
  const [reps, setReps] = useState('');
  const [load, setLoad] = useState('');
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    formRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const canSubmit = exerciseId && reps && load && parseInt(reps, 10) >= 0 && parseFloat(load) >= 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(exerciseId, parseInt(reps, 10), parseFloat(load));
  };

  return (
    <div className="card" data-testid="adhoc-form" ref={formRef}>
      <h3 className="card-header">Ad-Hoc Set</h3>
      <div className="card-body">
        <form onSubmit={handleSubmit}>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label>Exercise</label>
            <select
              value={exerciseId}
              onChange={(e) => setExerciseId(e.target.value)}
              className="input-full"
              data-testid="exercise-select"
            >
              <option value="">Select exercise...</option>
              {exercises.map((ex) => (
                <option key={ex.exercise_id} value={ex.exercise_id}>
                  {ex.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <div className="form-group">
              <label>Reps</label>
              <input
                type="number"
                value={reps}
                onChange={(e) => setReps(e.target.value)}
                className="input-narrow"
                style={{ width: 80, padding: 8 }}
                data-testid="adhoc-reps"
              />
            </div>
            <div className="form-group">
              <label>Load</label>
              <input
                type="number"
                value={load}
                onChange={(e) => setLoad(e.target.value)}
                className="input-load"
                style={{ padding: 8 }}
                data-testid="adhoc-load"
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-green" disabled={!canSubmit} data-testid="adhoc-submit">
              Add Set
            </button>
            <button type="button" className="btn btn-gray" onClick={onCancel} data-testid="adhoc-cancel">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
