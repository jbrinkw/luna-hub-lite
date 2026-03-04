import { useEffect, useState, useCallback } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonButton,
  IonSelect,
  IonSelectOption,
} from '@ionic/react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { WEIGHT_UNIT } from '@/shared/constants';
import { formatDateDisplay } from '@/shared/dates';

interface HistoryDay {
  plan_id: string;
  plan_date: string;
  summary: string | null;
  planned_count: number;
  completed_count: number;
}

interface HistoryDetail {
  exercise_name: string;
  actual_reps: number;
  actual_load: number;
  completed_at: string;
}

const PAGE_SIZE = 20;

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

export function HistoryPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [days, setDays] = useState<HistoryDay[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryDetail[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [exerciseFilter, setExerciseFilter] = useState<string>('all');
  const [exercisePlanIds, setExercisePlanIds] = useState<Set<string> | null>(null);
  const [exercises, setExercises] = useState<{ exercise_id: string; name: string }[]>([]);

  const loadHistory = useCallback(
    async (cursorDate?: string) => {
      if (!user) return;
      setLoadError(null);
      setLoading(true);

      let query = supabase
        .schema('coachbyte')
        .from('daily_plans')
        .select('plan_id, plan_date, summary')
        .eq('user_id', user.id)
        .order('plan_date', { ascending: false })
        .limit(PAGE_SIZE + 1);

      if (cursorDate) {
        query = query.lt('plan_date', cursorDate);
      }

      const { data: plans, error: plansErr } = await query;

      if (plansErr) {
        setLoadError(plansErr.message);
        setLoading(false);
        return;
      }

      if (!plans || plans.length === 0) {
        if (!cursorDate) setDays([]);
        setHasMore(false);
        setLoading(false);
        return;
      }

      const hasNextPage = plans.length > PAGE_SIZE;
      const page = hasNextPage ? plans.slice(0, PAGE_SIZE) : plans;
      const planIds = page.map((p: any) => p.plan_id);

      // Get planned/completed counts per plan
      const { data: plannedCounts } = await supabase
        .schema('coachbyte')
        .from('planned_sets')
        .select('plan_id')
        .eq('user_id', user.id)
        .in('plan_id', planIds);

      const { data: completedCounts } = await supabase
        .schema('coachbyte')
        .from('completed_sets')
        .select('plan_id')
        .eq('user_id', user.id)
        .in('plan_id', planIds);

      const planned = new Map<string, number>();
      const completed = new Map<string, number>();
      (plannedCounts ?? []).forEach((r: any) => planned.set(r.plan_id, (planned.get(r.plan_id) ?? 0) + 1));
      (completedCounts ?? []).forEach((r: any) => completed.set(r.plan_id, (completed.get(r.plan_id) ?? 0) + 1));

      const mapped: HistoryDay[] = page.map((p: any) => ({
        plan_id: p.plan_id,
        plan_date: p.plan_date,
        summary: p.summary,
        planned_count: planned.get(p.plan_id) ?? 0,
        completed_count: completed.get(p.plan_id) ?? 0,
      }));

      if (cursorDate) {
        setDays((prev) => [...prev, ...mapped]);
      } else {
        setDays(mapped);
      }

      setCursor(page[page.length - 1].plan_date);
      setHasMore(hasNextPage);
      setLoading(false);
    },
    [user],
  );

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!user) return;
    supabase
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id, name')
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order('name')
      .then(({ data }) => setExercises((data ?? []) as any));
  }, [user]);

  const loadDetail = async (planId: string) => {
    if (expandedPlan === planId) {
      setExpandedPlan(null);
      return;
    }
    setExpandedPlan(planId);
    setDetailLoading(true);

    const { data } = await supabase
      .schema('coachbyte')
      .from('completed_sets')
      .select('actual_reps, actual_load, completed_at, exercises(name)')
      .eq('plan_id', planId)
      .eq('user_id', user!.id)
      .order('completed_at');

    setDetail(
      (data ?? []).map((cs: any) => ({
        exercise_name: cs.exercises?.name ?? 'Unknown',
        actual_reps: cs.actual_reps,
        actual_load: Number(cs.actual_load),
        completed_at: cs.completed_at,
      })),
    );
    setDetailLoading(false);
  };

  // When exercise filter changes, fetch plan_ids that have completed sets for that exercise
  useEffect(() => {
    if (!user || exerciseFilter === 'all') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExercisePlanIds(null);
      return;
    }
    supabase
      .schema('coachbyte')
      .from('completed_sets')
      .select('plan_id')
      .eq('user_id', user.id)
      .eq('exercise_id', exerciseFilter)
      .then(({ data }) => {
        const ids = new Set((data ?? []).map((r: any) => r.plan_id as string));
        // Async data fetching with setState is the standard pattern for this use case

        setExercisePlanIds(ids);
      });
  }, [user, exerciseFilter]);

  // Filter out empty days (no completed sets) and apply exercise filter
  const filteredDays = days.filter((d) => {
    if (d.completed_count <= 0) return false;
    if (exercisePlanIds !== null) return exercisePlanIds.has(d.plan_id);
    return true;
  });

  return (
    <CoachLayout title="History">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>HISTORY</h2>
        <IonSelect
          value={exerciseFilter}
          onIonChange={(e) => setExerciseFilter(e.detail.value)}
          aria-label="Filter by exercise"
          interface="popover"
          data-testid="exercise-filter"
        >
          <IonSelectOption value="all">All Exercises</IonSelectOption>
          {exercises.map((ex) => (
            <IonSelectOption key={ex.exercise_id} value={ex.exercise_id}>
              {ex.name}
            </IonSelectOption>
          ))}
        </IonSelect>
      </div>

      {loadError && (
        <IonCard color="danger" data-testid="load-error">
          <IonCardContent>
            <p>Failed to load data: {loadError}</p>
            <IonButton onClick={() => loadHistory()}>Retry</IonButton>
          </IonCardContent>
        </IonCard>
      )}

      {loading && days.length === 0 ? (
        <IonSpinner data-testid="history-loading" />
      ) : filteredDays.length === 0 ? (
        <p data-testid="no-history">No workout history yet.</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="history-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Date</th>
                <th style={{ textAlign: 'left' }}>Summary</th>
                <th style={{ textAlign: 'left' }}>Sets</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredDays.map((day) => (
                <tr key={day.plan_id} data-testid={`history-row-${day.plan_date}`}>
                  <td>{formatDateDisplay(day.plan_date)}</td>
                  <td>{day.summary ?? '—'}</td>
                  <td>
                    {day.completed_count}/{day.planned_count}
                  </td>
                  <td>
                    <IonButton
                      size="small"
                      fill="clear"
                      onClick={() => loadDetail(day.plan_id)}
                      data-testid={`expand-${day.plan_date}`}
                      aria-label={
                        expandedPlan === day.plan_id
                          ? `Collapse ${day.plan_date} details`
                          : `Expand ${day.plan_date} details`
                      }
                    >
                      {expandedPlan === day.plan_id ? '▼' : '▶'}
                    </IonButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {expandedPlan && (
            <IonCard data-testid="detail-card">
              <IonCardHeader>
                <IonCardTitle>Completed Sets</IonCardTitle>
              </IonCardHeader>
              <IonCardContent>
                {detailLoading ? (
                  <IonSpinner />
                ) : detail.length === 0 ? (
                  <p>No sets completed.</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>#</th>
                        <th style={{ textAlign: 'left' }}>Exercise</th>
                        <th style={{ textAlign: 'left' }}>Reps</th>
                        <th style={{ textAlign: 'left' }}>Load</th>
                        <th style={{ textAlign: 'left' }}>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.map((d, i) => (
                        <tr key={i} data-testid={`detail-row-${i + 1}`}>
                          <td>{i + 1}</td>
                          <td>{d.exercise_name}</td>
                          <td>{d.actual_reps}</td>
                          <td>
                            {d.actual_load} {WEIGHT_UNIT}
                          </td>
                          <td>{timeFormatter.format(new Date(d.completed_at))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </IonCardContent>
            </IonCard>
          )}

          {hasMore && (
            <IonButton
              expand="block"
              fill="outline"
              onClick={() => cursor && loadHistory(cursor)}
              data-testid="load-more-btn"
            >
              Load More
            </IonButton>
          )}
        </>
      )}
    </CoachLayout>
  );
}
