import { useEffect, useState, useCallback, useRef } from 'react';
import {
  IonSpinner,
  IonGrid,
  IonRow,
  IonCol,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonTextarea,
  IonText,
  IonButton,
} from '@ionic/react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';
import { RestTimer } from '@/components/coachbyte/RestTimer';
import { AdHocSetForm, type Exercise } from '@/components/coachbyte/AdHocSetForm';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase, coachbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { WEIGHT_UNIT } from '@/shared/constants';
import { formatWeightWithPlates } from '@/shared/plateCalc';

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
  const summaryDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isEditingRef = useRef(false);

  const today = todayStr();

  const loadPlan = useCallback(async () => {
    if (!user) return;
    setLoadError(null);

    // Ensure daily plan exists
    const { data: planResult, error: planErr } = await coachbyte().rpc('ensure_daily_plan', { p_day: today });

    if (planErr) {
      setLoadError(planErr.message);
      setLoading(false);
      return;
    }

    const result = planResult as { plan_id: string; status: string };
    setPlanId(result.plan_id);

    // Load planned sets with exercise names
    const { data: plannedData } = await coachbyte()
      .from('planned_sets')
      .select(
        'planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, "order", exercises(name)',
      )
      .eq('plan_id', result.plan_id)
      .order('"order"');

    // Load completed sets
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

    // Load plan summary
    const { data: planData } = await coachbyte()
      .from('daily_plans')
      .select('summary')
      .eq('plan_id', result.plan_id)
      .single();

    setSummary(planData?.summary ?? '');
    setLoading(false);
  }, [user, today]);

  // Load exercises for ad-hoc form
  useEffect(() => {
    if (!user) return;
    coachbyte()
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order('name')
      .then(({ data }: { data: any }) => {
        setExercises((data ?? []) as Exercise[]);
      });
  }, [user]);

  // Load timer state
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

  // Initial load
  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPlan();
    loadTimer();
  }, [loadPlan, loadTimer]);

  // Realtime subscriptions
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
    if (!planId) return;

    const { data, error: err } = await coachbyte().rpc('complete_next_set', {
      p_plan_id: planId,
      p_reps: reps,
      p_load: load,
    });

    if (err) {
      setError(err.message);
      return;
    }

    // Auto-start timer with returned rest_seconds
    const result = data as { rest_seconds: number | null }[] | null;
    const restSeconds = result?.[0]?.rest_seconds;
    if (restSeconds && restSeconds > 0) {
      await startTimer(restSeconds);
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
    if (err) {
      setError(err.message);
      return;
    }
    // Realtime will handle the refresh after isEditing resets
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
    if (err) {
      setError(err.message);
      return;
    }
    await loadTimer();
  };

  const resumeTimer = async () => {
    if (!user) return;
    const remaining = timer.duration_seconds - timer.elapsed_before_pause;
    const endTime = new Date(Date.now() + remaining * 1000).toISOString();
    const { error: err } = await coachbyte()
      .from('timers')
      .update({ state: 'running', end_time: endTime, paused_at: null })
      .eq('user_id', user.id);
    if (err) {
      setError(err.message);
      return;
    }
    await loadTimer();
  };

  const resetTimer = async () => {
    if (!user) return;
    const { error: err } = await coachbyte().from('timers').delete().eq('user_id', user.id);
    if (err) {
      setError(err.message);
      return;
    }
    setTimer(DEFAULT_TIMER);
  };

  const handleTimerExpired = async () => {
    if (!user) return;
    const { error: err } = await coachbyte().from('timers').update({ state: 'expired' }).eq('user_id', user.id);
    if (err) setError(err.message);
  };

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
    if (!planId) return;
    clearTimeout(summaryDebounceRef.current);
    summaryDebounceRef.current = setTimeout(() => {
      saveSummary(value);
    }, 500);
  };

  const handleSummaryBlur = () => {
    clearTimeout(summaryDebounceRef.current);
    saveSummary(summary);
  };

  const deleteCompletedSet = async (completedSetId: string) => {
    if (confirmDeleteId !== completedSetId) {
      // First click — show confirm
      setConfirmDeleteId(completedSetId);
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    // Second click — delete
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
    // Confirmed — delete the plan (cascade deletes planned_sets)
    clearTimeout(resetTimeoutRef.current);
    setConfirmReset(false);
    if (!planId) return;
    const { error: err } = await coachbyte().from('daily_plans').delete().eq('plan_id', planId);
    if (err) {
      setError(err.message);
      return;
    }
    // Reload triggers ensure_daily_plan which recreates from split template
    await loadPlan();
  };

  if (loading) {
    return (
      <CoachLayout title="Today">
        <IonSpinner />
      </CoachLayout>
    );
  }

  return (
    <CoachLayout title="Today">
      <h2>
        TODAY'S WORKOUT <span style={{ float: 'right', fontWeight: 'normal', fontSize: '1rem' }}>{today}</span>
      </h2>

      {loadError && (
        <IonCard color="danger" data-testid="load-error">
          <IonCardContent>
            <p>Failed to load data: {loadError}</p>
            <IonButton onClick={loadPlan}>Retry</IonButton>
          </IonCardContent>
        </IonCard>
      )}

      {error && (
        <IonText color="danger">
          <p>{error}</p>
        </IonText>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <IonButton
          fill="outline"
          color={confirmReset ? 'danger' : 'medium'}
          size="small"
          onClick={resetPlan}
          data-testid="reset-plan-btn"
        >
          {confirmReset ? 'Confirm Reset?' : 'Reset Plan'}
        </IonButton>
      </div>

      <IonGrid>
        <IonRow>
          <IonCol size="12" sizeMd="7">
            <SetQueue
              sets={sets}
              onComplete={handleCompleteSet}
              onAdHoc={() => setShowAdHoc(true)}
              onUpdateSet={updatePlannedSet}
              onDeleteSet={deletePlannedSet}
              onAddSet={() => setAddingPlanned(true)}
              timerState={timer.state}
              disabled={false}
            />

            {showAdHoc && (
              <AdHocSetForm exercises={exercises} onSubmit={handleAdHocSubmit} onCancel={() => setShowAdHoc(false)} />
            )}

            {addingPlanned && (
              <AdHocSetForm exercises={exercises} onSubmit={addPlannedSet} onCancel={() => setAddingPlanned(false)} />
            )}
          </IonCol>

          <IonCol size="12" sizeMd="5">
            <RestTimer
              endTime={timer.end_time}
              state={timer.state}
              durationSeconds={timer.duration_seconds}
              elapsedBeforePause={timer.elapsed_before_pause}
              onStart={(secs) => startTimer(secs)}
              onPause={pauseTimer}
              onResume={resumeTimer}
              onReset={resetTimer}
              onExpired={handleTimerExpired}
            />

            <IonCard>
              <IonCardHeader>
                <IonCardTitle>COMPLETED SETS</IonCardTitle>
              </IonCardHeader>
              <IonCardContent>
                {completedSets.length === 0 ? (
                  <p>No sets completed yet.</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>#</th>
                        <th style={{ textAlign: 'left' }}>Exercise</th>
                        <th style={{ textAlign: 'left' }}>Reps</th>
                        <th style={{ textAlign: 'left' }}>Load</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {completedSets.map((cs, i) => (
                        <tr key={cs.completed_set_id} data-testid={`completed-row-${i + 1}`}>
                          <td>{i + 1}</td>
                          <td>{cs.exercise_name}</td>
                          <td>{cs.actual_reps}</td>
                          <td>
                            {formatWeightWithPlates(cs.actual_load)} {WEIGHT_UNIT}
                          </td>
                          <td>
                            <IonButton
                              fill="clear"
                              color={confirmDeleteId === cs.completed_set_id ? 'warning' : 'medium'}
                              size="small"
                              onClick={() => deleteCompletedSet(cs.completed_set_id)}
                              data-testid={`delete-completed-${i + 1}`}
                            >
                              {confirmDeleteId === cs.completed_set_id ? 'Confirm?' : 'Remove'}
                            </IonButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </IonCardContent>
            </IonCard>
          </IonCol>
        </IonRow>
      </IonGrid>

      <IonTextarea
        label="Summary"
        value={summary}
        onIonInput={(e) => handleSummaryChange(e.detail.value ?? '')}
        onIonBlur={handleSummaryBlur}
        data-testid="summary-textarea"
        rows={3}
      />
    </CoachLayout>
  );
}
