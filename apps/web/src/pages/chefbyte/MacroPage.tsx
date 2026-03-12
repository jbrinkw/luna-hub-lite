import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { MacroProgressBar } from '@/components/shared/MacroProgressBar';
import { MacroBarSkeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { toDateStr, formatDateDisplay } from '@/shared/dates';
import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { computeRecipeMacros } from './RecipesPage';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MacroTotals {
  consumed: { calories: number; protein: number; carbs: number; fat: number };
  goals: { calories: number; protein: number; carbs: number; fat: number };
}

interface ConsumedItem {
  id: string;
  source: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface PlannedItem {
  meal_id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface MacroPageData {
  macros: MacroTotals | null;
  consumed: ConsumedItem[];
  planned: PlannedItem[];
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for testing)                                 */
/* ------------------------------------------------------------------ */

export function calcCaloriesFromMacros(protein: number, carbs: number, fat: number): number {
  return protein * 4 + carbs * 4 + fat * 9;
}

/* ================================================================== */
/*  MacroPage                                                          */
/* ================================================================== */

export function MacroPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentDate, setCurrentDate] = useState(() => toDateStr(new Date()));

  /* ---- Temp Item modal ---- */
  const [showTempModal, setShowTempModal] = useState(false);
  const [tempName, setTempName] = useState('');
  const [tempCalories, setTempCalories] = useState(0);
  const [tempProtein, setTempProtein] = useState(0);
  const [tempCarbs, setTempCarbs] = useState(0);
  const [tempFat, setTempFat] = useState(0);

  /* ---- Target Macros modal ---- */
  const [showTargetModal, setShowTargetModal] = useState(false);
  const [targetProtein, setTargetProtein] = useState(0);
  const [targetCarbs, setTargetCarbs] = useState(0);
  const [targetFat, setTargetFat] = useState(0);

  /* ---- Taste Profile modal ---- */
  const [showTasteModal, setShowTasteModal] = useState(false);
  const [tasteProfile, setTasteProfile] = useState('');

  const [mutationError, setMutationError] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading via useQuery                                        */
  /* ---------------------------------------------------------------- */

  const userId = user?.id;

  const {
    data,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey: [...queryKeys.dailyMacros(userId!, currentDate), 'full'],
    queryFn: async (): Promise<MacroPageData> => {
      // Fire all independent queries in parallel
      const [macroRes, foodLogsRes, tempItemsRes, ltEventsRes, plannedRes] = await Promise.all([
        (chefbyte() as any).rpc('get_daily_macros', { p_logical_date: currentDate }),
        chefbyte()
          .from('food_logs')
          .select('log_id, product_id, calories, protein, carbs, fat, products:product_id(name)')
          .eq('user_id', userId!)
          .eq('logical_date', currentDate)
          .order('created_at'),
        chefbyte()
          .from('temp_items')
          .select('temp_id, name, calories, protein, carbs, fat')
          .eq('user_id', userId!)
          .eq('logical_date', currentDate)
          .order('created_at'),
        chefbyte()
          .from('liquidtrack_events')
          .select('event_id, calories, protein, carbs, fat')
          .eq('user_id', userId!)
          .eq('logical_date', currentDate)
          .order('created_at'),
        chefbyte()
          .from('meal_plan_entries')
          .select(
            'meal_id, servings, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving)',
          )
          .eq('user_id', userId!)
          .eq('logical_date', currentDate)
          .eq('meal_prep', false)
          .is('completed_at', null),
      ]);

      if (macroRes.error) throw new Error(macroRes.error.message);

      // Process macros
      let macros: MacroTotals | null = null;
      if (macroRes.data) {
        const rpc = macroRes.data as Record<string, { consumed: number; goal: number; remaining: number }>;
        macros = {
          consumed: {
            calories: Number(rpc.calories?.consumed) || 0,
            protein: Number(rpc.protein?.consumed) || 0,
            carbs: Number(rpc.carbs?.consumed) || 0,
            fat: Number(rpc.fat?.consumed) || 0,
          },
          goals: {
            calories: Number(rpc.calories?.goal) || 0,
            protein: Number(rpc.protein?.goal) || 0,
            carbs: Number(rpc.carbs?.goal) || 0,
            fat: Number(rpc.fat?.goal) || 0,
          },
        };
      }

      // Process consumed items from 3 sources
      const items: ConsumedItem[] = [];

      for (const log of (foodLogsRes.data ?? []) as any[]) {
        items.push({
          id: log.log_id,
          source: 'Meal Plan',
          name: log.products?.name ?? 'Unknown',
          calories: Number(log.calories) || 0,
          protein: Number(log.protein) || 0,
          carbs: Number(log.carbs) || 0,
          fat: Number(log.fat) || 0,
        });
      }

      for (const ti of (tempItemsRes.data ?? []) as any[]) {
        items.push({
          id: ti.temp_id,
          source: 'Temp Item',
          name: ti.name,
          calories: Number(ti.calories) || 0,
          protein: Number(ti.protein) || 0,
          carbs: Number(ti.carbs) || 0,
          fat: Number(ti.fat) || 0,
        });
      }

      for (const ev of (ltEventsRes.data ?? []) as any[]) {
        items.push({
          id: ev.event_id,
          source: 'LiquidTrack',
          name: 'Liquid intake',
          calories: Number(ev.calories) || 0,
          protein: Number(ev.protein) || 0,
          carbs: Number(ev.carbs) || 0,
          fat: Number(ev.fat) || 0,
        });
      }

      // Process planned items
      const plannedItems: PlannedItem[] = [];
      for (const entry of (plannedRes.data ?? []) as any[]) {
        const servings = Number(entry.servings) || 1;
        if (entry.recipes) {
          const recipeMacros = computeRecipeMacros(
            entry.recipes.recipe_ingredients ?? [],
            Number(entry.recipes.base_servings) || 1,
          );
          plannedItems.push({
            meal_id: entry.meal_id,
            name: entry.recipes.name ?? 'Unknown',
            calories: Math.round(recipeMacros.calories * servings),
            protein: Math.round(recipeMacros.protein * servings),
            carbs: Math.round(recipeMacros.carbs * servings),
            fat: Math.round(recipeMacros.fat * servings),
          });
        } else if (entry.products) {
          plannedItems.push({
            meal_id: entry.meal_id,
            name: entry.products.name ?? 'Unknown',
            calories: Math.round((Number(entry.products.calories_per_serving) || 0) * servings),
            protein: Math.round((Number(entry.products.protein_per_serving) || 0) * servings),
            carbs: Math.round((Number(entry.products.carbs_per_serving) || 0) * servings),
            fat: Math.round((Number(entry.products.fat_per_serving) || 0) * servings),
          });
        }
      }

      return { macros, consumed: items, planned: plannedItems };
    },
    enabled: !!userId,
  });

  /* ---------------------------------------------------------------- */
  /*  Realtime invalidation                                            */
  /* ---------------------------------------------------------------- */

  useRealtimeInvalidation('chef-macros', [
    {
      schema: 'chefbyte',
      table: 'food_logs',
      queryKeys: [queryKeys.dailyMacros(userId!, currentDate)],
    },
    {
      schema: 'chefbyte',
      table: 'temp_items',
      queryKeys: [queryKeys.dailyMacros(userId!, currentDate)],
    },
  ]);

  /* ---------------------------------------------------------------- */
  /*  Date navigation                                                  */
  /* ---------------------------------------------------------------- */

  const prevDate = () => {
    setCurrentDate((prev) => {
      const d = new Date(prev + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      return toDateStr(d);
    });
  };

  const nextDate = () => {
    setCurrentDate((prev) => {
      const d = new Date(prev + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      return toDateStr(d);
    });
  };

  const goToday = () => {
    setCurrentDate(toDateStr(new Date()));
  };

  /* ---------------------------------------------------------------- */
  /*  Mutations                                                        */
  /* ---------------------------------------------------------------- */

  const invalidateMacros = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyMacros(userId!, currentDate) });
  };

  const deleteMutation = useMutation({
    mutationFn: async (item: ConsumedItem) => {
      if (item.source === 'LiquidTrack') return;

      let error;
      if (item.source === 'Meal Plan') {
        ({ error } = await chefbyte().from('food_logs').delete().eq('log_id', item.id));
      } else if (item.source === 'Temp Item') {
        ({ error } = await chefbyte().from('temp_items').delete().eq('temp_id', item.id));
      }

      if (error) throw new Error(error.message);
    },
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.dailyMacros(userId!, currentDate) });
      const previous = queryClient.getQueryData<MacroPageData>([
        ...queryKeys.dailyMacros(userId!, currentDate),
        'full',
      ]);
      if (previous) {
        queryClient.setQueryData<MacroPageData>([...queryKeys.dailyMacros(userId!, currentDate), 'full'], {
          ...previous,
          consumed: previous.consumed.filter((c) => c.id !== item.id),
        });
      }
      return { previous };
    },
    onError: (err: Error, _item, context) => {
      if (context?.previous) {
        queryClient.setQueryData([...queryKeys.dailyMacros(userId!, currentDate), 'full'], context.previous);
      }
      setMutationError(err.message);
    },
    onSettled: () => invalidateMacros(),
  });

  const addTempMutation = useMutation({
    mutationFn: async () => {
      if (!user || !tempName.trim()) return;
      const { error: err } = await chefbyte().from('temp_items').insert({
        user_id: user.id,
        name: tempName.trim(),
        calories: tempCalories,
        protein: tempProtein,
        carbs: tempCarbs,
        fat: tempFat,
        logical_date: currentDate,
      });
      if (err) throw new Error(err.message);
    },
    onSuccess: () => {
      setShowTempModal(false);
      invalidateMacros();
    },
    onError: (err: Error) => setMutationError(err.message),
  });

  const saveTargetsMutation = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const calories = calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat);
      const keys = [
        { key: 'goal_calories', value: String(calories) },
        { key: 'goal_protein', value: String(targetProtein) },
        { key: 'goal_carbs', value: String(targetCarbs) },
        { key: 'goal_fat', value: String(targetFat) },
      ];

      // Parallelize all 4 upserts
      const results = await Promise.all(
        keys.map(({ key, value }) =>
          chefbyte().from('user_config').upsert({ user_id: user.id, key, value }, { onConflict: 'user_id,key' }),
        ),
      );

      const firstError = results.find((r) => r.error);
      if (firstError?.error) throw new Error(firstError.error.message);
    },
    onSuccess: () => {
      setShowTargetModal(false);
      invalidateMacros();
    },
    onError: (err: Error) => setMutationError(err.message),
  });

  const saveTasteMutation = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const { error: err } = await chefbyte()
        .from('user_config')
        .upsert({ user_id: user.id, key: 'taste_profile', value: tasteProfile }, { onConflict: 'user_id,key' });
      if (err) throw new Error(err.message);
    },
    onSuccess: () => setShowTasteModal(false),
    onError: (err: Error) => setMutationError(err.message),
  });

  /* ---------------------------------------------------------------- */
  /*  Modal open helpers                                               */
  /* ---------------------------------------------------------------- */

  const openTempModal = () => {
    setTempName('');
    setTempCalories(0);
    setTempProtein(0);
    setTempCarbs(0);
    setTempFat(0);
    setShowTempModal(true);
  };

  const openTargetModal = () => {
    if (data?.macros?.goals) {
      setTargetProtein(data.macros.goals.protein || 0);
      setTargetCarbs(data.macros.goals.carbs || 0);
      setTargetFat(data.macros.goals.fat || 0);
    }
    setShowTargetModal(true);
  };

  const openTasteModal = async () => {
    if (!user) return;
    const { data: configData } = await chefbyte()
      .from('user_config')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'taste_profile')
      .single();
    setTasteProfile((configData as any)?.value ?? '');
    setShowTasteModal(true);
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (isLoading) {
    return (
      <ChefLayout title="Macros">
        <div className="p-5" data-testid="macro-loading">
          <MacroBarSkeleton />
          <ListSkeleton count={4} />
        </div>
      </ChefLayout>
    );
  }

  const macros = data?.macros ?? null;
  const consumed = data?.consumed ?? [];
  const planned = data?.planned ?? [];
  const consumedTotals = macros?.consumed ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const goals = macros?.goals ?? { ...DEFAULT_MACRO_GOALS };

  return (
    <ChefLayout title="Macros">
      <Link to="/chef" className="text-sm font-medium text-emerald-600 hover:text-emerald-700 no-underline">
        &larr; Dashboard
      </Link>
      <h1 className="mt-2 mb-0 text-2xl font-bold text-slate-900">Macros</h1>
      {loadError && (
        <div className="border border-red-500 bg-red-50 rounded-lg p-4 mb-4" data-testid="load-error">
          <p className="text-red-600 m-0 mb-2">Failed to load data: {loadError.message}</p>
          <button
            className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
            onClick={() => invalidateMacros()}
          >
            Retry
          </button>
        </div>
      )}
      {mutationError && (
        <div className="text-red-600 mb-3">
          <p>{mutationError}</p>
        </div>
      )}

      {/* ============================================================ */}
      {/*  DATE NAVIGATION                                              */}
      {/* ============================================================ */}
      <div data-testid="date-nav" className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          className="px-4 py-2 bg-white border border-slate-300 rounded-md text-sm hover:bg-slate-50 transition-colors"
          onClick={prevDate}
          data-testid="prev-date-btn"
        >
          Prev
        </button>
        <button
          className="px-4 py-2 bg-emerald-600 text-white border-none rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
          onClick={goToday}
          data-testid="today-date-btn"
        >
          Today
        </button>
        <button
          className="px-4 py-2 bg-white border border-slate-300 rounded-md text-sm hover:bg-slate-50 transition-colors"
          onClick={nextDate}
          data-testid="next-date-btn"
        >
          Next
        </button>
        <input
          type="date"
          value={currentDate}
          onChange={(e) => {
            if (e.target.value) setCurrentDate(e.target.value);
          }}
          data-testid="date-picker"
          className="px-3 py-1.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
        />
        <span data-testid="current-date" className="ml-2 font-bold text-slate-900">
          {formatDateDisplay(currentDate)}
        </span>
      </div>

      {/* ============================================================ */}
      {/*  DAY SUMMARY -- PROGRESS BARS                                 */}
      {/* ============================================================ */}
      <div data-testid="macro-summary" className="mb-6">
        <h3 className="text-lg font-semibold text-slate-900 mb-3">Day Summary</h3>
        <MacroProgressBar
          label="Calories"
          current={consumedTotals.calories}
          goal={goals.calories}
          color="#059669"
          testId="progress-calories"
          barHeight="h-5"
        />
        <MacroProgressBar
          label="Protein"
          current={consumedTotals.protein}
          goal={goals.protein}
          color="#22c55e"
          unit="g"
          testId="progress-protein"
          barHeight="h-5"
        />
        <MacroProgressBar
          label="Carbs"
          current={consumedTotals.carbs}
          goal={goals.carbs}
          color="#f59e0b"
          unit="g"
          testId="progress-carbs"
          barHeight="h-5"
        />
        <MacroProgressBar
          label="Fats"
          current={consumedTotals.fat}
          goal={goals.fat}
          color="#ef4444"
          unit="g"
          testId="progress-fats"
          barHeight="h-5"
        />
      </div>

      {/* ============================================================ */}
      {/*  CONSUMED ITEMS — CARD LIST                                   */}
      {/* ============================================================ */}
      <div data-testid="consumed-section" className="mb-6">
        <h3 className="text-lg font-semibold text-slate-900 mb-3">Consumed Items</h3>
        {consumed.length === 0 ? (
          <p data-testid="no-consumed" className="text-slate-500">
            No consumed items for this day.
          </p>
        ) : (
          <div data-testid="consumed-table" className="space-y-2">
            {consumed.map((item) => {
              const badgeColor =
                item.source === 'Meal Plan'
                  ? 'bg-emerald-100 text-emerald-700'
                  : item.source === 'Temp Item'
                    ? 'bg-violet-100 text-violet-700'
                    : 'bg-sky-100 text-sky-700';
              return (
                <div
                  key={item.id}
                  data-testid={`consumed-row-${item.id}`}
                  className="bg-white border border-slate-200 rounded-lg px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${badgeColor}`}
                        >
                          {item.source}
                        </span>
                        <span className="text-sm font-medium text-slate-900">{item.name}</span>
                      </div>
                      <div className="flex gap-2 sm:gap-3 text-xs tabular-nums text-slate-600 mt-1 flex-wrap">
                        <span>{item.calories} cal</span>
                        <span>{item.protein}g P</span>
                        <span>{item.carbs}g C</span>
                        <span>{item.fat}g F</span>
                      </div>
                    </div>
                    {item.source !== 'LiquidTrack' && (
                      <button
                        className="text-red-500 hover:text-red-700 font-bold text-base bg-transparent border-none cursor-pointer shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center"
                        data-testid={`delete-consumed-${item.id}`}
                        onClick={() => deleteMutation.mutate(item)}
                        aria-label={`Remove ${item.name}`}
                      >
                        x
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Totals row */}
            <div
              data-testid="consumed-total-row"
              className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-2.5 flex flex-wrap items-center gap-2 font-bold"
            >
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 whitespace-nowrap">
                Total
              </span>
              <span className="flex-1 text-sm text-slate-900">TOTAL</span>
              <div className="flex gap-2 sm:gap-3 text-xs tabular-nums text-slate-900 flex-wrap">
                <span>{consumed.reduce((sum, i) => sum + i.calories, 0)} cal</span>
                <span>{consumed.reduce((sum, i) => sum + i.protein, 0)}g P</span>
                <span>{consumed.reduce((sum, i) => sum + i.carbs, 0)}g C</span>
                <span>{consumed.reduce((sum, i) => sum + i.fat, 0)}g F</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/*  PLANNED ITEMS                                                */}
      {/* ============================================================ */}
      <div data-testid="planned-section" className="mb-6">
        <h3 className="text-lg font-semibold text-slate-900 mb-3">Planned (not yet consumed)</h3>
        {planned.length === 0 ? (
          <p data-testid="no-planned" className="text-slate-500">
            No planned items for this day.
          </p>
        ) : (
          <>
            {/* Mobile card list */}
            <div data-testid="planned-table" className="flex flex-col gap-2 sm:hidden">
              {planned.map((item) => (
                <div
                  key={item.meal_id}
                  data-testid={`planned-row-${item.meal_id}`}
                  className="bg-white border border-slate-200 rounded-lg px-3 py-2.5"
                >
                  <div className="text-sm font-medium text-slate-900">{item.name}</div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-slate-600 mt-1">
                    <span>{item.calories} cal</span>
                    <span>{item.protein}g P</span>
                    <span>{item.carbs}g C</span>
                    <span>{item.fat}g F</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto rounded-lg border border-slate-200">
              <table data-testid="planned-table" className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b-2 border-slate-200">
                    <th className="p-2.5 text-left font-semibold text-slate-700 text-xs">Item</th>
                    <th className="p-2.5 text-right font-semibold text-slate-700 text-xs">Cal</th>
                    <th className="p-2.5 text-right font-semibold text-slate-700 text-xs">P</th>
                    <th className="p-2.5 text-right font-semibold text-slate-700 text-xs">C</th>
                    <th className="p-2.5 text-right font-semibold text-slate-700 text-xs">F</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.map((item) => (
                    <tr
                      key={item.meal_id}
                      data-testid={`planned-row-${item.meal_id}`}
                      className="border-b border-slate-100"
                    >
                      <td className="p-2 text-slate-900 font-medium">{item.name}</td>
                      <td className="p-2 text-right tabular-nums">{item.calories}</td>
                      <td className="p-2 text-right tabular-nums">{item.protein}g</td>
                      <td className="p-2 text-right tabular-nums">{item.carbs}g</td>
                      <td className="p-2 text-right tabular-nums">{item.fat}g</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ============================================================ */}
      {/*  ACTION BUTTONS                                               */}
      {/* ============================================================ */}
      <div className="flex gap-2 mb-6 flex-wrap [&>button]:flex-1 [&>button]:sm:flex-initial">
        <button
          className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
          onClick={openTempModal}
          data-testid="log-temp-btn"
        >
          + Log Temp Item
        </button>
        <button
          className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
          onClick={openTargetModal}
          data-testid="target-macros-btn"
        >
          Edit Targets
        </button>
        <button
          className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
          onClick={openTasteModal}
          data-testid="taste-profile-btn"
        >
          Taste Profile
        </button>
      </div>

      {/* ============================================================ */}
      {/*  LOG TEMP ITEM MODAL                                          */}
      {/* ============================================================ */}
      <ModalOverlay
        isOpen={showTempModal}
        onClose={() => setShowTempModal(false)}
        title="Log Temp Item"
        testId="temp-item-modal"
      >
        <div className="grid gap-3">
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Name</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              data-testid="temp-name"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Calories</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              type="number"
              min="0"
              value={tempCalories}
              onChange={(e) => setTempCalories(Number(e.target.value) || 0)}
              data-testid="temp-calories"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Protein</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              type="number"
              min="0"
              value={tempProtein}
              onChange={(e) => setTempProtein(Number(e.target.value) || 0)}
              data-testid="temp-protein"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Carbs</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              type="number"
              min="0"
              value={tempCarbs}
              onChange={(e) => setTempCarbs(Number(e.target.value) || 0)}
              data-testid="temp-carbs"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Fat</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              type="number"
              min="0"
              value={tempFat}
              onChange={(e) => setTempFat(Number(e.target.value) || 0)}
              data-testid="temp-fat"
            />
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            className="px-4 py-2 bg-white border border-slate-300 text-slate-600 rounded-md text-sm hover:bg-slate-50 transition-colors"
            onClick={() => setShowTempModal(false)}
            data-testid="temp-cancel-btn"
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
            onClick={() => addTempMutation.mutate()}
            disabled={!tempName.trim()}
            data-testid="temp-save-btn"
          >
            Log Item
          </button>
        </div>
      </ModalOverlay>

      {/* ============================================================ */}
      {/*  TARGET MACROS MODAL                                          */}
      {/* ============================================================ */}
      <ModalOverlay
        isOpen={showTargetModal}
        onClose={() => setShowTargetModal(false)}
        title="Target Macros"
        testId="target-macros-modal"
      >
        <div className="grid gap-3">
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Protein (g)</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              type="number"
              min="0"
              value={targetProtein}
              onChange={(e) => setTargetProtein(Number(e.target.value) || 0)}
              data-testid="target-protein"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Carbs (g)</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              type="number"
              min="0"
              value={targetCarbs}
              onChange={(e) => setTargetCarbs(Number(e.target.value) || 0)}
              data-testid="target-carbs"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-slate-700">Fats (g)</label>
            <input
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              type="number"
              min="0"
              value={targetFat}
              onChange={(e) => setTargetFat(Number(e.target.value) || 0)}
              data-testid="target-fats"
            />
          </div>
          <div data-testid="target-calories" className="p-2 bg-slate-50 rounded text-sm">
            <strong>Calories (auto): </strong>
            {calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat)}
            <div className="text-xs text-slate-500 mt-0.5">(protein*4 + carbs*4 + fat*9)</div>
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            className="px-4 py-2 bg-white border border-slate-300 text-slate-600 rounded-md text-sm hover:bg-slate-50 transition-colors"
            onClick={() => setShowTargetModal(false)}
            data-testid="target-cancel-btn"
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
            onClick={() => saveTargetsMutation.mutate()}
            data-testid="target-save-btn"
          >
            Save
          </button>
        </div>
      </ModalOverlay>

      {/* ============================================================ */}
      {/*  TASTE PROFILE MODAL                                          */}
      {/* ============================================================ */}
      <ModalOverlay
        isOpen={showTasteModal}
        onClose={() => setShowTasteModal(false)}
        title="Taste Profile"
        testId="taste-modal"
      >
        <p className="text-sm text-slate-500 mb-3">
          Dietary preferences and notes for recipe filtering and AI suggestions:
        </p>
        <textarea
          className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm resize-y min-h-[120px] font-[inherit] focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
          value={tasteProfile}
          onChange={(e) => setTasteProfile(e.target.value)}
          data-testid="taste-textarea"
          aria-label="Taste profile"
          rows={5}
        />
        <div className="flex gap-2 justify-end mt-4">
          <button
            className="px-4 py-2 bg-white border border-slate-300 text-slate-600 rounded-md text-sm hover:bg-slate-50 transition-colors"
            onClick={() => setShowTasteModal(false)}
            data-testid="taste-cancel-btn"
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
            onClick={() => saveTasteMutation.mutate()}
            data-testid="taste-save-btn"
          >
            Save
          </button>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
