import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { SetQueue, type PlannedSet, type LastTimeStat } from '@/components/coachbyte/SetQueue';
import { formatTime } from '@/shared/formatTime';
import { AdHocSetForm, type Exercise } from '@/components/coachbyte/AdHocSetForm';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { supabase, coachbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { WEIGHT_UNIT } from '@/shared/constants';
import { epley1RM } from '@/shared/epley';
import { formatWeightWithPlates } from '@/shared/plateCalc';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import { useSaveIndicator } from '@/hooks/useSaveIndicator';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import {
  fireTimerExpiredCue,
  firePrCelebrationCue,
  installAudioUnlockOnFirstGesture,
  requestNotificationPermission,
  unlockAudioContextNow,
  useScreenWakeLock,
  vibrateSetCompleted,
} from '@/hooks/useTimerAudio';

// Weekday names for the split-breadcrumb hint (FLAG F7). Order matches
// JS Date.getDay() (0 = Sunday … 6 = Saturday).
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Warm-up heuristic for the first-record toast (CoachByte FLAG F6).
 *
 * Suppresses the "First record!" toast on probable warm-up sets so a
 * 12×45lb opening doesn't fire a meaningless first-record cue. Real
 * working-set first-records (135×5 squat, 95×5 bench, etc.) sit
 * outside the envelope (`load >= 100` in WEIGHT_UNIT, OR `reps <= 8`).
 *
 * Defensive false negatives: only suppress the warm-up toast — once
 * the lifter does a real working set, e1RM rolls forward and the
 * genuine PR fires.
 */
export function isLikelyWarmupSet(reps: number, load: number): boolean {
  return load < 100 && reps > 8;
}

export interface CompletedSet {
  completed_set_id: string;
  /**
   * The planned_set this completion reopens when deleted. A2-10 audit: the
   * optimistic reopen previously matched by exercise_name, which flips the
   * WRONG planned row when two sets share an exercise. Carrying the id lets
   * us reopen the exact slot. May be null for legacy rows with no link.
   */
  planned_set_id: string | null;
  exercise_name: string;
  actual_reps: number;
  actual_load: number;
  completed_at: string;
}

export interface TimerState {
  state: 'running' | 'paused' | 'expired' | 'idle';
  end_time: string | null;
  duration_seconds: number;
  elapsed_before_pause: number;
}

export const DEFAULT_TIMER: TimerState = {
  state: 'idle',
  end_time: null,
  duration_seconds: 0,
  elapsed_before_pause: 0,
};

export interface DailyPlanData {
  planId: string;
  sets: PlannedSet[];
  completedSets: CompletedSet[];
  summary: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// Exported data loaders — TodayPage's queryFn bodies hoisted to top-level
// so integration tests can exercise them directly. See the 2026-04-22
// legacy audit issue #3 ("query-replica drift") for motivation.
// ---------------------------------------------------------------------------

function asCoachbyte(client?: SupabaseClient<any>) {
  return ((client ?? supabase) as any).schema('coachbyte');
}

/** Load + assemble the TodayPage daily-plan data blob.
 *
 * Wraps:
 *   - ``ensure_daily_plan(p_day)`` RPC (creates the row if missing)
 *   - ``planned_sets`` select + exercises join
 *   - ``completed_sets`` select + exercises join
 *   - ``daily_plans`` summary/notes select
 *
 * Then folds planned+completed into a joined ``sets: PlannedSet[]`` where
 * each set carries ``completed: boolean`` computed from the completed-set
 * planned_set_id set.
 */
export async function loadDailyPlanData(day: string, client?: SupabaseClient<any>): Promise<DailyPlanData> {
  const coach = asCoachbyte(client);
  const { data: planResult, error: planErr } = await coach.rpc('ensure_daily_plan', { p_day: day });
  if (planErr) throw planErr;
  const result = planResult as { plan_id: string; status: string };

  const [{ data: plannedData }, { data: completedData }, { data: planInfo }] = await Promise.all([
    coach
      .from('planned_sets')
      .select(
        'planned_set_id, exercise_id, target_reps, target_load, target_load_percentage, rest_seconds, "order", exercises(name)',
      )
      .eq('plan_id', result.plan_id)
      .order('"order"'),
    coach
      .from('completed_sets')
      .select('completed_set_id, planned_set_id, actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', result.plan_id)
      .order('completed_at'),
    coach.from('daily_plans').select('summary, notes').eq('plan_id', result.plan_id).single(),
  ]);

  const completedPlanIds = new Set((completedData ?? []).map((cs: any) => cs.planned_set_id).filter(Boolean));

  const sets: PlannedSet[] = (plannedData ?? []).map((ps: any) => ({
    planned_set_id: ps.planned_set_id,
    exercise_id: ps.exercise_id,
    exercise_name: ps.exercises?.name ?? 'Unknown',
    target_reps: ps.target_reps,
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: target_load is a DB NUMERIC column; truthy-guard above excludes null/0
    target_load: ps.target_load ? Number(ps.target_load) : null,
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: target_load_percentage is a DB NUMERIC column; truthy-guard above excludes null/0
    target_load_percentage: ps.target_load_percentage ? Number(ps.target_load_percentage) : null,
    rest_seconds: ps.rest_seconds,
    order: ps.order,
    completed: completedPlanIds.has(ps.planned_set_id),
  }));

  const completedSets: CompletedSet[] = (completedData ?? []).map((cs: any) => ({
    completed_set_id: cs.completed_set_id,
    planned_set_id: cs.planned_set_id ?? null,
    exercise_name: cs.exercises?.name ?? 'Unknown',
    actual_reps: cs.actual_reps,
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: actual_load is a DB NUMERIC column from Supabase; always a valid numeric string
    actual_load: Number(cs.actual_load),
    completed_at: cs.completed_at,
  }));

  return {
    planId: result.plan_id,
    sets,
    completedSets,
    summary: planInfo?.summary ?? '',
    notes: (planInfo as any)?.notes ?? '',
  };
}

/** Load the current timer state for a user. Returns DEFAULT_TIMER when
 * no row exists (the UI treats "no row" as "idle"). */
export async function loadTimerState(userId: string, client?: SupabaseClient<any>): Promise<TimerState> {
  const { data } = await asCoachbyte(client)
    .from('timers')
    .select('state, end_time, duration_seconds, elapsed_before_pause')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) return { ...DEFAULT_TIMER };
  return {
    state: data.state as TimerState['state'],
    end_time: data.end_time,
    duration_seconds: data.duration_seconds,
    elapsed_before_pause: data.elapsed_before_pause,
  };
}

/** Load the most recent completed-set for one exercise (single row,
 * newest first). Used to surface "last time you did this" on the Today
 * next-in-queue card.
 *
 * Returns null when:
 *   - no completed_sets row matches (first time doing this exercise)
 *   - no exercise_id passed (next set has no exercise yet — shouldn't
 *     happen, but defensive)
 */
export async function loadLastTimeForExercise(
  userId: string,
  exerciseId: string | null | undefined,
  client?: SupabaseClient<any>,
): Promise<LastTimeStat | null> {
  if (!exerciseId) return null;
  const { data } = await asCoachbyte(client)
    .from('completed_sets')
    .select('actual_reps, actual_load, completed_at')
    .eq('user_id', userId)
    .eq('exercise_id', exerciseId)
    .order('completed_at', { ascending: false })
    .limit(1);

  const row = (data as { actual_reps: number; actual_load: string | number; completed_at: string }[] | null)?.[0];
  if (!row) return null;
  const completedAt = new Date(row.completed_at).getTime();
  const daysAgo = Math.max(0, Math.floor((Date.now() - completedAt) / 86_400_000));
  return {
    reps: row.actual_reps,
    load: Number(row.actual_load),
    daysAgo,
  };
}

/** Load global + user-owned exercises for the AdHocSetForm. */
export async function loadExercisesForToday(userId: string, client?: SupabaseClient<any>): Promise<Exercise[]> {
  const { data, error } = await asCoachbyte(client)
    .from('exercises')
    .select('exercise_id, name')
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .order('name');
  if (error) throw error;
  return (data ?? []) as Exercise[];
}

// ---------------------------------------------------------------------------
// Timer state-machine dispatchers — hoisted to top-level so unit tests
// can exercise them directly with a mock Supabase client. Every write
// goes through the coachbyte.*_timer RPCs introduced in migration
// 20260425040000_timer_state_machine_rpcs.sql; the RPCs are the single
// source of truth for (from_state, event) → to_state guards and for
// computing derived columns (elapsed_before_pause, end_time).
//
// Each dispatcher returns `{ error: string | null }` so the caller can
// flip a local UI error slot when the RPC guard rejects.
// ---------------------------------------------------------------------------

export type TimerDispatchResult = { error: string | null };

/** Start or replace the caller's timer — running state, fresh end_time.
 *
 * RPC guard: duration_seconds must be positive. */
export async function startTimerRpc(
  durationSeconds: number,
  client?: SupabaseClient<any>,
): Promise<TimerDispatchResult> {
  const { error } = await asCoachbyte(client).rpc('start_timer', {
    p_duration_seconds: durationSeconds,
  });
  return { error: error ? error.message : null };
}

/** Pause a running timer (elapsed_before_pause computed server-side).
 *
 * RPC guard: state must be 'running'. */
export async function pauseTimerRpc(client?: SupabaseClient<any>): Promise<TimerDispatchResult> {
  const { error } = await asCoachbyte(client).rpc('pause_timer');
  return { error: error ? error.message : null };
}

/** Resume a paused timer (fresh end_time computed from remaining seconds).
 *
 * RPC guards: state must be 'paused'; remaining must be > 0. */
export async function resumeTimerRpc(client?: SupabaseClient<any>): Promise<TimerDispatchResult> {
  const { error } = await asCoachbyte(client).rpc('resume_timer');
  return { error: error ? error.message : null };
}

/** Delete the caller's timer (any state → (no row); soft-noop when empty). */
export async function resetTimerRpc(client?: SupabaseClient<any>): Promise<TimerDispatchResult> {
  const { error } = await asCoachbyte(client).rpc('reset_timer');
  return { error: error ? error.message : null };
}

/** Flip state=expired once wall-clock end has passed. Guard rejections
 * ('cannot expire timer in state ...') are swallowed here — they happen
 * when the timer raced with pause/reset, and the UI picks up the new
 * state via the timers-table realtime subscription. */
export async function expireTimerRpc(client?: SupabaseClient<any>): Promise<TimerDispatchResult> {
  const { error } = await asCoachbyte(client).rpc('expire_timer');
  if (error && !error.message.includes('cannot expire')) {
    return { error: error.message };
  }
  return { error: null };
}

/** Extend a running/paused timer by N seconds. The migration doesn't
 * have a dedicated RPC for this, but `start_timer` replaces the row
 * with a fresh end_time, so we can compute (remaining + extra) and
 * call start_timer with the new total.
 *
 * Caller must pass the current `timer` so we can compute remaining
 * accurately (avoids extra DB roundtrip + race with realtime updates).
 */
export async function extendTimerRpc(
  timer: TimerState,
  extraSeconds: number,
  client?: SupabaseClient<any>,
): Promise<TimerDispatchResult> {
  let remaining = 0;
  if (timer.state === 'running' && timer.end_time) {
    remaining = Math.max(0, Math.ceil((new Date(timer.end_time).getTime() - Date.now()) / 1000));
  } else if (timer.state === 'paused') {
    remaining = Math.max(0, timer.duration_seconds - timer.elapsed_before_pause);
  } else {
    // No active timer to extend — caller should have hidden the button
    return { error: null };
  }
  const newDuration = remaining + extraSeconds;
  return startTimerRpc(newDuration, client);
}

export function TodayPage() {
  const { user } = useAuth();
  const { dayStartHour, timezone } = useAppContext();
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
  // Undo toast — shown for 5s after a successful Complete-Set so the
  // user can revert without expanding the Completed section.
  const [undoSetId, setUndoSetId] = useState<string | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  // Track running→expired transition so we fire the audio/vibration/
  // notification cue exactly once per timer expiry (not every render).
  const lastTimerStateRef = useRef<string | null>(null);
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
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    };
  }, []);

  // Request notification permission once on mount so the rest-timer
  // expiry can later fire a system notification without a perm-prompt
  // mid-rest. Silently no-ops on unsupported browsers / denied state.
  // Also install a one-time `pointerdown` listener that resumes the
  // shared AudioContext — Chrome/Safari leave it suspended until a
  // user gesture, so without this the first beep silently no-ops.
  useEffect(() => {
    void requestNotificationPermission();
    installAudioUnlockOnFirstGesture();
  }, []);

  const today = todayStr(dayStartHour, timezone);

  // ── Daily Plan query ──
  const {
    data: planData,
    isLoading: planLoading,
    error: planError,
  } = useQuery({
    queryKey: queryKeys.dailyPlan(user!.id, today),
    queryFn: () => loadDailyPlanData(today),
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
  const nextSet = sets.find((s) => !s.completed);

  // ── Timer query ──
  const { data: timer = DEFAULT_TIMER } = useQuery({
    queryKey: queryKeys.timer(user!.id),
    queryFn: () => loadTimerState(user!.id),
    enabled: !!user,
  });

  // ── Last-time-you-did-this query ──
  // Single most useful number to show a lifter mid-workout. Re-fetches
  // when nextSet changes (i.e. one set is logged → next prefills).
  const { data: lastTimeStat = null } = useQuery({
    queryKey: ['last-time', user!.id, nextSet?.exercise_id ?? null],
    queryFn: () => loadLastTimeForExercise(user!.id, nextSet?.exercise_id),
    enabled: !!user && !!nextSet?.exercise_id,
    staleTime: 30_000,
  });

  // Keep the screen awake ONLY during an active rest period. Acquiring
  // the lock for the entire workout drains battery + prevents the
  // screen from dimming while the user reads notes between sets;
  // binding it to `running | paused` releases the lock the moment the
  // timer expires (so the screen can dim while the user lifts) and
  // re-acquires on the next rest start. The wake-lock hook handles
  // visibilitychange re-acquisition itself.
  const restActive = timer.state === 'running' || timer.state === 'paused';
  useScreenWakeLock(restActive);

  // ── Exercises query ──
  const { data: exercises = [] } = useQuery({
    queryKey: queryKeys.exercises(user!.id),
    queryFn: () => loadExercisesForToday(user!.id),
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
  // OPTIMISTIC UPDATE PATH:
  //   onMutate: flip the next pending set's `completed` flag in-cache
  //     and append a synthetic completed_sets row so the UI advances
  //     to the NEXT next-set immediately. Stash the rollback snapshot.
  //   onSuccess: replace the synthetic row with the real one (using
  //     completed_set_id from the RPC response), kick the rest timer,
  //     run PR detection, and show the 5s undo toast.
  //   onError:   rollback to the snapshot.
  const completeSetMutation = useMutation({
    mutationFn: async ({ reps, load }: { reps: number; load: number }) => {
      const { data, error: err } = await coachbyte().rpc('complete_next_set', {
        p_plan_id: planId,
        p_actual_reps: reps,
        p_actual_load: load,
      });
      if (err) throw err;
      // The RPC returns: [{ completed_set_id, planned_set_id, rest_seconds, ... }]
      return data as
        | {
            rest_seconds: number | null;
            completed_set_id?: string;
            planned_set_id?: string;
          }[]
        | null;
    },
    onMutate: async ({ reps, load }) => {
      // Snapshot the previous cache so onError can restore it.
      const queryKey = queryKeys.dailyPlan(user!.id, today);
      await queryClient.cancelQueries({ queryKey });
      const prev = queryClient.getQueryData<DailyPlanData>(queryKey);
      if (!prev) return { prev };

      const targetSet = prev.sets.find((s) => !s.completed);
      if (!targetSet) return { prev };

      const optimisticSet: CompletedSet = {
        completed_set_id: `optimistic-${targetSet.planned_set_id}`,
        planned_set_id: targetSet.planned_set_id,
        exercise_name: targetSet.exercise_name,
        actual_reps: reps,
        actual_load: load,
        completed_at: new Date().toISOString(),
      };

      queryClient.setQueryData<DailyPlanData>(queryKey, {
        ...prev,
        sets: prev.sets.map((s) => (s.planned_set_id === targetSet.planned_set_id ? { ...s, completed: true } : s)),
        completedSets: [...prev.completedSets, optimisticSet],
      });

      return { prev, targetSet };
    },
    onSuccess: async (data, { reps, load }, ctx) => {
      const result = data;
      const restSeconds = result?.[0]?.rest_seconds;
      const completedSetId = result?.[0]?.completed_set_id;
      if (restSeconds && restSeconds > 0) {
        await startTimer(restSeconds);
      }

      // PR check — ``ctx.targetSet`` is the planned-set we just logged
      // (captured during onMutate before the optimistic update fired).
      const completedExerciseId = ctx?.targetSet?.exercise_id;
      const completedExerciseName = ctx?.targetSet?.exercise_name;

      if (completedExerciseId && reps > 0 && load > 0) {
        const newE1RM = epley1RM(load, reps);

        // Pull the just-logged completed_set_id back along with the
        // history rows so we can exclude it by ID instead of
        // reps×load equality (the old code mistakenly excluded any
        // previous set that happened to match the same reps×load).
        const { data: prevSets } = await coachbyte()
          .from('completed_sets')
          .select('completed_set_id, actual_reps, actual_load')
          .eq('exercise_id', completedExerciseId)
          .eq('user_id', user!.id);

        let prevBestWithout = 0;
        for (const ps of (prevSets ?? []) as {
          completed_set_id: string;
          actual_reps: number;
          actual_load: string | number;
        }[]) {
          // Exclude only THIS set — by id, not by value-equality.
          if (completedSetId && ps.completed_set_id === completedSetId) continue;
          const r = ps.actual_reps;
          // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: actual_load is a DB NUMERIC column from Supabase; always a valid numeric string
          const l = Number(ps.actual_load);
          const e = epley1RM(l, r);
          if (e > prevBestWithout) prevBestWithout = e;
        }

        if (newE1RM > prevBestWithout && prevBestWithout > 0) {
          setPrToast(`NEW PR! ${completedExerciseName} e1RM: ${newE1RM} ${WEIGHT_UNIT} (was ${prevBestWithout})`);
          // Audible + haptic celebration on the actual PR moment.
          // Distinct from the rest-expiry cue (rising arpeggio + 3
          // short pulses) so the two never feel like the same signal.
          firePrCelebrationCue();
        } else if (newE1RM > 0 && prevBestWithout === 0) {
          // CoachByte FLAG F6 — suppress "first record" toast for
          // probable warm-ups. See isLikelyWarmupSet() for envelope.
          if (!isLikelyWarmupSet(reps, load)) {
            setPrToast(`First record! ${completedExerciseName} e1RM: ${newE1RM} ${WEIGHT_UNIT}`);
            firePrCelebrationCue();
          }
        }
      }

      // Show "Undo" toast for 5s. Tapping it deletes the just-logged
      // completed_set row.
      if (completedSetId) {
        setUndoSetId(completedSetId);
        clearTimeout(undoTimeoutRef.current);
        undoTimeoutRef.current = setTimeout(() => setUndoSetId(null), 5000);
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
    },
    onError: (err: any, _vars, ctx) => {
      // Rollback the optimistic mutation
      if (ctx?.prev) {
        queryClient.setQueryData(queryKeys.dailyPlan(user!.id, today), ctx.prev);
      }
      setError(err.message);
    },
  });

  const handleCompleteSet = async (reps: number, load: number) => {
    if (!planId || !user) return;
    // Force-resume the AudioContext from this known-good user gesture
    // so the eventual rest-expiry beep isn't blocked by Chrome/Safari's
    // suspended-until-gesture rule. Idempotent.
    unlockAudioContextNow();
    // Single short haptic — confirmation that the tap was received.
    // Distinct pattern from rest-expiry vibrate so the two never feel
    // like the same signal.
    vibrateSetCompleted();
    completeSetMutation.mutate({ reps, load });
  };

  // Failed-set path (CoachByte FLAG F1). Submits via the same RPC with
  // actual_reps=0; PR detection in onSuccess skips the entry (the
  // `reps > 0 && load > 0` guard) so no false "first record" toast.
  const handleFailedSet = async (load: number) => {
    if (!planId || !user) return;
    unlockAudioContextNow();
    vibrateSetCompleted();
    completeSetMutation.mutate({ reps: 0, load });
  };

  // Undo a just-completed set. Looks up by completed_set_id captured
  // from the RPC response.
  const undoLastSet = async () => {
    if (!undoSetId || !user) return;
    const idToUndo = undoSetId;
    setUndoSetId(null);
    clearTimeout(undoTimeoutRef.current);
    const { error: err } = await coachbyte().from('completed_sets').delete().eq('completed_set_id', idToUndo);
    if (err) {
      setError(err.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  // ── Mutation helpers — optimistic update + rollback on error ──
  // Pattern: snapshot, write to cache immediately, rollback in catch.
  // All four planned/completed-set CRUD paths use this so the UI never
  // sits on a round-trip beat. Server error → silent rollback + error
  // banner; success → final invalidate to re-sync from canonical state.

  const optimisticUpdatePlanCache = (mutator: (prev: DailyPlanData) => DailyPlanData): DailyPlanData | null => {
    const queryKey = queryKeys.dailyPlan(user!.id, today);
    const prev = queryClient.getQueryData<DailyPlanData>(queryKey);
    if (!prev) return null;
    queryClient.setQueryData<DailyPlanData>(queryKey, mutator(prev));
    return prev;
  };

  const rollbackPlanCache = (snapshot: DailyPlanData | null) => {
    if (snapshot) {
      queryClient.setQueryData(queryKeys.dailyPlan(user!.id, today), snapshot);
    }
  };

  const updatePlannedSet = async (plannedSetId: string, field: string, value: number | null) => {
    isEditingRef.current = true;
    const snapshot = optimisticUpdatePlanCache((prev) => ({
      ...prev,
      sets: prev.sets.map((s) => (s.planned_set_id === plannedSetId ? { ...s, [field]: value } : s)),
    }));
    const { error: err } = await coachbyte()
      .from('planned_sets')
      .update({ [field]: value })
      .eq('planned_set_id', plannedSetId);
    isEditingRef.current = false;
    if (err) {
      rollbackPlanCache(snapshot);
      setError(err.message);
    }
  };

  const deletePlannedSet = async (plannedSetId: string) => {
    const snapshot = optimisticUpdatePlanCache((prev) => ({
      ...prev,
      sets: prev.sets.filter((s) => s.planned_set_id !== plannedSetId),
    }));
    const { error: err } = await coachbyte().from('planned_sets').delete().eq('planned_set_id', plannedSetId);
    if (err) {
      rollbackPlanCache(snapshot);
      setError(err.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  const addPlannedSet = async (exerciseId: string, reps: number, load: number) => {
    if (!user || !planId) return;
    const maxOrder = Math.max(...sets.map((s) => s.order), 0);
    const exerciseName = exercises.find((e) => e.exercise_id === exerciseId)?.name ?? 'Unknown';
    // Synthetic id flagged with 'optimistic-' so the realtime
    // invalidate replaces it with the canonical row on the next read.
    const tempId = `optimistic-${Date.now()}`;
    const snapshot = optimisticUpdatePlanCache((prev) => ({
      ...prev,
      sets: [
        ...prev.sets,
        {
          planned_set_id: tempId,
          exercise_id: exerciseId,
          exercise_name: exerciseName,
          target_reps: reps,
          target_load: load,
          target_load_percentage: null,
          rest_seconds: 90,
          order: maxOrder + 1,
          completed: false,
        },
      ],
    }));
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
      rollbackPlanCache(snapshot);
      setError(err.message);
      return;
    }
    setAddingPlanned(false);
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyPlan(user!.id, today) });
  };

  // Timer mutations. Every transition dispatches to the DB state-machine
  // RPC via the exported dispatcher helpers (startTimerRpc,
  // pauseTimerRpc, etc.). The RPC layer is the single source of truth
  // for the `(state, event) → state` transitions and for the fields
  // each transition writes (end_time, paused_at, elapsed_before_pause).
  const startTimer = async (seconds: number) => {
    if (!user) return;
    const { error: err } = await startTimerRpc(seconds);
    if (err) {
      setError(err);
      return;
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const pauseTimer = async () => {
    if (!user || !timer.end_time) return;
    const { error: err } = await pauseTimerRpc();
    if (err) setError(err);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const resumeTimer = async () => {
    if (!user) return;
    const { error: err } = await resumeTimerRpc();
    if (err) setError(err);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const resetTimer = async () => {
    if (!user) return;
    const { error: err } = await resetTimerRpc();
    if (err) setError(err);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  const handleTimerExpired = useCallback(async () => {
    if (!user) return;
    const { error: err } = await expireTimerRpc();
    if (err) setError(err);
  }, [user]);

  // Extend a running/paused timer by N seconds (non-destructive).
  const extendTimer = async (extra: number) => {
    if (!user) return;
    const { error: err } = await extendTimerRpc(timer, extra);
    if (err) setError(err);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  // Skip rest = "I'm ready, drop the timer". Distinct from Reset
  // semantically — same DB effect (delete row) but the user-facing
  // affordance is "I'm ready to lift" instead of "wipe and start over".
  const skipTimer = async () => {
    if (!user) return;
    const { error: err } = await resetTimerRpc();
    if (err) setError(err);
    else queryClient.invalidateQueries({ queryKey: queryKeys.timer(user.id) });
  };

  // Timer expired detection — runs when timer is running and hits 0.
  // Also fires the audio + vibration + system-notification cue exactly
  // once on the running→expired transition.
  /* eslint-disable react-hooks/set-state-in-effect -- timer expiry triggers server-side mutation + state update */
  useEffect(() => {
    // Edge-trigger the cue only when transitioning INTO expired
    if (timer.state === 'expired' && lastTimerStateRef.current !== 'expired') {
      fireTimerExpiredCue();
    }
    lastTimerStateRef.current = timer.state;

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
    // Find the matching planned-set so we can flip it back to
    // pending in the optimistic update (deleting a completed_set
    // re-opens the planned slot).
    const removed = (planData?.completedSets ?? []).find((cs) => cs.completed_set_id === completedSetId);
    const snapshot = optimisticUpdatePlanCache((prev) => {
      const remainingCompleted = prev.completedSets.filter((cs) => cs.completed_set_id !== completedSetId);
      // Reopen the EXACT planned slot this completion filled. A2-10 audit:
      // matching by exercise_name flipped the wrong row when two sets share
      // an exercise. Prefer the planned_set_id link; fall back to the
      // exercise_name heuristic only for legacy rows with no link.
      const reopen = removed
        ? removed.planned_set_id
          ? prev.sets.findIndex((s) => s.completed && s.planned_set_id === removed.planned_set_id)
          : prev.sets.findIndex((s) => s.completed && s.exercise_name === removed.exercise_name)
        : -1;
      const sets = reopen >= 0 ? prev.sets.map((s, i) => (i === reopen ? { ...s, completed: false } : s)) : prev.sets;
      return { ...prev, sets, completedSets: remainingCompleted };
    });
    const { error: err } = await coachbyte().from('completed_sets').delete().eq('completed_set_id', completedSetId);
    if (err) {
      rollbackPlanCache(snapshot);
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
        <div>
          <h2 className="text-2xl font-bold text-text m-0">Today's Workout</h2>
          <span className="text-text-secondary text-xs">
            {today}
            {/* CoachByte FLAG F7 — split breadcrumb. Persisted column
                doesn't exist; we infer the source weekday from the
                logical_date the plan was bootstrapped on. Bootstrap
                always uses (logical_date getDay() in user's tz), and
                the typical plan is created same-day, so the weekday
                of `today` is a near-perfect heuristic. Stale across
                explicit Reset Plan + DST edges; cheaper than a
                migration. */}
            <span className="ml-2 text-text-tertiary" data-testid="split-breadcrumb">
              · from {WEEKDAYS_LONG[new Date(`${today}T00:00:00`).getDay()]} split
            </span>
          </span>
        </div>
        <Button
          variant={confirmReset ? 'danger' : 'ghost'}
          size="sm"
          onClick={resetPlan}
          data-testid="reset-plan-btn"
          aria-label="Reset today's plan"
        >
          {confirmReset ? 'Confirm Reset?' : 'Reset Plan'}
        </Button>
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

      {/* Toast region — `aria-live="polite"` lets screen readers
          announce PR + Undo without interrupting active speech. The
          inner Alert sets role="alert" (assertive); wrapping in a
          live region container ensures the text is queued for
          announcement even if the alert role fails to trigger on
          some readers. */}
      <div aria-live="polite" aria-atomic="true" data-testid="toast-live-region">
        {prToast && (
          <Alert variant="success" onDismiss={() => setPrToast(null)} className="mb-4" data-testid="pr-toast">
            <span className="font-bold">{prToast}</span>
          </Alert>
        )}

        {undoSetId && (
          <Alert
            variant="info"
            onDismiss={() => {
              setUndoSetId(null);
              clearTimeout(undoTimeoutRef.current);
            }}
            className="mb-4"
            data-testid="undo-toast"
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span>Set logged.</span>
              <Button variant="primary" size="sm" onClick={undoLastSet} data-testid="undo-set-btn">
                Undo
              </Button>
            </div>
          </Alert>
        )}
      </div>

      <SetQueue
        sets={sets}
        onComplete={handleCompleteSet}
        onFailed={handleFailedSet}
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
        completing={completeSetMutation.isPending}
        lastTimeStat={lastTimeStat}
        onTimerStart={(secs) => startTimer(secs)}
        onTimerPause={pauseTimer}
        onTimerResume={resumeTimer}
        onTimerReset={resetTimer}
        onTimerExtend={extendTimer}
        onTimerSkip={skipTimer}
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
