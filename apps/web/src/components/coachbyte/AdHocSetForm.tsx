import { useState } from 'react';
import { IonButton, IonCard, IonCardContent, IonCardHeader, IonCardTitle, IonInput, IonSelect, IonSelectOption } from '@ionic/react';

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

  const canSubmit = exerciseId && reps && load && parseInt(reps, 10) >= 0 && parseFloat(load) >= 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(exerciseId, parseInt(reps, 10), parseFloat(load));
  };

  return (
    <IonCard data-testid="adhoc-form">
      <IonCardHeader>
        <IonCardTitle>Ad-Hoc Set</IonCardTitle>
      </IonCardHeader>
      <IonCardContent>
        <IonSelect
          label="Exercise"
          placeholder="Select exercise"
          value={exerciseId}
          onIonChange={(e) => setExerciseId(e.detail.value)}
          data-testid="exercise-select"
        >
          {exercises.map((ex) => (
            <IonSelectOption key={ex.exercise_id} value={ex.exercise_id}>
              {ex.name}
            </IonSelectOption>
          ))}
        </IonSelect>

        <div style={{ display: 'flex', gap: '16px', margin: '12px 0' }}>
          <IonInput
            label="Reps"
            type="number"
            value={reps}
            onIonInput={(e) => setReps(e.detail.value ?? '')}
            data-testid="adhoc-reps"
          />
          <IonInput
            label="Load"
            type="number"
            value={load}
            onIonInput={(e) => setLoad(e.detail.value ?? '')}
            data-testid="adhoc-load"
          />
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <IonButton onClick={handleSubmit} disabled={!canSubmit} data-testid="adhoc-submit">
            Add Set
          </IonButton>
          <IonButton onClick={onCancel} data-testid="adhoc-cancel">
            Cancel
          </IonButton>
        </div>
      </IonCardContent>
    </IonCard>
  );
}
