import { useState, useRef, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

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
    <div ref={formRef}>
      <Card className="mb-5" data-testid="adhoc-form">
        <CardHeader>
          <CardTitle>Ad-Hoc Set</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1 mb-3">
              <label className="text-sm font-semibold text-text-secondary">Exercise</label>
              <select
                value={exerciseId}
                onChange={(e) => setExerciseId(e.target.value)}
                className="w-full appearance-none rounded-lg border border-border-strong px-3 py-2 text-sm text-text bg-surface focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
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

            <div className="flex gap-4 mb-3">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-semibold text-text-secondary">Reps</label>
                <input
                  type="number"
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  className="w-20 px-3 py-2 text-sm text-center border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                  data-testid="adhoc-reps"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-semibold text-text-secondary">Load</label>
                <input
                  type="number"
                  value={load}
                  onChange={(e) => setLoad(e.target.value)}
                  className="w-20 px-3 py-2 text-sm text-center border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                  data-testid="adhoc-load"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button type="submit" variant="success" disabled={!canSubmit} data-testid="adhoc-submit">
                Add Set
              </Button>
              <Button variant="secondary" onClick={onCancel} data-testid="adhoc-cancel">
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
