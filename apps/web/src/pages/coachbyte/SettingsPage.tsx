import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import { useSaveIndicator } from '@/hooks/useSaveIndicator';
import { queryKeys } from '@/shared/queryKeys';

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
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<UserSettings>({
    default_rest_seconds: 90,
    bar_weight_lbs: 45,
    available_plates: DEFAULT_PLATES,
  });
  const [searchText, setSearchText] = useState('');
  const [newExerciseName, setNewExerciseName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { showSaved: settingsSaved, flash: flashSettings } = useSaveIndicator();

  // ── Settings query ──
  const { isLoading: settingsLoading } = useQuery({
    queryKey: queryKeys.coachSettings(user!.id),
    queryFn: async () => {
      const { data } = await supabase
        .schema('coachbyte')
        .from('user_settings')
        .select('default_rest_seconds, bar_weight_lbs, available_plates')
        .eq('user_id', user!.id)
        .single();

      if (data) {
        const s = {
          default_rest_seconds: data.default_rest_seconds,
          bar_weight_lbs: Number(data.bar_weight_lbs),
          available_plates: (data.available_plates as number[]) ?? DEFAULT_PLATES,
        };
        setSettings(s);
        return s;
      }
      return null;
    },
    enabled: !!user,
  });

  // ── Exercises query ──
  const { data: exercises = [], isLoading: exercisesLoading } = useQuery({
    queryKey: queryKeys.exercises(user!.id),
    queryFn: async (): Promise<Exercise[]> => {
      const { data } = await supabase
        .schema('coachbyte')
        .from('exercises')
        .select('exercise_id, name, user_id')
        .or(`user_id.is.null,user_id.eq.${user!.id}`)
        .order('name');
      return (data ?? []) as Exercise[];
    },
    enabled: !!user,
  });

  const loading = settingsLoading || exercisesLoading;

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

  // ── Add exercise mutation ──
  const addExerciseMutation = useMutation({
    mutationFn: async (name: string) => {
      const { error: insertErr } = await supabase
        .schema('coachbyte')
        .from('exercises')
        .insert({ user_id: user!.id, name: name.trim() });
      if (insertErr) throw insertErr;
    },
    onSuccess: () => {
      setNewExerciseName('');
      queryClient.invalidateQueries({ queryKey: queryKeys.exercises(user!.id) });
    },
    onError: (err: any) => {
      setError(err.message);
    },
  });

  const addCustomExercise = () => {
    if (!user || !newExerciseName.trim()) return;
    setError(null);
    addExerciseMutation.mutate(newExerciseName);
  };

  // ── Delete exercise mutation ──
  const deleteExerciseMutation = useMutation({
    mutationFn: async (exerciseId: string) => {
      const { error: deleteErr } = await supabase
        .schema('coachbyte')
        .from('exercises')
        .delete()
        .eq('exercise_id', exerciseId);
      if (deleteErr) throw deleteErr;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.exercises(user!.id) });
    },
    onError: (err: any) => {
      setError(err.message);
    },
  });

  const deleteExercise = (exerciseId: string) => {
    setError(null);
    deleteExerciseMutation.mutate(exerciseId);
  };

  const filteredExercises = searchText
    ? exercises.filter((e) => e.name.toLowerCase().includes(searchText.toLowerCase()))
    : exercises;

  if (loading) {
    return (
      <CoachLayout title="Settings">
        <ListSkeleton count={5} data-testid="settings-loading" />
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Settings">
      <div className="flex justify-between items-center border-b-2 border-border pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-text m-0">Settings</h2>
      </div>

      {error && <p className="text-danger-text text-sm mb-3">{error}</p>}

      <Card className="mb-5" data-testid="defaults-card">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Defaults</CardTitle>
            <SaveIndicator show={settingsSaved} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1 max-w-[300px]">
            <label className="text-sm font-semibold text-text-secondary">Default Rest Duration (seconds)</label>
            <input
              type="number"
              min="0"
              value={settings.default_rest_seconds}
              onChange={(e) => setSettings((prev) => ({ ...prev, default_rest_seconds: Number(e.target.value) || 90 }))}
              onBlur={saveSettings}
              className="px-3 py-2 text-sm border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
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
            <label className="text-sm font-semibold text-text-secondary">Bar Weight (lbs)</label>
            <input
              type="number"
              min="0"
              value={settings.bar_weight_lbs}
              onChange={(e) => setSettings((prev) => ({ ...prev, bar_weight_lbs: Number(e.target.value) || 45 }))}
              onBlur={saveSettings}
              className="px-3 py-2 text-sm border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              data-testid="bar-weight-input"
            />
          </div>

          <p className="mb-1 font-bold text-sm text-text-secondary">Available Plates:</p>
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
                  className="h-4 w-4 rounded border-border-strong text-coach-accent focus:ring-focus-ring"
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
              className="w-full px-3 py-2 text-sm border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
            />
          </div>

          <div data-testid="exercise-list">
            {filteredExercises.map((ex) => (
              <div
                className="flex items-center justify-between py-2 border-b border-border-light last:border-b-0"
                key={ex.exercise_id}
                data-testid={`exercise-${ex.exercise_id}`}
              >
                <span className="text-sm text-text">
                  {ex.name}
                  <span className="text-text-tertiary ml-2 text-xs">({ex.user_id ? 'custom' : 'global'})</span>
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
              className="flex-1 px-3 py-2 text-sm border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
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
