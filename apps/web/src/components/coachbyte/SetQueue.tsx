import { useEffect, useState } from 'react';
import { IonButton, IonCard, IonCardContent, IonCardHeader, IonCardTitle, IonInput, IonText } from '@ionic/react';
import { WEIGHT_UNIT } from '@/shared/constants';

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
  timerState?: 'running' | 'paused' | 'expired' | 'idle';
  onTimerToggle?: () => void;
  disabled?: boolean;
}

export function SetQueue({ sets, onComplete, onAdHoc, timerState, onTimerToggle, disabled }: SetQueueProps) {
  const nextSet = sets.find((s) => !s.completed);
  const [reps, setReps] = useState<string>(nextSet?.target_reps?.toString() ?? '');
  const [load, setLoad] = useState<string>(nextSet?.target_load?.toString() ?? '');

  // Sync reps/load inputs when the active set changes (e.g. after completing a set)
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setReps(nextSet?.target_reps?.toString() ?? '');
    setLoad(nextSet?.target_load?.toString() ?? '');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [nextSet?.planned_set_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingSets = sets.filter((s) => !s.completed && s !== nextSet);

  if (sets.length === 0) {
    return (
      <IonCard>
        <IonCardContent>
          <IonText>
            <p>No workout planned for today.</p>
          </IonText>
        </IonCardContent>
      </IonCard>
    );
  }

  const formatLoadDisplay = (set: PlannedSet) => {
    if (set.target_load_percentage && set.target_load) {
      return `${set.target_load} ${WEIGHT_UNIT} (${set.target_load_percentage}%)`;
    }
    if (set.target_load_percentage && !set.target_load) {
      return `--- (${set.target_load_percentage}% — no PR)`;
    }
    if (set.target_load) {
      return `${set.target_load} ${WEIGHT_UNIT}`;
    }
    return '---';
  };

  const handleComplete = () => {
    const r = parseInt(reps, 10);
    const l = parseFloat(load);
    if (!isNaN(r) && !isNaN(l)) {
      onComplete(r, l);
    }
  };

  const timerLabel =
    timerState === 'running'
      ? 'Pause'
      : timerState === 'paused'
        ? 'Resume'
        : timerState === 'expired'
          ? 'Timer expired'
          : 'Start Timer';

  return (
    <div>
      {/* Next In Queue Card */}
      {nextSet && (
        <IonCard data-testid="next-in-queue">
          <IonCardHeader>
            <IonCardTitle>
              <span>NEXT IN QUEUE</span>
            </IonCardTitle>
          </IonCardHeader>
          <IonCardContent>
            <p data-testid="next-exercise">
              <strong>{nextSet.exercise_name}</strong> {nextSet.target_reps} x {formatLoadDisplay(nextSet)}
            </p>

            <div style={{ display: 'flex', gap: '16px', margin: '12px 0' }}>
              <IonInput
                label="Reps"
                type="number"
                value={reps}
                onIonInput={(e) => setReps(e.detail.value ?? '')}
                data-testid="override-reps"
              />
              <IonInput
                label="Load"
                type="number"
                value={load}
                onIonInput={(e) => setLoad(e.detail.value ?? '')}
                data-testid="override-load"
              />
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <IonButton onClick={handleComplete} disabled={disabled} data-testid="complete-set-btn">
                Complete Set
              </IonButton>
              {onTimerToggle && (
                <IonButton onClick={onTimerToggle} disabled={timerState === 'expired'} data-testid="timer-toggle-btn">
                  {timerLabel}
                </IonButton>
              )}
              <IonButton onClick={onAdHoc} disabled={disabled} data-testid="adhoc-btn">
                + Ad-Hoc Set
              </IonButton>
            </div>
          </IonCardContent>
        </IonCard>
      )}

      {/* Pending Queue Table */}
      <IonCard>
        <IonCardHeader>
          <IonCardTitle>SET QUEUE</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          {pendingSets.length === 0 && !nextSet ? (
            <p>All sets completed!</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>#</th>
                  <th style={{ textAlign: 'left' }}>Exercise</th>
                  <th style={{ textAlign: 'left' }}>Reps</th>
                  <th style={{ textAlign: 'left' }}>Load</th>
                </tr>
              </thead>
              <tbody>
                {pendingSets.map((set) => (
                  <tr key={set.planned_set_id} data-testid={`queue-row-${set.order}`}>
                    <td>{set.order}</td>
                    <td>{set.exercise_name}</td>
                    <td>{set.target_reps ?? '—'}</td>
                    <td>{formatLoadDisplay(set)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </IonCardContent>
      </IonCard>
    </div>
  );
}
