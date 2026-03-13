import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';
import { formatTime } from '@/shared/formatTime';
import { AdHocSetForm, type Exercise } from '@/components/coachbyte/AdHocSetForm';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { coachbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { WEIGHT_UNIT } from '@/shared/constants';
import { epley1RM } from '@/pages/coachbyte/PrsPage';
import { formatWeightWithPlates } from '@/shared/plateCalc';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import { useSaveIndicator } from '@/hooks/useSaveIndicator';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

interface CompletedSet {
  completed_set_id: string;
  exercise_name: string;
  actual_reps: number;
  actual_load: number;
  completed_at: string;
}

interface TimerState {
  state: 'running' | 'paused' | 'expired' | 'idle';
  end_time: string | null;
  duration_seconds: number;
  elapsed_before_pause: number;
}

const DEFAULT_TIMER: TimerState = {
  state: 'idle',
  end_time: null,
  duration_seconds: 0,
  elapsed_before_pause: 0,
};

interface DailyPlanData {
  planId: string;
  sets: PlannedSet[];
  completedSets: CompletedSet[];
  summary: string;
  notes: string;
}

export function TodayPage() {
  const { user } = useAuth();
  const { dayStartHour } = useAppContext();
  const queryClient = useQueryClient();
  const [showAdHoc, setShowAdHoc] = useState(false);
  const [addingPlanned, setAddingPlanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [prToast, setPrToast] = useState<string | null>(null);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const { showSaved: notesSaved, flash: flashNotes } = useSaveIndicator();
  const { showSaved: summarySaved, flash: flashSummary } = useSaveIndicator();
  const summaryRef = useRef('');
  const notesRef = useRef('');
  const summaryDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const notesDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isEditingRef = useRef(false);

  // Local state for summary/notes (controlled by debounced save)
  const [summary, setSummary] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    return () => {
      if (summaryDebounceRef.current) clearTimeout(summaryDebounceRef.current);
      if (notesDebounceRef.current) clearTimeout(notesDebounceRef.current);
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    };
  }, []);

  const today = todayStr(dayStartHour);

  // ── Daily Plan query ──
  const {
    data: planData,
    isLoading: planLoading,
    error: planError,
  } = useQuery({
    queryKey: queryKeys.dailyPlan(user!.id, today),
    queryFn: async (): Promise<DailyPlanData> => {
      const { data: planResult, error: planErr } = await coachbyte().rpc('ensure_daily_plan', { p_day: today });
      if (planErr) throw planErr;

      const result = planResult as { plan_id: string; status: string };

      const [{ data: plannedData }, { data: completedData }, { data: planInfo }] = await Promise.all([
        coachbyte()
          .from('planned_sets')
          .select(
            'planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, "order", exercises(name)',
          )
          .eq('plan_id', result.plan_id)
          .order('"order"'),
        coachbyte()
          .from('completed_sets')
          .select('completed_set_id, planned_set_id, actual_reps, actual_load, completed_at, exercises(name)')
          .eq('plan_id', result.plan_id)
          .order('completed_at'),
        coachbyte().from('daily_plans').select('summary, notes').eq('plan_id', result.plan_id).single(),
      ]);

      const completedPlanIds = new Set(completedData?.map((cs: any) => cs.planned_set_id).filter(Boolean) ?? []);

      const mapped: PlannedSet[] = (plannedData ?? []).map((ps: any) => ({
        planned_set_id: ps.planned_set_id,
        exercise_id: ps.exercise_id,
        exercise_name: ps.exercises?.name ?? 'Unknown',
        target_reps: ps.target_reps,
        target_load: ps.target_load ? Number(ps.target_load) : null,
        target_load_percentage: ps.target_load_percentage ? Number(ps.target_load_percentage) : null,
        rest_seconds: ps.rest_seconds,
        order: ps.order,
        completed: completedPlanIds.has(ps.planned_set_id),
      }));

      const completedMapped: CompletedSet[] = (completedData ?? []).map((cs: any) => ({
        completed_set_id: cs.completed_set_id,
        exercise_name: cs.exercises?.name ?? 'Unknown',
        actual_reps: cs.actual_reps,
        actual_load: Number(cs.actual_load),
        completed_at: cs.completed_at,
      }));

      return {
        planId: result.plan_id,
        sets: mapped,
        completedSets: completedMapped,
        summary: planInfo?.summary ?? '',
        notes: (planInfo as any)?.notes ?? '',
      };
    },
    enabled: !!user,
  });

  // Sync local summary/notes from query data
  /* eslint-disable react-hooks/set-state-in-effect -- legitimate: sync server state → local form fields */
  useEffect(() => {
    if (planData) {
      setSummary(planData.summary);
      summaryRef.current = planData.summary;
      setNotes(planData.notes);
      notesRef.current = planData.notes;
    }
  }, [planData]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const planId = planData?.planId ?? null;
  const sets = planData?.sets ?? [];
  const completedSets = planData?.completedSets ?? [];

  // ── Timer query ──
  const { data: timer = DEFAULT_TIMER } = useQuery({
    queryKey: queryKeys.timer(user!.id),
    queryFn: async (): Promise<TimerState> => {
      const { data } = await coachbyte()
        .from('timers')
        .select('state, end_time, duration_seconds, elapsed_before_pause')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (data) {
        return {
          state: data.state as TimerState['state'],
          end_time: data.end_time,
          duration_seconds: data.duration_seconds,
          elapsed_before_pause: data.elapsed_before_pause,
        };
      }
      return DEFAULT_TIMER;
    },
    enabled: !!user,
  });

  // ── Exercises query ──
  const { data: exercises = [] } = useQuery({
    queryKey: queryKeys.exercises(user!.id),
    queryFn: async (): Promise<Exercise[]> => {
      const { data, error: err } = await coachbyte()
        .from('exercises')
        .select('exercise_id, name')
        .or(`user_id.is.null,user_id.eq.${user!.id}`)
        .order('name');
      if (err) throw err;
      return (data ?? []) as Exercise[];
    },
    enabled: !!user,
  });

  // ── Realtime invalidation ──
  useRealtimeInvalidation('coach-today', [
    { schema: 'coachbyte', table: 'planned_sets', queryKeys: [queryKeys.dailyPlan(user!.id, today)] },
    { schema: 'coachbyte', table: 'completed_sets', queryKeys: [queryKeys.dailyPlan(user!.id, today)] },
    { schema: 'coachbyte', table: 'timers', queryKeys: [queryKeys.timer(user!.id)] },
  ]);

  // Re-load on tab focus to catch midnight date changes
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [user, today, queryClient]);

  // ── Complete set mutation ──
  const completeSetMutation = useMutation({
    mutationFn: async ({ reps, load }: { reps: number; load: number }) => {
      const { data, error: err } = await coachbyte().rpc('complete_next_set', {
        p_plan_id: planId,
        p_reps: reps,
        p_load: load,
      });
      if (err) throw err;
      return data as { rest_seconds: number | null }[] | null;
    },
    onSuccess: async (data, { reps, load }) => {
      const result = data;
      const restSeconds = result?.[0]?.rest_seconds;
      if (restSeconds && restSeconds > 0) {
        await startTimer(restSeconds);
      }

      // PR check
      const nextSet = sets.find((s) => !s.completed);
      const completedExerciseId = nextSet?.exercise_id;
      const completedExerciseName = nextSet?.exercise_name;

      if (completedExerciseId && reps > 0 && load > 0) {
        const newE1RM = epley1RM(load, reps);

        const { data: prevSets } = await coachbyte()
          .from('completed_sets')
          .select('actual_reps, actual_load')
          .eq('exercise_id', completedExerciseId)
          .eq('user_id', user!.id);

        let prevBestWithout = 0;
        for (const ps of (prevSets ?? []) as { actual_reps: number; actual_load: string | number }[]) {
          const r = ps.actual_reps;
          const l = Number(ps.actual_load);
          if (r === reps && l === load) continue;
          const e = epley1RM(l, r);
          if (e > prevBestWithout) prevBestWithout = e;
        }

        if (newE1RM > prevBestWithout && prevBestWithout > 0) {
          setPrToast(`NEW PR! ${completedExerciseName} e1RM: ${newE1RM} ${WEIGHT_UNIT} (was ${prevBestWithout})`);
        } else if (newE1RM > 0 && prevBestWithout === 0) {
          setPrToast(`First record! ${completedExerciseName} e1RM: ${newE1RM} ${WEIGHT_UNIT}`);
        }
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
    },
    onError: (err: any) => {
      setError(err.message);
    },
  });

  const handleCompleteSet = async (reps: number, load: number) => {
    if (!planId || !user) return;
    completeSetMutation.mutate({ reps, load });
  };

  const updatePlannedSet = async (plannedSetId: string, field: string, value: number | null) => {
    isEditingRef.current = true;
    const { error: err } = await coachbyte()
      .from('planned_sets')
      .update({ [field]: value })
      .eq('planned_set_id', plannedSetId);
    isEditingRef.current = false;
    if (err) setError(err.message);
  };

  const deletePlannedSet = async (plannedSetId: string) => {
    const { error: err } = await coachbyte().from('planned_sets').delete().eq('planned_set_id', plannedSetId);
    if (err) {
      setError(err.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  const addPlannedSet = async (exerciseId: string, reps: number, load: number) => {
    if (!user || !planId) return;
    const maxOrder = Math.max(...sets.map((s) => s.order), 0);
    const { error: err } = await coachbyte()
      .from('planned_sets')
      .insert({
        plan_id: planId,
        user_id: user.id,
        exercise_id: exerciseId,
        target_reps: reps,
        target_load: load,
        rest_seconds: 90,
        order: maxOrder + 1,
      });
    if (err) {
      setError(err.message);
      return;
    }
    setAddingPlanned(false);
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  const startTimer = async (seconds: number) => {
    if (!user) return;
    const endTime = new Date(Date.now() + seconds * 1000).toISOString();
    const { error: err } = await coachbyte().from('timers').upsert(
      {
        user_id: user.id,
        state: 'running',
        end_time: endTime,
        duration_seconds: seconds,
        elapsed_before_pause: 0,
      },
      { onConflict: 'user_id' },
    );
    if (err) {
      setError(err.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const pauseTimer = async () => {
    if (!user || !timer.end_time) return;
    const elapsed = Math.floor(
      (Date.now() - (new Date(timer.end_time).getTime() - timer.duration_seconds * 1000)) / 1000,
    );
    const { error: err } = await coachbyte()
      .from('timers')
      .update({ state: 'paused', paused_at: new Date().toISOString(), elapsed_before_pause: Math.max(0, elapsed) })
      .eq('user_id', user.id);
    if (err) setError(err.message);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const resumeTimer = async () => {
    if (!user) return;
    const remaining = timer.duration_seconds - timer.elapsed_before_pause;
    const endTime = new Date(Date.now() + remaining * 1000).toISOString();
    const { error: err } = await coachbyte()
      .from('timers')
      .update({ state: 'running', end_time: endTime, paused_at: null })
      .eq('user_id', user.id);
    if (err) setError(err.message);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const resetTimer = async () => {
    if (!user) return;
    const { error: err } = await coachbyte().from('timers').delete().eq('user_id', user.id);
    if (err) setError(err.message);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const handleTimerExpired = useCallback(async () => {
    if (!user) return;
    const { error: err } = await coachbyte().from('timers').update({ state: 'expired' }).eq('user_id', user.id);
    if (err) setError(err instanceof Error ? err.message : 'Failed to mark timer expired');
  }, [user]);

  // Timer expired detection — runs when timer is running and hits 0
  /* eslint-disable react-hooks/set-state-in-effect -- timer expiry triggers server-side mutation + state update */
  useEffect(() => {
    if (timer.state !== 'running' || !timer.end_time) return;

    const remaining = Math.max(0, Math.ceil((new Date(timer.end_time).getTime() - Date.now()) / 1000));
    if (remaining <= 0) {
      handleTimerExpired();
      return;
    }

    const id = setTimeout(() => {
      handleTimerExpired();
    }, remaining * 1000);

    return () => clearTimeout(id);
  }, [timer.state, timer.end_time, handleTimerExpired]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleAdHocSubmit = async (exerciseId: string, reps: number, load: number) => {
    if (!user || !planId) return;
    setError(null);

    const { data: planInfo, error: fetchErr } = await coachbyte()
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }

    const { error: insertErr } = await coachbyte().from('completed_sets').insert({
      plan_id: planId,
      user_id: user.id,
      exercise_id: exerciseId,
      actual_reps: reps,
      actual_load: load,
      logical_date: planInfo?.logical_date,
    });
    if (insertErr) {
      setError(insertErr.message);
      return;
    }

    setShowAdHoc(false);
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  const saveSummary = useCallback(
    async (value: string) => {
      if (!planId) return;
      const { error: err } = await coachbyte().from('daily_plans').update({ summary: value }).eq('plan_id', planId);
      if (err) setError(err.message);
      else flashSummary();
    },
    [planId, flashSummary],
  );

  const handleSummaryChange = (value: string) => {
    setSummary(value);
    summaryRef.current = value;
    if (!planId) return;
    clearTimeout(summaryDebounceRef.current);
    summaryDebounceRef.current = setTimeout(() => saveSummary(value), 500);
  };

  const handleSummaryBlur = () => {
    clearTimeout(summaryDebounceRef.current);
    saveSummary(summaryRef.current);
  };

  const saveNotes = useCallback(
    async (value: string) => {
      if (!planId) return;
      const { error: err } = await coachbyte().from('daily_plans').update({ notes: value }).eq('plan_id', planId);
      if (err) setError(err.message);
      else flashNotes();
    },
    [planId, flashNotes],
  );

  const handleNotesChange = (value: string) => {
    setNotes(value);
    notesRef.current = value;
    if (!planId) return;
    clearTimeout(notesDebounceRef.current);
    notesDebounceRef.current = setTimeout(() => saveNotes(value), 500);
  };

  const handleNotesBlur = () => {
    clearTimeout(notesDebounceRef.current);
    saveNotes(notesRef.current);
  };

  const deleteCompletedSet = async (completedSetId: string) => {
    if (confirmDeleteId !== completedSetId) {
      setConfirmDeleteId(completedSetId);
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    clearTimeout(confirmTimeoutRef.current);
    setConfirmDeleteId(null);
    const { error: err } = await coachbyte().from('completed_sets').delete().eq('completed_set_id', completedSetId);
    if (err) {
      setError(err.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  const resetPlan = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    clearTimeout(resetTimeoutRef.current);
    setConfirmReset(false);
    if (!planId) return;
    const { error: err } = await coachbyte().from('daily_plans').delete().eq('plan_id', planId);
    if (err) {
      setError(err.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  const [timerRemaining, setTimerRemaining] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect -- timer countdown driven by external clock */
  useEffect(() => {
    if (timer.state === 'running' && timer.end_time) {
      const calc = () => Math.max(0, Math.ceil((new Date(timer.end_time!).getTime() - Date.now()) / 1000));
      setTimerRemaining(calc());
      const id = setInterval(() => setTimerRemaining(calc()), 1000);
      return () => clearInterval(id);
    } else if (timer.state === 'paused') {
      setTimerRemaining(timer.duration_seconds - timer.elapsed_before_pause);
    } else {
      setTimerRemaining(0);
    }
  }, [timer.state, timer.end_time, timer.duration_seconds, timer.elapsed_before_pause]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (planLoading) {
    return (
      <CoachLayout title="Today">
        <CardSkeleton />
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Today">
      <div className="flex justify-between items-center flex-wrap gap-2 border-b-2 border-border pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-text m-0">Today's Workout</h2>
        <div className="flex gap-2.5 items-center">
          <span className="text-text-secondary text-sm">{today}</span>
          <Button
            variant={confirmReset ? 'danger' : 'secondary'}
            size="sm"
            onClick={resetPlan}
            data-testid="reset-plan-btn"
          >
            {confirmReset ? 'Confirm Reset?' : 'Reset Plan'}
          </Button>
        </div>
      </div>

      {planError && (
        <Card className="border-danger mb-5" data-testid="load-error">
          <CardContent>
            <p className="text-danger-text text-sm mb-2">Failed to load data: {(planError as any).message}</p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) })}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-danger-text text-sm mb-3">{error}</p>}

      {prToast && (
        <Alert variant="success" onDismiss={() => setPrToast(null)} className="mb-4" data-testid="pr-toast">
          <span className="font-bold">{prToast}</span>
        </Alert>
      )}

      <SetQueue
        sets={sets}
        onComplete={handleCompleteSet}
        onAdHoc={() => setShowAdHoc(true)}
        onUpdateSet={updatePlannedSet}
        onDeleteSet={deletePlannedSet}
        onAddSet={() => setAddingPlanned(true)}
        timerState={timer.state}
        timerDisplay={
          timer.state === 'running' || timer.state === 'paused'
            ? formatTime(timerRemaining)
            : timer.state === 'expired'
              ? 'expired!'
              : undefined
        }
        disabled={false}
        onTimerStart={(secs) => startTimer(secs)}
        onTimerPause={pauseTimer}
        onTimerResume={resumeTimer}
        onTimerReset={resetTimer}
      />

      {showAdHoc && (
        <AdHocSetForm exercises={exercises} onSubmit={handleAdHocSubmit} onCancel={() => setShowAdHoc(false)} />
      )}

      {addingPlanned && (
        <AdHocSetForm exercises={exercises} onSubmit={addPlannedSet} onCancel={() => setAddingPlanned(false)} />
      )}

      {/* Completed Sets — collapsible */}
      <div className="border border-border rounded-xl bg-surface mb-5" data-testid="completed-section">
        <button
          type="button"
          onClick={() => setCompletedExpanded(!completedExpanded)}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer bg-transparent border-none text-left"
          data-testid="toggle-completed"
          aria-expanded={completedExpanded}
        >
          <h3 className="text-lg font-semibold text-text m-0">Completed ({completedSets.length})</h3>
          {completedExpanded ? (
            <ChevronUp className="w-5 h-5 text-text-tertiary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-tertiary" />
          )}
        </button>

        {completedExpanded && (
          <div className="px-4 pb-4">
            {completedSets.length === 0 ? (
              <p className="text-text-secondary italic text-center text-sm">No sets completed yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                        #
                      </th>
                      <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                        Exercise
                      </th>
                      <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                        Reps
                      </th>
                      <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                        Load
                      </th>
                      <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {completedSets.map((cs, i) => (
                      <tr
                        key={cs.completed_set_id}
                        data-testid={`completed-row-${i + 1}`}
                        className="border-b border-border-light last:border-b-0"
                      >
                        <td className="px-3 py-2 align-middle">{i + 1}</td>
                        <td className="px-3 py-2 align-middle">
                          <strong>{cs.exercise_name}</strong>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <strong>{cs.actual_reps}</strong>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <strong>
                            {formatWeightWithPlates(cs.actual_load)} {WEIGHT_UNIT}
                          </strong>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <Button
                            variant={confirmDeleteId === cs.completed_set_id ? 'danger' : 'secondary'}
                            size="sm"
                            onClick={() => deleteCompletedSet(cs.completed_set_id)}
                            data-testid={`delete-completed-${i + 1}`}
                          >
                            {confirmDeleteId === cs.completed_set_id ? 'Confirm?' : 'Remove'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Notes — collapsible */}
      <div className="border border-border rounded-xl bg-surface mb-5" data-testid="notes-section">
        <button
          type="button"
          onClick={() => setNotesExpanded(!notesExpanded)}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer bg-transparent border-none text-left"
          data-testid="toggle-notes"
          aria-expanded={notesExpanded}
        >
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-text m-0">Notes</h3>
            <SaveIndicator show={notesSaved} />
          </div>
          {notesExpanded ? (
            <ChevronUp className="w-5 h-5 text-text-tertiary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-tertiary" />
          )}
        </button>

        {notesExpanded && (
          <div className="px-4 pb-4">
            <textarea
              rows={4}
              value={notes}
              onChange={(e) => handleNotesChange(e.target.value)}
              onBlur={handleNotesBlur}
              placeholder="How did the workout feel? Any observations..."
              className="w-full px-3 py-2.5 text-sm border border-border-strong rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              data-testid="notes-textarea"
            />
          </div>
        )}
      </div>

      {/* Summary — collapsible */}
      <div className="border border-border rounded-xl bg-surface" data-testid="summary-section">
        <button
          type="button"
          onClick={() => setSummaryExpanded(!summaryExpanded)}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer bg-transparent border-none text-left"
          data-testid="toggle-summary"
          aria-expanded={summaryExpanded}
        >
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-text m-0">Summary</h3>
            <SaveIndicator show={summarySaved} />
          </div>
          {summaryExpanded ? (
            <ChevronUp className="w-5 h-5 text-text-tertiary" />
          ) : (
            <ChevronDown className="w-5 h-5 text-text-tertiary" />
          )}
        </button>

        {summaryExpanded && (
          <div className="px-4 pb-4">
            <textarea
              rows={3}
              value={summary}
              onChange={(e) => handleSummaryChange(e.target.value)}
              onBlur={handleSummaryBlur}
              placeholder="Add your workout summary here..."
              className="w-full px-3 py-2.5 text-sm border border-border-strong rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              data-testid="summary-textarea"
            />
          </div>
        )}
      </div>
    </CoachLayout>
  );
}
