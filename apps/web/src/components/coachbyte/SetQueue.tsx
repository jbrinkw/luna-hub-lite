import { useEffect, useState } from 'react';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonIcon,
  IonInput,
  IonText,
} from '@ionic/react';
import { closeCircleOutline } from 'ionicons/icons';
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
  onTimerToggle?: () => void;
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
  onTimerToggle,
  disabled,
}: SetQueueProps) {
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
                min="0"
                value={reps}
                onIonInput={(e) => setReps(e.detail.value ?? '')}
                data-testid="override-reps"
              />
              <IonInput
                label="Load"
                type="number"
                min="0"
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
                  <th style={{ textAlign: 'left' }}>Rest</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pendingSets.map((set) => (
                  <tr key={set.planned_set_id} data-testid={`queue-row-${set.order}`}>
                    <td>{set.order}</td>
                    <td>{set.exercise_name}</td>
                    <td>
                      <IonInput
                        type="number"
                        min="0"
                        value={set.target_reps}
                        onIonBlur={(e) => {
                          const val = e.target.value ? Number(e.target.value) : null;
                          if (val !== set.target_reps) onUpdateSet?.(set.planned_set_id, 'target_reps', val);
                        }}
                        style={{ width: '60px' }}
                        data-testid={`edit-reps-${set.order}`}
                      />
                    </td>
                    <td>
                      <IonInput
                        type="number"
                        min="0"
                        value={set.target_load_percentage ?? set.target_load}
                        onIonBlur={(e) => {
                          const val = e.target.value ? Number(e.target.value) : null;
                          const field = set.target_load_percentage ? 'target_load_percentage' : 'target_load';
                          if (val !== (set.target_load_percentage ?? set.target_load))
                            onUpdateSet?.(set.planned_set_id, field, val);
                        }}
                        style={{ width: '80px' }}
                        data-testid={`edit-load-${set.order}`}
                      />
                    </td>
                    <td>
                      <IonInput
                        type="number"
                        min="0"
                        value={set.rest_seconds}
                        onIonBlur={(e) => {
                          const val = e.target.value ? Number(e.target.value) : null;
                          if (val !== set.rest_seconds) onUpdateSet?.(set.planned_set_id, 'rest_seconds', val);
                        }}
                        style={{ width: '60px' }}
                        data-testid={`edit-rest-${set.order}`}
                      />
                    </td>
                    <td>
                      <IonButton
                        fill="clear"
                        color="danger"
                        size="small"
                        onClick={() => onDeleteSet?.(set.planned_set_id)}
                        data-testid={`delete-set-${set.order}`}
                        aria-label="Remove set"
                      >
                        <IonIcon slot="icon-only" icon={closeCircleOutline} />
                      </IonButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {onAddSet && (
            <IonButton fill="outline" size="small" onClick={onAddSet} style={{ marginTop: 8 }}>
              + Add Set
            </IonButton>
          )}
        </IonCardContent>
      </IonCard>
    </div>
  );
}
