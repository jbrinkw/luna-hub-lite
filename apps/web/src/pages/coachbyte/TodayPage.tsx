import { useEffect, useState, useCallback } from 'react';
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
} from '@ionic/react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { SetQueue, type PlannedSet } from '@/components/coachbyte/SetQueue';
import { RestTimer } from '@/components/coachbyte/RestTimer';
import { AdHocSetForm, type Exercise } from '@/components/coachbyte/AdHocSetForm';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';

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
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [error, setError] = useState<string | null>(null);

  const today = todayStr();

  const loadPlan = useCallback(async () => {
    if (!user) return;
    setError(null);

    // Ensure daily plan exists (cast needed: supabase-js typing doesn't fully support cross-schema rpc)
    const coachbyte = supabase.schema('coachbyte') as any;
    const { data: planResult, error: planErr } = await coachbyte.rpc('ensure_daily_plan', { p_day: today });

    if (planErr) {
      setError(planErr.message);
      setLoading(false);
      return;
    }

    const result = planResult as { plan_id: string; status: string };
    setPlanId(result.plan_id);

    // Load planned sets with exercise names
    const { data: plannedData } = await supabase
      .schema('coachbyte')
      .from('planned_sets')
      .select(
        'planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, "order", exercises(name)',
      )
      .eq('plan_id', result.plan_id)
      .order('"order"');

    // Load completed sets
    const { data: completedData } = await supabase
      .schema('coachbyte')
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
    const { data: planData } = await supabase
      .schema('coachbyte')
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
    supabase
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order('name')
      .then(({ data }) => {
        setExercises((data ?? []) as Exercise[]);
      });
  }, [user]);

  // Load timer state
  const loadTimer = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .schema('coachbyte')
      .from('timers')
      .select('state, end_time, duration_seconds, elapsed_before_pause')
      .eq('user_id', user.id)
      .single();

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
        () => loadPlan(),
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

    const coachbyte = supabase.schema('coachbyte') as any;
    const { data, error: err } = await coachbyte.rpc('complete_next_set', {
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

  const startTimer = async (seconds: number) => {
    if (!user) return;
    const endTime = new Date(Date.now() + seconds * 1000).toISOString();
    await supabase.schema('coachbyte').from('timers').upsert(
      {
        user_id: user.id,
        state: 'running',
        end_time: endTime,
        duration_seconds: seconds,
        elapsed_before_pause: 0,
      },
      { onConflict: 'user_id' },
    );
    await loadTimer();
  };

  const pauseTimer = async () => {
    if (!user || !timer.end_time) return;
    const elapsed = Math.floor(
      (Date.now() - (new Date(timer.end_time).getTime() - timer.duration_seconds * 1000)) / 1000,
    );
    await supabase
      .schema('coachbyte')
      .from('timers')
      .update({ state: 'paused', paused_at: new Date().toISOString(), elapsed_before_pause: Math.max(0, elapsed) })
      .eq('user_id', user.id);
    await loadTimer();
  };

  const resumeTimer = async () => {
    if (!user) return;
    const remaining = timer.duration_seconds - timer.elapsed_before_pause;
    const endTime = new Date(Date.now() + remaining * 1000).toISOString();
    await supabase
      .schema('coachbyte')
      .from('timers')
      .update({ state: 'running', end_time: endTime, paused_at: null })
      .eq('user_id', user.id);
    await loadTimer();
  };

  const resetTimer = async () => {
    if (!user) return;
    await supabase.schema('coachbyte').from('timers').delete().eq('user_id', user.id);
    setTimer(DEFAULT_TIMER);
  };

  const handleAdHocSubmit = async (exerciseId: string, reps: number, load: number) => {
    if (!user || !planId) return;

    const planData = await supabase
      .schema('coachbyte')
      .from('daily_plans')
      .select('logical_date')
      .eq('plan_id', planId)
      .single();

    await supabase.schema('coachbyte').from('completed_sets').insert({
      plan_id: planId,
      user_id: user.id,
      exercise_id: exerciseId,
      actual_reps: reps,
      actual_load: load,
      logical_date: planData.data?.logical_date,
    });

    setShowAdHoc(false);
    await loadPlan();
  };

  const handleSummaryChange = async (value: string) => {
    setSummary(value);
    if (!planId) return;
    await supabase.schema('coachbyte').from('daily_plans').update({ summary: value }).eq('plan_id', planId);
  };

  const timerDisplay =
    timer.state === 'running' && timer.end_time
      ? undefined // SetQueue doesn't use this directly, RestTimer handles display
      : timer.state === 'expired'
        ? 'Timer expired'
        : undefined;

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

      {error && (
        <IonText color="danger">
          <p>{error}</p>
        </IonText>
      )}

      <IonGrid>
        <IonRow>
          <IonCol size="12" sizeMd="7">
            <SetQueue
              sets={sets}
              onComplete={handleCompleteSet}
              onAdHoc={() => setShowAdHoc(true)}
              timerDisplay={timerDisplay}
              timerState={timer.state}
              disabled={false}
            />

            {showAdHoc && (
              <AdHocSetForm exercises={exercises} onSubmit={handleAdHocSubmit} onCancel={() => setShowAdHoc(false)} />
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
                      </tr>
                    </thead>
                    <tbody>
                      {completedSets.map((cs, i) => (
                        <tr key={cs.completed_set_id} data-testid={`completed-row-${i + 1}`}>
                          <td>{i + 1}</td>
                          <td>{cs.exercise_name}</td>
                          <td>{cs.actual_reps}</td>
                          <td>{cs.actual_load} lb</td>
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
        data-testid="summary-textarea"
        rows={3}
      />
    </CoachLayout>
  );
}
