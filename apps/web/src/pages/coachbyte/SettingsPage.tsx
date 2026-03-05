import { useEffect, useState, useCallback } from 'react';
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
        <p className="muted-text" data-testid="settings-loading">
          Loading settings...
        </p>
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Settings">
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
        <h2 style={{ margin: 0 }}>Settings</h2>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="settings-section" data-testid="defaults-card">
        <h3>Defaults</h3>
        <div className="form-group" style={{ maxWidth: 300 }}>
          <label>Default Rest Duration (seconds)</label>
          <input
            type="number"
            min="0"
            value={settings.default_rest_seconds}
            onChange={(e) => setSettings((prev) => ({ ...prev, default_rest_seconds: Number(e.target.value) || 90 }))}
            onBlur={saveSettings}
            data-testid="default-rest-input"
          />
        </div>
      </div>

      <div className="settings-section" data-testid="plate-calc-card">
        <h3>Plate Calculator</h3>
        <div className="form-group" style={{ maxWidth: 300, marginBottom: 16 }}>
          <label>Bar Weight (lbs)</label>
          <input
            type="number"
            min="0"
            value={settings.bar_weight_lbs}
            onChange={(e) => setSettings((prev) => ({ ...prev, bar_weight_lbs: Number(e.target.value) || 45 }))}
            onBlur={saveSettings}
            data-testid="bar-weight-input"
          />
        </div>

        <p style={{ marginBottom: 4, fontWeight: 'bold', fontSize: 14 }}>Available Plates:</p>
        <div className="plate-grid">
          {DEFAULT_PLATES.map((plate) => (
            <label className="plate-item" key={plate}>
              <input
                type="checkbox"
                checked={settings.available_plates.includes(plate)}
                onChange={() => {
                  const newPlates = settings.available_plates.includes(plate)
                    ? settings.available_plates.filter((p) => p !== plate)
                    : [...settings.available_plates, plate].sort((a, b) => b - a);
                  const newSettings = { ...settings, available_plates: newPlates };
                  setSettings(newSettings);
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
              />
              {plate} lb
            </label>
          ))}
        </div>
      </div>

      <div className="settings-section" data-testid="exercise-library-card">
        <h3>Exercise Library</h3>

        <div style={{ marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Search exercises..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            data-testid="exercise-search"
            style={{ width: '100%' }}
          />
        </div>

        <div data-testid="exercise-list">
          {filteredExercises.map((ex) => (
            <div className="exercise-list-item" key={ex.exercise_id} data-testid={`exercise-${ex.exercise_id}`}>
              <span>
                {ex.name}
                <span className="exercise-tag">({ex.user_id ? 'custom' : 'global'})</span>
              </span>
              {ex.user_id && (
                <button
                  className="btn btn-red btn-sm"
                  onClick={() => deleteExercise(ex.exercise_id)}
                  data-testid={`delete-exercise-${ex.exercise_id}`}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            type="text"
            placeholder="New exercise name..."
            value={newExerciseName}
            onChange={(e) => setNewExerciseName(e.target.value)}
            data-testid="new-exercise-input"
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-green"
            onClick={addCustomExercise}
            disabled={!newExerciseName.trim()}
            data-testid="add-exercise-btn"
          >
            + Add Custom Exercise
          </button>
        </div>
      </div>
    </CoachLayout>
  );
}
