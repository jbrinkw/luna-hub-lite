import { useEffect, useState, useCallback } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonButton,
  IonInput,
  IonCheckbox,
  IonItem,
  IonLabel,
  IonList,
  IonText,
} from '@ionic/react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

interface UserSettings {
  default_rest_seconds: number;
  bar_weight_lbs: number;
  available_plates: number[];
}

interface Exercise {
  exercise_id: string;
  name: string;
  user_id: string | null;
}

const DEFAULT_PLATES = [45, 35, 25, 10, 5, 2.5];

export function SettingsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<UserSettings>({
    default_rest_seconds: 90,
    bar_weight_lbs: 45,
    available_plates: DEFAULT_PLATES,
  });
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [searchText, setSearchText] = useState('');
  const [newExerciseName, setNewExerciseName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    if (!user) return;

    const { data } = await supabase
      .schema('coachbyte')
      .from('user_settings')
      .select('default_rest_seconds, bar_weight_lbs, available_plates')
      .eq('user_id', user.id)
      .single();

    if (data) {
      setSettings({
        default_rest_seconds: data.default_rest_seconds,
        bar_weight_lbs: Number(data.bar_weight_lbs),
        available_plates: (data.available_plates as number[]) ?? DEFAULT_PLATES,
      });
    }
    setLoading(false);
  }, [user]);

  const loadExercises = useCallback(async () => {
    if (!user) return;

    const { data } = await supabase
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name, user_id')
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order('name');

    setExercises((data ?? []) as Exercise[]);
  }, [user]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    /* eslint-disable react-hooks/set-state-in-effect */
    loadSettings();
    loadExercises();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [loadSettings, loadExercises]);

  const saveSettings = async () => {
    if (!user) return;
    setError(null);
    const { error: saveErr } = await supabase
      .schema('coachbyte')
      .from('user_settings')
      .update({
        default_rest_seconds: settings.default_rest_seconds,
        bar_weight_lbs: settings.bar_weight_lbs,
        available_plates: settings.available_plates as any,
      })
      .eq('user_id', user.id);
    if (saveErr) {
      setError(saveErr.message);
    }
  };

  const addCustomExercise = async () => {
    if (!user || !newExerciseName.trim()) return;
    setError(null);

    const { error: insertErr } = await supabase
      .schema('coachbyte')
      .from('exercises')
      .insert({ user_id: user.id, name: newExerciseName.trim() });
    if (insertErr) {
      setError(insertErr.message);
      return;
    }

    setNewExerciseName('');
    await loadExercises();
  };

  const deleteExercise = async (exerciseId: string) => {
    setError(null);
    const { error: deleteErr } = await supabase
      .schema('coachbyte')
      .from('exercises')
      .delete()
      .eq('exercise_id', exerciseId);
    if (deleteErr) {
      setError(deleteErr.message);
      return;
    }

    await loadExercises();
  };

  const filteredExercises = searchText
    ? exercises.filter((e) => e.name.toLowerCase().includes(searchText.toLowerCase()))
    : exercises;

  if (loading) {
    return (
      <CoachLayout title="Settings">
        <IonSpinner data-testid="settings-loading" />
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Settings">
      <h2>SETTINGS</h2>

      {error && (
        <IonText color="danger">
          <p>{error}</p>
        </IonText>
      )}

      <IonCard data-testid="defaults-card">
        <IonCardHeader>
          <IonCardTitle>Defaults</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          <IonInput
            label="Default Rest Duration (seconds)"
            type="number"
            min="0"
            value={settings.default_rest_seconds}
            onIonInput={(e) => setSettings((prev) => ({ ...prev, default_rest_seconds: Number(e.detail.value) || 90 }))}
            onIonBlur={saveSettings}
            data-testid="default-rest-input"
          />
        </IonCardContent>
      </IonCard>

      <IonCard data-testid="plate-calc-card">
        <IonCardHeader>
          <IonCardTitle>Plate Calculator</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          <IonInput
            label="Bar Weight (lbs)"
            type="number"
            min="0"
            value={settings.bar_weight_lbs}
            onIonInput={(e) => setSettings((prev) => ({ ...prev, bar_weight_lbs: Number(e.detail.value) || 45 }))}
            onIonBlur={saveSettings}
            data-testid="bar-weight-input"
          />

          <p style={{ marginTop: '12px', marginBottom: '4px' }}>Available Plates:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {DEFAULT_PLATES.map((plate) => (
              <IonItem key={plate} lines="none" style={{ '--padding-start': '0' }}>
                <IonCheckbox
                  checked={settings.available_plates.includes(plate)}
                  onIonChange={() => {
                    // Compute new plates inline to avoid stale closure in saveSettings
                    const newPlates = settings.available_plates.includes(plate)
                      ? settings.available_plates.filter((p) => p !== plate)
                      : [...settings.available_plates, plate].sort((a, b) => b - a);
                    const newSettings = { ...settings, available_plates: newPlates };
                    setSettings(newSettings);
                    // Save with the freshly computed settings
                    (async () => {
                      const { error: saveErr } = await supabase
                        .schema('coachbyte')
                        .from('user_settings')
                        .update({
                          default_rest_seconds: newSettings.default_rest_seconds,
                          bar_weight_lbs: newSettings.bar_weight_lbs,
                          available_plates: newSettings.available_plates as any,
                        })
                        .eq('user_id', user!.id);
                      if (saveErr) setError(saveErr.message);
                    })();
                  }}
                  data-testid={`plate-${plate}`}
                >
                  {plate} lb
                </IonCheckbox>
              </IonItem>
            ))}
          </div>
        </IonCardContent>
      </IonCard>

      <IonCard data-testid="exercise-library-card">
        <IonCardHeader>
          <IonCardTitle>Exercise Library</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          <IonInput
            placeholder="Search exercises..."
            value={searchText}
            onIonInput={(e) => setSearchText(e.detail.value ?? '')}
            data-testid="exercise-search"
          />

          <IonList data-testid="exercise-list">
            {filteredExercises.map((ex) => (
              <IonItem key={ex.exercise_id} data-testid={`exercise-${ex.exercise_id}`}>
                <IonLabel>
                  {ex.name}
                  <span style={{ color: '#888', marginLeft: '8px', fontSize: '0.85em' }}>
                    ({ex.user_id ? 'custom' : 'global'})
                  </span>
                </IonLabel>
                {ex.user_id && (
                  <IonButton
                    slot="end"
                    size="small"
                    color="danger"
                    fill="clear"
                    onClick={() => deleteExercise(ex.exercise_id)}
                    data-testid={`delete-exercise-${ex.exercise_id}`}
                  >
                    Delete
                  </IonButton>
                )}
              </IonItem>
            ))}
          </IonList>

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <IonInput
              placeholder="New exercise name..."
              value={newExerciseName}
              onIonInput={(e) => setNewExerciseName(e.detail.value ?? '')}
              data-testid="new-exercise-input"
            />
            <IonButton onClick={addCustomExercise} disabled={!newExerciseName.trim()} data-testid="add-exercise-btn">
              + Add Custom Exercise
            </IonButton>
          </div>
        </IonCardContent>
      </IonCard>
    </CoachLayout>
  );
}
