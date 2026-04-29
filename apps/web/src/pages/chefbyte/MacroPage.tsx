import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Link } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { MacroProgressBar } from '@/components/shared/MacroProgressBar';
import { MacroBarSkeleton, ListSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { supabase, chefbyte } from '@/shared/supabase';
import { toDateStr, todayStr, formatDateDisplay } from '@/shared/dates';
import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { computeRecipeMacros } from './RecipesPage';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { macroDelta } from '@/shared/macroValidation';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface MacroTotals {
  consumed: { calories: number; protein: number; carbs: number; fat: number };
  goals: { calories: number; protein: number; carbs: number; fat: number };
}

export interface ConsumedItem {
  id: string;
  source: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  /**
   * Original qty_consumed for food_logs — needed to seed the inline qty
   * editor without re-fetching the row. Always populated for 'Meal Plan'
   * source rows; null/undefined for 'Temp Item'.
   */
  qty?: number | null;
  /** unit ('container'/'serving') — display + send to update RPC. */
  unit?: string | null;
}

export interface PlannedItem {
  meal_id: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface MacroPageData {
  macros: MacroTotals | null;
  consumed: ConsumedItem[];
  planned: PlannedItem[];
}

/* ------------------------------------------------------------------ */
/*  Exported data loader (legacy-audit #3 fix)                         */
/* ------------------------------------------------------------------ */

function asChefbyte(client?: SupabaseClient<any>) {
  return ((client ?? supabase) as any).schema('chefbyte');
}

/** Load the full MacroPage dataset for a given date.
 *
 * Replaces the previous "test replicates the page's 4-query fan-out
 * with a // Source: comment block" anti-pattern (2026-04-22 legacy
 * audit, issue #3). Integration tests call this loader directly.
 *
 * Uses Promise.all to fire the 4 independent queries in parallel:
 *   1. get_daily_macros RPC (totals + goals + remaining)
 *   2. food_logs (consumed from meal plan)
 *   3. temp_items (consumed ad-hoc entries)
 *   4. meal_plan_entries with deep recipe/product join (planned)
 */
export async function loadMacroPageData(
  userId: string,
  logicalDate: string,
  client?: SupabaseClient<any>,
): Promise<MacroPageData> {
  const chef = asChefbyte(client);
  const [macroRes, foodLogsRes, tempItemsRes, plannedRes] = await Promise.all([
    chef.rpc('get_daily_macros', { p_logical_date: logicalDate }),
    chef
      .from('food_logs')
      .select('log_id, product_id, qty_consumed, unit, calories, protein, carbs, fat, products:product_id(name)')
      .eq('user_id', userId)
      .eq('logical_date', logicalDate)
      .order('created_at'),
    chef
      .from('temp_items')
      .select('temp_id, name, calories, protein, carbs, fat')
      .eq('user_id', userId)
      .eq('logical_date', logicalDate)
      .order('created_at'),
    chef
      .from('meal_plan_entries')
      .select(
        'meal_id, servings, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving)',
      )
      .eq('user_id', userId)
      .eq('logical_date', logicalDate)
      .eq('meal_prep', false)
      .is('completed_at', null),
  ]);

  if (macroRes.error) throw new Error(macroRes.error.message);

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
      qty: Number(log.qty_consumed) || 0,
      unit: log.unit ?? null,
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
      qty: null,
      unit: null,
    });
  }

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
  const { dayStartHour } = useAppContext();
  const queryClient = useQueryClient();
  // Initial date = current logical date (respects day_start_hour).
  // Without the shift, at 05:30 local time with day_start_hour=6 the page
  // would show an empty "today" while the consume flows (InventoryPage,
  // shelf-ingest) correctly stamp food_logs with yesterday's logical_date.
  const [currentDate, setCurrentDate] = useState(() => todayStr(dayStartHour));

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

  /* ---- Inline qty edit on consumed items (audit fix) ---- */
  // editingId is the row id (log_id or temp_id) currently in edit mode.
  // editValue is the working text in the input — kept as a string so the
  // user can type/clear without a forced numeric coercion mid-keystroke.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');

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
    queryFn: () => loadMacroPageData(userId!, currentDate),
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
    setCurrentDate(todayStr(dayStartHour));
  };

  /* ---------------------------------------------------------------- */
  /*  Mutations                                                        */
  /* ---------------------------------------------------------------- */

  const invalidateMacros = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.dailyMacros(userId!, currentDate) });
  };

  const deleteMutation = useMutation({
    mutationFn: async (item: ConsumedItem) => {
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

  /**
   * Inline qty editor — calls the matching update RPC and rolls the cache
   * forward optimistically so the totals row reflects the change instantly.
   * Audit finding: prior workflow forced the user to delete + re-log to
   * fix a wrong qty.
   */
  const editQtyMutation = useMutation({
    mutationFn: async (args: { item: ConsumedItem; newQty: number }) => {
      const { item, newQty } = args;
      if (item.source === 'Meal Plan') {
        const { error: rpcErr } = await (chefbyte() as any).rpc('update_food_log_qty', {
          p_log_id: item.id,
          p_new_qty: newQty,
        });
        if (rpcErr) throw new Error(rpcErr.message);
      } else {
        // For temp_items there's no inherent qty — apply a scale factor
        // relative to the current macros (newQty interpreted as the new
        // calorie count divided by the existing one).
        const scale = item.calories > 0 ? newQty / item.calories : 1;
        const { error: rpcErr } = await (chefbyte() as any).rpc('update_temp_item_qty', {
          p_temp_id: item.id,
          p_scale: scale,
        });
        if (rpcErr) throw new Error(rpcErr.message);
      }
    },
    onMutate: async (args) => {
      const fullKey = [...queryKeys.dailyMacros(userId!, currentDate), 'full'];
      await queryClient.cancelQueries({ queryKey: queryKeys.dailyMacros(userId!, currentDate) });
      const previous = queryClient.getQueryData<MacroPageData>(fullKey);
      if (previous) {
        const { item, newQty } = args;
        let scale = 1;
        if (item.source === 'Meal Plan' && item.qty && item.qty > 0) {
          scale = newQty / item.qty;
        } else if (item.source === 'Temp Item' && item.calories > 0) {
          scale = newQty / item.calories;
        }
        const oldRow = previous.consumed.find((c) => c.id === item.id);
        const newCal = oldRow ? Math.round(oldRow.calories * scale) : 0;
        const newPro = oldRow ? Math.round(oldRow.protein * scale) : 0;
        const newCar = oldRow ? Math.round(oldRow.carbs * scale) : 0;
        const newFat = oldRow ? Math.round(oldRow.fat * scale) : 0;
        queryClient.setQueryData<MacroPageData>(fullKey, {
          ...previous,
          consumed: previous.consumed.map((c) =>
            c.id !== item.id
              ? c
              : {
                  ...c,
                  qty: item.source === 'Meal Plan' ? newQty : c.qty,
                  calories: newCal,
                  protein: newPro,
                  carbs: newCar,
                  fat: newFat,
                },
          ),
          // R2 audit #8: patch macros.consumed so the top-of-page
          // MacroProgressBar(s) animate immediately. The per-row totals
          // already updated through the consumed[] map, but
          // consumedTotals reads from macros.consumed (the RPC summary)
          // and was only refreshed by onSettled — a partial optimism the
          // audit called out.
          macros:
            previous.macros && oldRow
              ? {
                  ...previous.macros,
                  consumed: {
                    calories: Math.max(0, previous.macros.consumed.calories - oldRow.calories + newCal),
                    protein: Math.max(0, previous.macros.consumed.protein - oldRow.protein + newPro),
                    carbs: Math.max(0, previous.macros.consumed.carbs - oldRow.carbs + newCar),
                    fat: Math.max(0, previous.macros.consumed.fat - oldRow.fat + newFat),
                  },
                }
              : previous.macros,
        });
      }
      setEditingId(null);
      setEditValue('');
      return { previous };
    },
    onError: (err: Error, _args, context) => {
      if (context?.previous) {
        queryClient.setQueryData([...queryKeys.dailyMacros(userId!, currentDate), 'full'], context.previous);
      }
      setMutationError(err.message);
    },
    onSettled: () => invalidateMacros(),
  });

  const startEditQty = (item: ConsumedItem) => {
    setEditingId(item.id);
    if (item.source === 'Meal Plan' && item.qty != null) {
      setEditValue(String(item.qty));
    } else {
      setEditValue(String(item.calories));
    }
  };

  const commitEditQty = (item: ConsumedItem) => {
    const parsed = Number(editValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMutationError('Quantity must be greater than 0');
      return;
    }
    editQtyMutation.mutate({ item, newQty: parsed });
  };

  const cancelEditQty = () => {
    setEditingId(null);
    setEditValue('');
  };

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
      <Link to="/chef" className="text-sm font-medium text-chef-accent hover:text-chef-accent no-underline">
        &larr; Dashboard
      </Link>
      <h1 className="mt-2 mb-0 text-2xl font-bold text-text">Macros</h1>
      {loadError && (
        <div className="border border-danger bg-danger-subtle rounded-lg p-4 mb-4" data-testid="load-error">
          <p className="text-danger-text m-0 mb-2">Failed to load data: {loadError.message}</p>
          <button
            className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
            onClick={() => invalidateMacros()}
          >
            Retry
          </button>
        </div>
      )}
      {mutationError && (
        <div className="text-danger-text mb-3">
          <p>{mutationError}</p>
        </div>
      )}

      {/* ============================================================ */}
      {/*  DATE NAVIGATION                                              */}
      {/* ============================================================ */}
      <div data-testid="date-nav" className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          className="px-4 py-2 bg-surface border border-border-strong rounded-md text-sm hover:bg-surface-hover transition-colors"
          onClick={prevDate}
          data-testid="prev-date-btn"
        >
          Prev
        </button>
        <button
          className="px-4 py-2 bg-success text-white border-none rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
          onClick={goToday}
          data-testid="today-date-btn"
        >
          Today
        </button>
        <button
          className="px-4 py-2 bg-surface border border-border-strong rounded-md text-sm hover:bg-surface-hover transition-colors"
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
          className="px-3 py-1.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
        />
        <span data-testid="current-date" className="ml-2 font-bold text-text">
          {formatDateDisplay(currentDate)}
        </span>
      </div>

      {/* ============================================================ */}
      {/*  DAY SUMMARY -- PROGRESS BARS                                 */}
      {/* ============================================================ */}
      <div data-testid="macro-summary" className="mb-6">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-lg font-semibold text-text m-0">Day Summary</h3>
          {/* FLAG (CHEFBYTE_USE) — "Remaining" inline tile next to
              consumed totals. Single-line summary so the user can read
              "headroom for the rest of the day" without doing the
              subtraction in their head. Negative values are floored to
              0 + flagged in red so over-budget days read clearly. */}
          <div
            className="text-xs text-text-secondary tabular-nums flex gap-3 flex-wrap"
            data-testid="macro-remaining-tile"
          >
            {(['calories', 'protein', 'carbs', 'fat'] as const).map((k) => {
              const remaining = (goals as any)[k] - (consumedTotals as any)[k];
              const over = remaining < 0;
              const label = k === 'calories' ? 'cal' : k === 'protein' ? 'P' : k === 'carbs' ? 'C' : 'F';
              return (
                <span key={k} className={over ? 'text-danger-text font-semibold' : ''} data-testid={`remaining-${k}`}>
                  {over ? '+' : ''}
                  {Math.abs(Math.round(remaining))}
                  {k === 'calories' ? '' : 'g'} {label} {over ? 'over' : 'left'}
                </span>
              );
            })}
          </div>
        </div>
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
        <h3 className="text-lg font-semibold text-text mb-3">Consumed Items</h3>
        {consumed.length === 0 ? (
          <p data-testid="no-consumed" className="text-text-secondary">
            No consumed items for this day.
          </p>
        ) : (
          <div data-testid="consumed-table" className="space-y-2">
            {consumed.map((item) => {
              const badgeColor =
                item.source === 'Meal Plan' ? 'bg-success-subtle text-chef-accent' : 'bg-violet-100 text-violet-700';
              const isEditing = editingId === item.id;
              // R2 audit #9: explicit unit on the temp-item edit label so
              // a number entered here can't be confused with a serving qty
              // (the meal_plan rows next to it accept qty in serving/container
              // units). Same field, different semantics — the label is the
              // only disambiguator.
              const editLabel =
                item.source === 'Meal Plan'
                  ? `Qty (${item.unit ?? 'unit'})`
                  : 'Calories (kcal) — scales protein/carbs/fat';
              return (
                <div
                  key={item.id}
                  data-testid={`consumed-row-${item.id}`}
                  className="bg-surface border border-border rounded-lg px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${badgeColor}`}
                        >
                          {item.source}
                        </span>
                        <span className="text-sm font-medium text-text">{item.name}</span>
                        {item.source === 'Meal Plan' && item.qty != null && !isEditing && (
                          <span data-testid={`consumed-qty-${item.id}`} className="text-xs text-text-tertiary">
                            ({item.qty} {item.unit}
                            {Number(item.qty) !== 1 ? 's' : ''})
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2 sm:gap-3 text-xs tabular-nums text-text-secondary mt-1 flex-wrap items-center">
                        <span>{item.calories} cal</span>
                        <span>{item.protein}g P</span>
                        <span>{item.carbs}g C</span>
                        <span>{item.fat}g F</span>
                        {/* FLAG (CHEFBYTE_USE) — 4-4-9 validation indicator.
                            Soft warning when calories disagree with
                            4·protein+4·carbs+9·fat by >25%. Helps catch
                            LLM extraction bugs + unit mismatches without
                            being noisy on real foods (avocado, nuts). */}
                        {(() => {
                          const delta = macroDelta(item.calories, item.protein, item.carbs, item.fat);
                          if (!delta) return null;
                          const sign = delta.delta > 0 ? '+' : '';
                          return (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warn-subtle text-warn-text"
                              data-testid={`macro-449-warn-${item.id}`}
                              title={`Calories disagree with 4·P + 4·C + 9·F by ${sign}${delta.delta} (expected ${delta.expected}). Possible logging error.`}
                            >
                              4·4·9 off {sign}
                              {Math.round(delta.pctOff * 100)}%
                            </span>
                          );
                        })()}
                      </div>
                      {isEditing && (
                        <div
                          data-testid={`edit-qty-form-${item.id}`}
                          className="mt-2 flex items-center gap-2 flex-wrap"
                        >
                          <label className="text-xs text-text-tertiary">{editLabel}</label>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEditQty(item);
                              if (e.key === 'Escape') cancelEditQty();
                            }}
                            data-testid={`edit-qty-input-${item.id}`}
                            className="w-24 px-2 py-1 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                            autoFocus
                          />
                          <button
                            onClick={() => commitEditQty(item)}
                            data-testid={`edit-qty-save-${item.id}`}
                            className="px-2.5 py-1 bg-success text-white rounded text-xs font-semibold hover:bg-success-hover"
                          >
                            Save
                          </button>
                          <button
                            onClick={cancelEditQty}
                            data-testid={`edit-qty-cancel-${item.id}`}
                            className="px-2.5 py-1 bg-surface border border-border-strong text-text-secondary rounded text-xs font-semibold hover:bg-surface-hover"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                    {!isEditing && (
                      <div className="flex items-start gap-1 shrink-0">
                        {/* R2 audit #3: bumped 28px → 44px to meet the
                            mobile touch-target guideline. Audit flagged
                            these as the only 28px controls left after
                            R1 widened the shopping checkboxes. */}
                        <button
                          className="text-text-secondary hover:text-text font-semibold text-xs bg-transparent border border-border rounded cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center px-2"
                          data-testid={`edit-consumed-${item.id}`}
                          onClick={() => startEditQty(item)}
                          aria-label={`Edit qty for ${item.name}`}
                        >
                          Edit
                        </button>
                        <button
                          className="text-danger-text hover:text-danger-text font-bold text-base bg-transparent border-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
                          data-testid={`delete-consumed-${item.id}`}
                          onClick={() => deleteMutation.mutate(item)}
                          aria-label={`Remove ${item.name}`}
                        >
                          x
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Totals row */}
            <div
              data-testid="consumed-total-row"
              className="bg-surface-sunken border border-border-strong rounded-lg px-3 py-2.5 flex flex-wrap items-center gap-2 font-bold"
            >
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-border text-text-secondary whitespace-nowrap">
                Total
              </span>
              <span className="flex-1 text-sm text-text">TOTAL</span>
              <div className="flex gap-2 sm:gap-3 text-xs tabular-nums text-text flex-wrap">
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
        <h3 className="text-lg font-semibold text-text mb-3">Planned (not yet consumed)</h3>
        {planned.length === 0 ? (
          <p data-testid="no-planned" className="text-text-secondary">
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
                  className="bg-surface border border-border rounded-lg px-3 py-2.5"
                >
                  <div className="text-sm font-medium text-text">{item.name}</div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-text-secondary mt-1">
                    <span>{item.calories} cal</span>
                    <span>{item.protein}g P</span>
                    <span>{item.carbs}g C</span>
                    <span>{item.fat}g F</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto rounded-lg border border-border">
              <table data-testid="planned-table" className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-surface-sunken border-b-2 border-border">
                    <th className="p-2.5 text-left font-semibold text-text-secondary text-xs">Item</th>
                    <th className="p-2.5 text-right font-semibold text-text-secondary text-xs">Cal</th>
                    <th className="p-2.5 text-right font-semibold text-text-secondary text-xs">P</th>
                    <th className="p-2.5 text-right font-semibold text-text-secondary text-xs">C</th>
                    <th className="p-2.5 text-right font-semibold text-text-secondary text-xs">F</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.map((item) => (
                    <tr
                      key={item.meal_id}
                      data-testid={`planned-row-${item.meal_id}`}
                      className="border-b border-border-light"
                    >
                      <td className="p-2 text-text font-medium">{item.name}</td>
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
          className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
          onClick={openTempModal}
          data-testid="log-temp-btn"
        >
          + Log Temp Item
        </button>
        <button
          className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
          onClick={openTargetModal}
          data-testid="target-macros-btn"
        >
          Edit Targets
        </button>
        <button
          className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
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
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Name</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              data-testid="temp-name"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Calories</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              type="number"
              min="0"
              value={tempCalories}
              onChange={(e) => setTempCalories(Number(e.target.value) || 0)}
              data-testid="temp-calories"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Protein</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              type="number"
              min="0"
              value={tempProtein}
              onChange={(e) => setTempProtein(Number(e.target.value) || 0)}
              data-testid="temp-protein"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Carbs</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              type="number"
              min="0"
              value={tempCarbs}
              onChange={(e) => setTempCarbs(Number(e.target.value) || 0)}
              data-testid="temp-carbs"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Fat</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
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
            className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors"
            onClick={() => setShowTempModal(false)}
            data-testid="temp-cancel-btn"
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors disabled:opacity-50"
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
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Protein (g)</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              type="number"
              min="0"
              value={targetProtein}
              onChange={(e) => setTargetProtein(Number(e.target.value) || 0)}
              data-testid="target-protein"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Carbs (g)</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              type="number"
              min="0"
              value={targetCarbs}
              onChange={(e) => setTargetCarbs(Number(e.target.value) || 0)}
              data-testid="target-carbs"
            />
          </div>
          <div>
            <label className="block mb-1 text-xs font-semibold text-text-secondary">Fats (g)</label>
            <input
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
              type="number"
              min="0"
              value={targetFat}
              onChange={(e) => setTargetFat(Number(e.target.value) || 0)}
              data-testid="target-fats"
            />
          </div>
          <div data-testid="target-calories" className="p-2 bg-surface-sunken rounded text-sm">
            <strong>Calories (auto): </strong>
            {calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat)}
            <div className="text-xs text-text-secondary mt-0.5">(protein*4 + carbs*4 + fat*9)</div>
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors"
            onClick={() => setShowTargetModal(false)}
            data-testid="target-cancel-btn"
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
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
        <p className="text-sm text-text-secondary mb-3">
          Dietary preferences and notes for recipe filtering and AI suggestions:
        </p>
        <textarea
          className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm resize-y min-h-[120px] font-[inherit] focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
          value={tasteProfile}
          onChange={(e) => setTasteProfile(e.target.value)}
          data-testid="taste-textarea"
          aria-label="Taste profile"
          rows={5}
        />
        <div className="flex gap-2 justify-end mt-4">
          <button
            className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors"
            onClick={() => setShowTasteModal(false)}
            data-testid="taste-cancel-btn"
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
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
