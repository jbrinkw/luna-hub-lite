import { useEffect, useState, useCallback } from 'react';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { WEIGHT_UNIT } from '@/shared/constants';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
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
  const [totalCount, setTotalCount] = useState<number | null>(null);
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

  // Load total count for "Showing X-Y of Z" display
  useEffect(() => {
    if (!user) return;
    supabase
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .then(({ count }) => {
        setTotalCount(count ?? null);
      });
  }, [user]);

  useEffect(() => {
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
      .then(({ data, error: err }) => {
        if (err) console.error('Failed to load exercises:', err.message);
        setExercises((data ?? []) as any);
      });
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
      .then(({ data, error: err }) => {
        if (err) console.error('Failed to filter by exercise:', err.message);
        const ids = new Set((data ?? []).map((r: any) => r.plan_id as string));
        setExercisePlanIds(ids);
      });
  }, [user, exerciseFilter]);

  const filteredDays = days.filter((d) => {
    if (d.completed_count <= 0) return false;
    if (exercisePlanIds !== null) return exercisePlanIds.has(d.plan_id);
    return true;
  });

  return (
    <CoachLayout title="History">
      <div className="flex justify-between items-center border-b-2 border-slate-200 pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-slate-900 m-0">Workout History</h2>
        <select
          value={exerciseFilter}
          onChange={(e) => setExerciseFilter(e.target.value)}
          className="appearance-none rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
          data-testid="exercise-filter"
        >
          <option value="all">All Exercises</option>
          {exercises.map((ex) => (
            <option key={ex.exercise_id} value={ex.exercise_id}>
              {ex.name}
            </option>
          ))}
        </select>
      </div>

      {loadError && (
        <Card className="border-red-300 mb-5" data-testid="load-error">
          <div className="p-4">
            <p className="text-red-600 text-sm mb-2">Failed to load data: {loadError}</p>
            <Button variant="primary" size="sm" onClick={() => loadHistory()}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {loading && days.length === 0 ? (
        <p className="text-slate-500 text-sm" data-testid="history-loading">
          Loading workout history...
        </p>
      ) : filteredDays.length === 0 ? (
        <div
          className="text-center py-10 border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 text-slate-500"
          data-testid="no-history"
        >
          <h3 className="text-lg font-semibold mb-1">No workout history yet</h3>
          <p className="text-sm">Complete your first workout to see it here.</p>
        </div>
      ) : (
        <>
          {/* Pagination context */}
          <p className="text-slate-500 text-xs mb-2" data-testid="pagination-context">
            Showing 1&ndash;{filteredDays.length}
            {totalCount !== null ? ` of ${totalCount} workouts` : ' workouts'}
          </p>

          <Card className="mb-5 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="history-table">
                <thead>
                  <tr>
                    <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                      Date
                    </th>
                    <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                      Summary
                    </th>
                    <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                      Sets
                    </th>
                    <th className="bg-slate-50 px-3 py-2 text-left border-b-2 border-slate-200 text-xs font-bold text-slate-700">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDays.map((day) => (
                    <>
                      <tr
                        key={day.plan_id}
                        data-testid={`history-row-${day.plan_date}`}
                        className="border-b border-slate-100 last:border-b-0"
                      >
                        <td className="px-3 py-2 align-middle">
                          <strong>{formatDateDisplay(day.plan_date)}</strong>
                        </td>
                        <td className="px-3 py-2 align-middle">
                          {day.summary ? (
                            <div
                              className="max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap"
                              title={day.summary}
                            >
                              {day.summary}
                            </div>
                          ) : (
                            <em className="text-slate-500">No summary</em>
                          )}
                        </td>
                        <td className="px-3 py-2 align-middle">
                          {day.completed_count}/{day.planned_count}
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => loadDetail(day.plan_id)}
                            data-testid={`expand-${day.plan_date}`}
                            aria-label={
                              expandedPlan === day.plan_id
                                ? `Collapse ${day.plan_date} details`
                                : `Expand ${day.plan_date} details`
                            }
                          >
                            {expandedPlan === day.plan_id ? 'Hide' : 'View Details'}
                          </Button>
                        </td>
                      </tr>

                      {/* Inline detail expansion row */}
                      {expandedPlan === day.plan_id && (
                        <tr key={`${day.plan_id}-detail`} data-testid="detail-card">
                          <td colSpan={4} className="px-0 py-0">
                            <div className="border-t border-l-4 border-l-violet-300 border-t-slate-100 bg-slate-50/50 px-4 py-3">
                              <p className="text-xs font-bold text-slate-600 mb-2">Completed Sets</p>
                              {detailLoading ? (
                                <p className="text-slate-500 text-sm">Loading...</p>
                              ) : detail.length === 0 ? (
                                <p className="text-slate-500 text-sm">No sets completed.</p>
                              ) : (
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-slate-500">#</th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-slate-500">Exercise</th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-slate-500">Reps</th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-slate-500">Load</th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-slate-500">Time</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {detail.map((d, i) => (
                                      <tr
                                        key={i}
                                        data-testid={`detail-row-${i + 1}`}
                                        className="border-t border-slate-100"
                                      >
                                        <td className="px-2 py-1 align-middle text-slate-500">{i + 1}</td>
                                        <td className="px-2 py-1 align-middle font-medium">{d.exercise_name}</td>
                                        <td className="px-2 py-1 align-middle font-medium">{d.actual_reps}</td>
                                        <td className="px-2 py-1 align-middle font-medium">
                                          {d.actual_load} {WEIGHT_UNIT}
                                        </td>
                                        <td className="px-2 py-1 align-middle">
                                          <span className="text-slate-500 text-xs">
                                            {timeFormatter.format(new Date(d.completed_at))}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {hasMore && (
            <Button
              variant="secondary"
              onClick={() => cursor && loadHistory(cursor)}
              data-testid="load-more-btn"
              className="w-full mt-4"
            >
              Load More
            </Button>
          )}
        </>
      )}
    </CoachLayout>
  );
}
