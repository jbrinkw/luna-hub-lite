import { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';
import { formatTime } from '@/shared/formatTime';
import { AdHocSetForm, type Exercise } from '@/components/coachbyte/AdHocSetForm';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { supabase, coachbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { WEIGHT_UNIT } from '@/shared/constants';
import { epley1RM } from '@/pages/coachbyte/PrsPage';
import { formatWeightWithPlates } from '@/shared/plateCalc';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

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

export function TodayPage() {
  const { user } = useAuth();
  const { dayStartHour } = useAppContext();
  const [loading, setLoading] = useState(true);
  const [planId, setPlanId] = useState<string | null>(null);
  const [sets, setSets] = useState<PlannedSet[]>([]);
  const [completedSets, setCompletedSets] = useState<CompletedSet[]>([]);
  const [timer, setTimer] = useState<TimerState>(DEFAULT_TIMER);
  const [summary, setSummary] = useState('');
  const [showAdHoc, setShowAdHoc] = useState(false);
  const [addingPlanned, setAddingPlanned] = useState(false);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [notes, setNotes] = useState('');
  const [prToast, setPrToast] = useState<string | null>(null);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const summaryRef = useRef('');
  const notesRef = useRef('');
  const summaryDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const notesDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isEditingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (summaryDebounceRef.current) clearTimeout(summaryDebounceRef.current);
      if (notesDebounceRef.current) clearTimeout(notesDebounceRef.current);
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
    };
  }, []);

  const today = todayStr(dayStartHour);

  const loadPlan = useCallback(async () => {
    if (!user) return;
    setLoadError(null);

    const { data: planResult, error: planErr } = await coachbyte().rpc('ensure_daily_plan', { p_day: today });

    if (planErr) {
      setLoadError(planErr.message);
      setLoading(false);
      return;
    }

    const result = planResult as { plan_id: string; status: string };
    setPlanId(result.plan_id);

    const { data: plannedData } = await coachbyte()
      .from('planned_sets')
      .select(
        'planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, "order", exercises(name)',
      )
      .eq('plan_id', result.plan_id)
      .order('"order"');

    const { data: completedData } = await coachbyte()
      .from('completed_sets')
      .select('completed_set_id, planned_set_id, actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', result.plan_id)
      .order('completed_at');

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

    setSets(mapped);

    const completedMapped: CompletedSet[] = (completedData ?? []).map((cs: any) => ({
      completed_set_id: cs.completed_set_id,
      exercise_name: cs.exercises?.name ?? 'Unknown',
      actual_reps: cs.actual_reps,
      actual_load: Number(cs.actual_load),
      completed_at: cs.completed_at,
    }));

    setCompletedSets(completedMapped);

    const { data: planData } = await coachbyte()
      .from('daily_plans')
      .select('summary, notes')
      .eq('plan_id', result.plan_id)
      .single();

    const loadedSummary = planData?.summary ?? '';
    const loadedNotes = (planData as any)?.notes ?? '';
    setSummary(loadedSummary);
    summaryRef.current = loadedSummary;
    setNotes(loadedNotes);
    notesRef.current = loadedNotes;
    setLoading(false);
  }, [user, today]);

  useEffect(() => {
    if (!user) return;
    coachbyte()
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order('name')
      .then(({ data, error: err }: { data: any; error: any }) => {
        if (err) console.error('Failed to load exercises:', err.message);
        setExercises((data ?? []) as Exercise[]);
      });
  }, [user]);

  const loadTimer = useCallback(async () => {
    if (!user) return;
    const { data } = await coachbyte()
      .from('timers')
      .select('state, end_time, duration_seconds, elapsed_before_pause')
      .eq('user_id', user.id)
      .maybeSingle();

    if (data) {
      setTimer({
        state: data.state as TimerState['state'],
        end_time: data.end_time,
        duration_seconds: data.duration_seconds,
        elapsed_before_pause: data.elapsed_before_pause,
      });
    } else {
      setTimer(DEFAULT_TIMER);
    }
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPlan();
    loadTimer();
  }, [loadPlan, loadTimer]);

  // Re-load on tab focus to catch midnight date changes
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') loadPlan();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [loadPlan]);

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('coach-today')
      .on(
        'postgres_changes',
        { event: '*', schema: 'coachbyte', table: 'planned_sets', filter: `user_id=eq.${user.id}` },
        () => {
          if (!isEditingRef.current) loadPlan();
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'coachbyte', table: 'completed_sets', filter: `user_id=eq.${user.id}` },
        () => loadPlan(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'coachbyte', table: 'timers', filter: `user_id=eq.${user.id}` },
        () => loadTimer(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, loadPlan, loadTimer]);

  const handleCompleteSet = async (reps: number, load: number) => {
    if (!planId || !user) return;

    const nextSet = sets.find((s) => !s.completed);
    const completedExerciseId = nextSet?.exercise_id;
    const completedExerciseName = nextSet?.exercise_name;

    const { data, error: err } = await coachbyte().rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: reps,
      p_load: load,
    });

    if (err) {
      setError(err.message);
      return;
    }

    const result = data as { rest_seconds: number | null }[] | null;
    const restSeconds = result?.[0]?.rest_seconds;
    if (restSeconds && restSeconds > 0) {
      await startTimer(restSeconds);
    }

    if (completedExerciseId && reps > 0 && load > 0) {
      const newE1RM = epley1RM(load, reps);

      const { data: prevSets } = await coachbyte()
        .from('completed_sets')
        .select('actual_reps, actual_load')
        .eq('exercise_id', completedExerciseId)
        .eq('user_id', user.id);

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

    await loadPlan();
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
    await loadPlan();
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
    await loadPlan();
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
    await loadTimer();
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
    else await loadTimer();
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
    else await loadTimer();
  };

  const resetTimer = async () => {
    if (!user) return;
    const { error: err } = await coachbyte().from('timers').delete().eq('user_id', user.id);
    if (err) setError(err.message);
    else setTimer(DEFAULT_TIMER);
  };

  const handleTimerExpired = useCallback(async () => {
    if (!user) return;
    const { error: err } = await coachbyte().from('timers').update({ state: 'expired' }).eq('user_id', user.id);
    if (err) setError(err instanceof Error ? err.message : 'Failed to mark timer expired');
  }, [user]);

  // Timer expired detection — runs when timer is running and hits 0
  useEffect(() => {
    if (timer.state !== 'running' || !timer.end_time) return;

    const remaining = Math.max(0, Math.ceil((new Date(timer.end_time).getTime() - Date.now()) / 1000));
    if (remaining <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      handleTimerExpired();
      return;
    }

    const id = setTimeout(() => {
      handleTimerExpired();
    }, remaining * 1000);

    return () => clearTimeout(id);
  }, [timer.state, timer.end_time, handleTimerExpired]);

  const handleAdHocSubmit = async (exerciseId: string, reps: number, load: number) => {
    if (!user || !planId) return;
    setError(null);

    const { data: planData, error: fetchErr } = await coachbyte()
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
      logical_date: planData?.logical_date,
    });
    if (insertErr) {
      setError(insertErr.message);
      return;
    }

    setShowAdHoc(false);
    await loadPlan();
  };

  const saveSummary = useCallback(
    async (value: string) => {
      if (!planId) return;
      const { error: err } = await coachbyte().from('daily_plans').update({ summary: value }).eq('plan_id', planId);
      if (err) setError(err.message);
    },
    [planId],
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
    },
    [planId],
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
    await loadPlan();
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
    await loadPlan();
  };

  const [timerRemaining, setTimerRemaining] = useState(0);

  useEffect(() => {
    if (timer.state === 'running' && timer.end_time) {
      const calc = () => Math.max(0, Math.ceil((new Date(timer.end_time!).getTime() - Date.now()) / 1000));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTimerRemaining(calc());
      const id = setInterval(() => setTimerRemaining(calc()), 1000);
      return () => clearInterval(id);
    } else if (timer.state === 'paused') {
      setTimerRemaining(timer.duration_seconds - timer.elapsed_before_pause);
    } else {
      setTimerRemaining(0);
    }
  }, [timer.state, timer.end_time, timer.duration_seconds, timer.elapsed_before_pause]);

  if (loading) {
    return (
      <CoachLayout title="Today">
        <p className="text-slate-500 text-sm">Loading workout...</p>
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Today">
      <div className="flex justify-between items-center border-b-2 border-slate-200 pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-slate-900 m-0">Today's Workout</h2>
        <div className="flex gap-2.5 items-center">
          <span className="text-slate-500 text-sm">{today}</span>
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

      {loadError && (
        <Card className="border-red-300 mb-5" data-testid="load-error">
          <CardContent>
            <p className="text-red-600 text-sm mb-2">Failed to load data: {loadError}</p>
            <Button variant="primary" size="sm" onClick={loadPlan}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

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
      <div className="border border-slate-200 rounded-xl bg-white mb-5" data-testid="completed-section">
        <button
          type="button"
          onClick={() => setCompletedExpanded(!completedExpanded)}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer bg-transparent border-none text-left"
          data-testid="toggle-completed"
          aria-expanded={completedExpanded}
        >
          <h3 className="text-lg font-semibold text-slate-900 m-0">Completed ({completedSets.length})</h3>
          {completedExpanded ? (
            <ChevronUp className="w-5 h-5 text-slate-400" />
          ) : (
            <ChevronDown className="w-5 h-5 text-slate-400" />
          )}
        </button>

        {completedExpanded && (
          <div className="px-4 pb-4">
            {completedSets.length === 0 ? (
              <p className="text-slate-500 italic text-center text-sm">No sets completed yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                        #
                      </th>
                      <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                        Exercise
                      </th>
                      <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                        Reps
                      </th>
                      <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                        Load
                      </th>
                      <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {completedSets.map((cs, i) => (
                      <tr
                        key={cs.completed_set_id}
                        data-testid={`completed-row-${i + 1}`}
                        className="border-b border-slate-100 last:border-b-0"
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
      <div className="border border-slate-200 rounded-xl bg-white mb-5" data-testid="notes-section">
        <button
          type="button"
          onClick={() => setNotesExpanded(!notesExpanded)}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer bg-transparent border-none text-left"
          data-testid="toggle-notes"
          aria-expanded={notesExpanded}
        >
          <h3 className="text-lg font-semibold text-slate-900 m-0">Notes</h3>
          {notesExpanded ? (
            <ChevronUp className="w-5 h-5 text-slate-400" />
          ) : (
            <ChevronDown className="w-5 h-5 text-slate-400" />
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
              className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
              data-testid="notes-textarea"
            />
          </div>
        )}
      </div>

      {/* Summary — collapsible */}
      <div className="border border-slate-200 rounded-xl bg-white" data-testid="summary-section">
        <button
          type="button"
          onClick={() => setSummaryExpanded(!summaryExpanded)}
          className="w-full flex items-center justify-between px-4 py-3 cursor-pointer bg-transparent border-none text-left"
          data-testid="toggle-summary"
          aria-expanded={summaryExpanded}
        >
          <h3 className="text-lg font-semibold text-slate-900 m-0">Summary</h3>
          {summaryExpanded ? (
            <ChevronUp className="w-5 h-5 text-slate-400" />
          ) : (
            <ChevronDown className="w-5 h-5 text-slate-400" />
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
              className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
              data-testid="summary-textarea"
            />
          </div>
        )}
      </div>
    </CoachLayout>
  );
}
