import { Fragment, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CoachLayout } from '@/components/coachbyte/CoachLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { WEIGHT_UNIT } from '@/shared/constants';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { formatDateDisplay } from '@/shared/dates';
import { queryKeys } from '@/shared/queryKeys';

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
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [allDays, setAllDays] = useState<HistoryDay[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [exerciseFilter, setExerciseFilter] = useState<string>('all');
  const [exercisePlanIds, setExercisePlanIds] = useState<Set<string> | null>(null);

  // ── Main history query (first page) ──
  const {
    data: firstPageData,
    isLoading: historyLoading,
    error: loadError,
  } = useQuery({
    queryKey: queryKeys.history(user!.id),
    queryFn: async () => {
      const query = supabase
        .schema('coachbyte')
        .from('daily_plans')
        .select('plan_id, plan_date, summary')
        .eq('user_id', user!.id)
        .order('plan_date', { ascending: false })
        .limit(PAGE_SIZE + 1);

      const { data: plans, error: plansErr } = await query;
      if (plansErr) throw plansErr;

      if (!plans || plans.length === 0) {
        return { days: [] as HistoryDay[], hasMore: false, cursor: null as string | null };
      }

      const hasNextPage = plans.length > PAGE_SIZE;
      const page = hasNextPage ? plans.slice(0, PAGE_SIZE) : plans;
      const planIds = page.map((p: any) => p.plan_id);

      const [{ data: plannedCounts }, { data: completedCounts }] = await Promise.all([
        supabase
          .schema('coachbyte')
          .from('planned_sets')
          .select('plan_id')
          .eq('user_id', user!.id)
          .in('plan_id', planIds),
        supabase
          .schema('coachbyte')
          .from('completed_sets')
          .select('plan_id')
          .eq('user_id', user!.id)
          .in('plan_id', planIds),
      ]);

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

      return {
        days: mapped,
        hasMore: hasNextPage,
        cursor: page[page.length - 1].plan_date as string,
      };
    },
    enabled: !!user,
  });

  // Sync first page data to allDays
  /* eslint-disable react-hooks/set-state-in-effect -- sync paginated server data → local accumulator */
  useEffect(() => {
    if (firstPageData) {
      setAllDays(firstPageData.days);
      setHasMore(firstPageData.hasMore);
      setCursor(firstPageData.cursor);
    }
  }, [firstPageData]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Total count query ──
  const { data: totalCount = null } = useQuery({
    queryKey: queryKeys.historyCount(user!.id),
    queryFn: async () => {
      const { count } = await supabase
        .schema('coachbyte')
        .from('daily_plans')
        .select('plan_id', { count: 'exact', head: true })
        .eq('user_id', user!.id);
      return count ?? null;
    },
    enabled: !!user,
  });

  // ── Exercises query ──
  const { data: exercises = [] } = useQuery({
    queryKey: queryKeys.exercises(user!.id),
    queryFn: async () => {
      const { data, error: err } = await supabase
        .schema('coachbyte')
        .from('exercises')
        .select('exercise_id, name')
        .or(`user_id.is.null,user_id.eq.${user!.id}`)
        .order('name');
      if (err) throw err;
      return (data ?? []) as { exercise_id: string; name: string }[];
    },
    enabled: !!user,
  });

  // ── Detail query (for expanded plan) ──
  const { data: detail = [], isLoading: detailLoading } = useQuery({
    queryKey: queryKeys.historyDetail(user!.id, expandedPlan ?? ''),
    queryFn: async (): Promise<HistoryDetail[]> => {
      const { data } = await supabase
        .schema('coachbyte')
        .from('completed_sets')
        .select('actual_reps, actual_load, completed_at, exercises(name)')
        .eq('plan_id', expandedPlan!)
        .eq('user_id', user!.id)
        .order('completed_at');

      return (data ?? []).map((cs: any) => ({
        exercise_name: cs.exercises?.name ?? 'Unknown',
        actual_reps: cs.actual_reps,
        actual_load: Number(cs.actual_load),
        completed_at: cs.completed_at,
      }));
    },
    enabled: !!user && !!expandedPlan,
  });

  const loadMore = async () => {
    if (!user || !cursor) return;

    const query = supabase
      .schema('coachbyte')
      .from('daily_plans')
      .select('plan_id, plan_date, summary')
      .eq('user_id', user.id)
      .order('plan_date', { ascending: false })
      .lt('plan_date', cursor)
      .limit(PAGE_SIZE + 1);

    const { data: plans, error: plansErr } = await query;
    if (plansErr) return;

    if (!plans || plans.length === 0) {
      setHasMore(false);
      return;
    }

    const hasNextPage = plans.length > PAGE_SIZE;
    const page = hasNextPage ? plans.slice(0, PAGE_SIZE) : plans;
    const planIds = page.map((p: any) => p.plan_id);

    const [{ data: plannedCounts }, { data: completedCounts }] = await Promise.all([
      supabase.schema('coachbyte').from('planned_sets').select('plan_id').eq('user_id', user.id).in('plan_id', planIds),
      supabase
        .schema('coachbyte')
        .from('completed_sets')
        .select('plan_id')
        .eq('user_id', user.id)
        .in('plan_id', planIds),
    ]);

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

    setAllDays((prev) => [...prev, ...mapped]);
    setCursor(page[page.length - 1].plan_date);
    setHasMore(hasNextPage);
  };

  const loadDetail = (planId: string) => {
    if (expandedPlan === planId) {
      setExpandedPlan(null);
      return;
    }
    setExpandedPlan(planId);
  };

  // Exercise filter effect
  /* eslint-disable react-hooks/set-state-in-effect -- async filter query → local state */
  useEffect(() => {
    if (!user || exerciseFilter === 'all') {
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
  /* eslint-enable react-hooks/set-state-in-effect */

  const filteredDays = allDays.filter((d) => {
    if (d.completed_count <= 0) return false;
    if (exercisePlanIds !== null) return exercisePlanIds.has(d.plan_id);
    return true;
  });

  return (
    <CoachLayout title="History">
      <div className="flex justify-between items-center flex-wrap gap-2 border-b-2 border-border pb-2.5 mb-5">
        <h2 className="text-2xl font-bold text-text m-0">Workout History</h2>
        <select
          value={exerciseFilter}
          onChange={(e) => setExerciseFilter(e.target.value)}
          className="appearance-none rounded-lg border border-border-strong px-3 py-1.5 text-sm text-text bg-surface focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
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
        <Card className="border-danger mb-5" data-testid="load-error">
          <div className="p-4">
            <p className="text-danger-text text-sm mb-2">Failed to load data: {(loadError as any).message}</p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.history(user!.id) })}
            >
              Retry
            </Button>
          </div>
        </Card>
      )}

      {historyLoading && allDays.length === 0 ? (
        <ListSkeleton count={5} data-testid="history-loading" />
      ) : filteredDays.length === 0 ? (
        <div
          className="text-center py-10 border-2 border-dashed border-border-strong rounded-xl bg-surface-sunken text-text-secondary"
          data-testid="no-history"
        >
          <h3 className="text-lg font-semibold mb-1">No workout history yet</h3>
          <p className="text-sm">Complete your first workout to see it here.</p>
        </div>
      ) : (
        <>
          {/* Pagination context */}
          <p className="text-text-secondary text-xs mb-2" data-testid="pagination-context">
            Showing 1&ndash;{filteredDays.length}
            {totalCount !== null ? ` of ${totalCount} workouts` : ' workouts'}
          </p>

          {/* Mobile card list */}
          <div className="sm:hidden flex flex-col gap-3 mb-5" data-testid="history-table">
            {filteredDays.map((day) => (
              <Fragment key={day.plan_id}>
                <Card data-testid={`history-row-${day.plan_date}`} className="overflow-hidden">
                  <div className="p-3.5">
                    <div className="flex justify-between items-start gap-2 mb-1.5">
                      <strong className="text-sm text-text">{formatDateDisplay(day.plan_date)}</strong>
                      <span className="text-xs text-text-secondary tabular-nums shrink-0">
                        {day.completed_count}/{day.planned_count} sets
                      </span>
                    </div>
                    {day.summary ? (
                      <p className="text-xs text-text-secondary mb-2.5 m-0 line-clamp-2">{day.summary}</p>
                    ) : (
                      <p className="text-xs text-text-tertiary italic mb-2.5 m-0">No summary</p>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => loadDetail(day.plan_id)}
                      data-testid={`expand-${day.plan_date}`}
                      className="w-full"
                      aria-label={
                        expandedPlan === day.plan_id
                          ? `Collapse ${day.plan_date} details`
                          : `Expand ${day.plan_date} details`
                      }
                    >
                      {expandedPlan === day.plan_id ? 'Hide Details' : 'View Details'}
                    </Button>
                  </div>

                  {expandedPlan === day.plan_id && (
                    <div
                      data-testid="detail-card"
                      className="border-t border-l-4 border-l-coach-accent border-t-border-light bg-surface-sunken/50 px-3.5 py-3"
                    >
                      <p className="text-xs font-bold text-text-secondary mb-2">Completed Sets</p>
                      {detailLoading ? (
                        <p className="text-text-secondary text-sm">Loading...</p>
                      ) : detail.length === 0 ? (
                        <p className="text-text-secondary text-sm">No sets completed.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {detail.map((d, i) => (
                            <div
                              key={i}
                              data-testid={`detail-row-${i + 1}`}
                              className="flex items-baseline justify-between gap-2 text-sm border-b border-border-light pb-1.5 last:border-0"
                            >
                              <div className="min-w-0">
                                <span className="text-text-tertiary text-xs mr-1.5">{i + 1}.</span>
                                <span className="font-medium">{d.exercise_name}</span>
                              </div>
                              <div className="text-xs text-text-secondary shrink-0 tabular-nums">
                                {d.actual_reps}r @ {d.actual_load} {WEIGHT_UNIT}
                                <span className="text-text-tertiary ml-1.5">
                                  {timeFormatter.format(new Date(d.completed_at))}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              </Fragment>
            ))}
          </div>

          {/* Desktop table */}
          <Card className="mb-5 overflow-hidden hidden sm:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="history-table-desktop">
                <thead>
                  <tr>
                    <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                      Date
                    </th>
                    <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                      Summary
                    </th>
                    <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                      Sets
                    </th>
                    <th className="bg-surface-sunken px-3 py-2 text-left border-b-2 border-border text-xs font-bold text-text-secondary">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDays.map((day) => (
                    <Fragment key={day.plan_id}>
                      <tr
                        data-testid={`history-row-${day.plan_date}`}
                        className="border-b border-border-light last:border-b-0"
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
                            <em className="text-text-secondary">No summary</em>
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
                            <div className="border-t border-l-4 border-l-coach-accent border-t-border-light bg-surface-sunken/50 px-4 py-3">
                              <p className="text-xs font-bold text-text-secondary mb-2">Completed Sets</p>
                              {detailLoading ? (
                                <p className="text-text-secondary text-sm">Loading...</p>
                              ) : detail.length === 0 ? (
                                <p className="text-text-secondary text-sm">No sets completed.</p>
                              ) : (
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-text-secondary">#</th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-text-secondary">
                                        Exercise
                                      </th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-text-secondary">
                                        Reps
                                      </th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-text-secondary">
                                        Load
                                      </th>
                                      <th className="px-2 py-1 text-left text-xs font-bold text-text-secondary">
                                        Time
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {detail.map((d, i) => (
                                      <tr
                                        key={i}
                                        data-testid={`detail-row-${i + 1}`}
                                        className="border-t border-border-light"
                                      >
                                        <td className="px-2 py-1 align-middle text-text-secondary">{i + 1}</td>
                                        <td className="px-2 py-1 align-middle font-medium">{d.exercise_name}</td>
                                        <td className="px-2 py-1 align-middle font-medium">{d.actual_reps}</td>
                                        <td className="px-2 py-1 align-middle font-medium">
                                          {d.actual_load} {WEIGHT_UNIT}
                                        </td>
                                        <td className="px-2 py-1 align-middle">
                                          <span className="text-text-secondary text-xs">
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
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {hasMore && (
            <Button variant="secondary" onClick={loadMore} data-testid="load-more-btn" className="w-full mt-4">
              Load More
            </Button>
          )}
        </>
      )}
    </CoachLayout>
  );
}
