import { useEffect, useState, useCallback } from 'react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import { useSaveIndicator } from '@/hooks/useSaveIndicator';

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
  const { showSaved: settingsSaved, flash: flashSettings } = useSaveIndicator();

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
    } else {
      flashSettings();
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
        <p className="text-slate-500 text-sm" data-testid="settings-loading">
          Loading settings...
        </p>
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Settings">
      <div className="flex justify-between items-center border-b-2 border-slate-200 pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-slate-900 m-0">Settings</h2>
      </div>

      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

      <Card className="mb-5" data-testid="defaults-card">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Defaults</CardTitle>
            <SaveIndicator show={settingsSaved} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1 max-w-[300px]">
            <label className="text-sm font-semibold text-slate-700">Default Rest Duration (seconds)</label>
            <input
              type="number"
              min="0"
              value={settings.default_rest_seconds}
              onChange={(e) => setSettings((prev) => ({ ...prev, default_rest_seconds: Number(e.target.value) || 90 }))}
              onBlur={saveSettings}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
              data-testid="default-rest-input"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-5" data-testid="plate-calc-card">
        <CardHeader>
          <CardTitle>Plate Calculator</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1 max-w-[300px] mb-4">
            <label className="text-sm font-semibold text-slate-700">Bar Weight (lbs)</label>
            <input
              type="number"
              min="0"
              value={settings.bar_weight_lbs}
              onChange={(e) => setSettings((prev) => ({ ...prev, bar_weight_lbs: Number(e.target.value) || 45 }))}
              onBlur={saveSettings}
              className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
              data-testid="bar-weight-input"
            />
          </div>

          <p className="mb-1 font-bold text-sm text-slate-700">Available Plates:</p>
          <div className="flex flex-wrap gap-3">
            {DEFAULT_PLATES.map((plate) => (
              <label className="flex items-center gap-1.5 text-sm cursor-pointer" key={plate}>
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
                      else flashSettings();
                    })();
                  }}
                  className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500/40"
                  data-testid={`plate-${plate}`}
                />
                {plate} lb
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mb-5" data-testid="exercise-library-card">
        <CardHeader>
          <CardTitle>Exercise Library</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3">
            <input
              type="text"
              placeholder="Search exercises..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              data-testid="exercise-search"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
            />
          </div>

          <div data-testid="exercise-list">
            {filteredExercises.map((ex) => (
              <div
                className="flex items-center justify-between py-2 border-b border-slate-100 last:border-b-0"
                key={ex.exercise_id}
                data-testid={`exercise-${ex.exercise_id}`}
              >
                <span className="text-sm text-slate-900">
                  {ex.name}
                  <span className="text-slate-400 ml-2 text-xs">({ex.user_id ? 'custom' : 'global'})</span>
                </span>
                {ex.user_id && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => deleteExercise(ex.exercise_id)}
                    data-testid={`delete-exercise-${ex.exercise_id}`}
                  >
                    Delete
                  </Button>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-2 mt-3">
            <input
              type="text"
              placeholder="New exercise name..."
              value={newExerciseName}
              onChange={(e) => setNewExerciseName(e.target.value)}
              data-testid="new-exercise-input"
              className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
            />
            <Button
              variant="success"
              onClick={addCustomExercise}
              disabled={!newExerciseName.trim()}
              data-testid="add-exercise-btn"
            >
              + Add Custom Exercise
            </Button>
          </div>
        </CardContent>
      </Card>
    </CoachLayout>
  );
}
