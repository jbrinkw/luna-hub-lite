import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte, escapeIlike } from '@/shared/supabase';
import { toDateStr, todayStr } from '@/shared/dates';
import { mealTypeFromHour } from '@/shared/mealTypeFromHour';
import { computeRecipeMacros } from './RecipesPage';

import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { useToast } from '@/components/shared/Toast';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MealEntry {
  meal_id: string;
  user_id: string;
  recipe_id: string | null;
  product_id: string | null;
  logical_date: string;
  servings: number;
  meal_prep: boolean;
  meal_type: string | null;
  completed_at: string | null;
  recipes: {
    name: string;
    base_servings: number;
    recipe_ingredients: Array<{
      quantity: number;
      unit: string;
      products: {
        calories_per_serving: number;
        carbs_per_serving: number;
        protein_per_serving: number;
        fat_per_serving: number;
        servings_per_container: number;
      } | null;
    }>;
  } | null;
  products: {
    name: string;
    calories_per_serving: number;
    carbs_per_serving: number;
    protein_per_serving: number;
    fat_per_serving: number;
  } | null;
}

interface FoodLogEntry {
  log_id: string;
  logical_date: string;
  qty_consumed: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  products: { name: string } | null;
}

interface TempItemEntry {
  temp_id: string;
  logical_date: string;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface SearchResult {
  id: string;
  name: string;
  type: 'recipe' | 'product';
}

interface MealPlanData {
  meals: MealEntry[];
  foodLogs: FoodLogEntry[];
  tempItems: TempItemEntry[];
}

interface MacroGoals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for testing)                                 */
/* ------------------------------------------------------------------ */

export function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DAY_NAMES_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function formatWeekRange(monday: Date): string {
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${fmt(monday)} \u2014 ${fmt(sunday)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDateShort(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateLong(dateStr: string, dayIndex: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${DAY_NAMES_FULL[dayIndex]}, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/**
 * R2 audit #1: vs-goal sign convention.
 *
 *   - `consumed - goal` (delta).
 *   - `delta < 0` → under goal (room left, sign is `-`).
 *   - `delta > 0` → over goal (sign is `+`).
 *   - `delta === 0` → on goal (no sign).
 *
 * Used by the day-detail "vs goal" row. Exported so a unit test can
 * pin the mainstream-fitness-app convention without coupling to the
 * render output.
 */
export function vsGoalDelta(consumed: number, goal: number): number {
  return consumed - goal;
}

/**
 * Format vsGoalDelta into UI parts:
 *   { sign, abs, kind } where kind ∈ 'under' | 'over' | 'on'.
 */
export function vsGoalDeltaParts(
  consumed: number,
  goal: number,
): {
  sign: '+' | '-' | '';
  abs: number;
  kind: 'over' | 'under' | 'on';
} {
  const delta = vsGoalDelta(consumed, goal);
  if (delta > 0) return { sign: '+', abs: Math.round(delta), kind: 'over' };
  if (delta < 0) return { sign: '-', abs: Math.round(Math.abs(delta)), kind: 'under' };
  return { sign: '', abs: 0, kind: 'on' };
}

/**
 * R2 audit #2: helper for the day-totals reduction. Excludes
 * meal_prep entries from the eaten-today total because [MEAL] lots
 * are pre-cooked food meant to feed multiple days. Counting them
 * generates a false "+2400 cal over goal" alarm for a Sunday with a
 * weekly chicken prep.
 *
 * Pure — takes whatever the caller passes for macros so the function
 * stays testable independent of the page's macros pipeline.
 */
export function reduceDayTotalsExcludingPrep<
  T extends { meal_prep: boolean },
  M extends { calories: number; protein: number; carbs: number; fat: number },
>(meals: T[], macrosFor: (meal: T) => M | null): { calories: number; protein: number; carbs: number; fat: number } {
  const acc = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const m of meals) {
    if (m.meal_prep) continue;
    const macros = macrosFor(m);
    if (!macros) continue;
    acc.calories += macros.calories;
    acc.protein += macros.protein;
    acc.carbs += macros.carbs;
    acc.fat += macros.fat;
  }
  return acc;
}

/* ================================================================== */
/*  MealPlanPage                                                       */
/* ================================================================== */

export function MealPlanPage() {
  const { user } = useAuth();
  const { dayStartHour } = useAppContext();
  const queryClient = useQueryClient();
  // Initial week = Monday of the current logical date's week.
  // Respects day_start_hour so early-morning sessions before the daily
  // rollover don't jump to the calendar-next-day's week.
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date(todayStr(dayStartHour) + 'T00:00:00')));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  /* ---- Add meal modal state ---- */
  const [showAddModal, setShowAddModal] = useState(false);
  const [addSearchText, setAddSearchText] = useState('');
  const [addSearchResults, setAddSearchResults] = useState<SearchResult[]>([]);
  const [addShowDropdown, setAddShowDropdown] = useState(false);
  const [addSelected, setAddSelected] = useState<SearchResult | null>(null);
  const [addServings, setAddServings] = useState(1);
  const [addMealPrep, setAddMealPrep] = useState(false);
  const [addMealType, setAddMealType] = useState<string | null>(null);
  const [addDate, setAddDate] = useState<string>('');

  /* ---- Two-click delete confirmation ---- */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  /* ---- Inline qty edit on consumed items (R2 audit #10) ---- */
  // Wired to the same update_food_log_qty / update_temp_item_qty RPCs as
  // MacroPage so the user can fix a wrong quantity without leaving the
  // Meal Plan view.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  const toast = useToast();

  const [error, setError] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Derived date range                                               */
  /* ---------------------------------------------------------------- */

  const userId = user?.id;
  const startDate = toDateStr(weekStart);
  const endDate = toDateStr(new Date(weekStart.getTime() + 6 * 86400000));

  /* ---------------------------------------------------------------- */
  /*  Data loading via useQuery                                        */
  /* ---------------------------------------------------------------- */

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.mealPlan(userId!, startDate),
    queryFn: async (): Promise<MealPlanData> => {
      const [mealsRes, logRes, tempRes] = await Promise.all([
        chefbyte()
          .from('meal_plan_entries')
          .select(
            '*, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving)',
          )
          .eq('user_id', userId!)
          .gte('logical_date', startDate)
          .lte('logical_date', endDate)
          .order('created_at'),
        chefbyte()
          .from('food_logs')
          .select('log_id, logical_date, qty_consumed, unit, calories, protein, carbs, fat, products:product_id(name)')
          .eq('user_id', userId!)
          .gte('logical_date', startDate)
          .lte('logical_date', endDate)
          .order('created_at'),
        chefbyte()
          .from('temp_items')
          .select('temp_id, logical_date, name, calories, protein, carbs, fat')
          .eq('user_id', userId!)
          .gte('logical_date', startDate)
          .lte('logical_date', endDate)
          .order('created_at'),
      ]);

      if (mealsRes.error) throw new Error(mealsRes.error.message);

      return {
        meals: (mealsRes.data ?? []) as MealEntry[],
        foodLogs: (logRes.data ?? []) as FoodLogEntry[],
        tempItems: (tempRes.data ?? []) as TempItemEntry[],
      };
    },
    enabled: !!userId,
  });

  const meals = data?.meals;
  const foodLogs = data?.foodLogs;
  const tempItems = data?.tempItems;

  /* ---------------------------------------------------------------- */
  /*  Goals — fetched once for "vs goals" row on day-detail TOTAL     */
  /* ---------------------------------------------------------------- */

  // Audit finding: day_totals on MealPlan don't compare to goals — for a
  // single-user setup with set targets this is the most-asked planning
  // question and was unanswered.
  const { data: goals } = useQuery({
    queryKey: ['user_config_goals', userId],
    queryFn: async (): Promise<MacroGoals> => {
      const { data: rows } = await chefbyte()
        .from('user_config')
        .select('key, value')
        .eq('user_id', userId!)
        .in('key', ['goal_calories', 'goal_protein', 'goal_carbs', 'goal_fat']);
      const map = new Map<string, number>();
      for (const r of (rows ?? []) as Array<{ key: string; value: string }>) {
        // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: r.value is a user_config text column storing numeric goal values; Number.isFinite guard on the next line rejects NaN/Infinity
        const n = Number(r.value);
        if (Number.isFinite(n)) map.set(r.key, n);
      }
      return {
        calories: map.get('goal_calories') ?? DEFAULT_MACRO_GOALS.calories,
        protein: map.get('goal_protein') ?? DEFAULT_MACRO_GOALS.protein,
        carbs: map.get('goal_carbs') ?? DEFAULT_MACRO_GOALS.carbs,
        fat: map.get('goal_fat') ?? DEFAULT_MACRO_GOALS.fat,
      };
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  });

  /* ---------------------------------------------------------------- */
  /*  Realtime invalidation                                            */
  /* ---------------------------------------------------------------- */

  useRealtimeInvalidation('mealplan-changes', [
    {
      schema: 'chefbyte',
      table: 'meal_plan_entries',
      queryKeys: [queryKeys.mealPlan(userId!, startDate)],
    },
    {
      schema: 'chefbyte',
      table: 'food_logs',
      queryKeys: [queryKeys.mealPlan(userId!, startDate)],
    },
    {
      schema: 'chefbyte',
      table: 'temp_items',
      queryKeys: [queryKeys.mealPlan(userId!, startDate)],
    },
  ]);

  /* ---------------------------------------------------------------- */
  /*  Auto-select today on initial load                                */
  /* ---------------------------------------------------------------- */

  // Today's logical date (respects day_start_hour — at 05:30 local with
  // dsh=6 this returns yesterday so the MealPlan highlights the day the
  // user's macros/meals are actually attributed to).
  const todayLogical = todayStr(dayStartHour);

  useEffect(() => {
    if (!isLoading && selectedDay === null) {
      if (todayLogical >= startDate && todayLogical <= endDate) {
        setSelectedDay(todayLogical);
      }
    }
    // Only run when loading finishes, not on every todayLogical change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  /* ---------------------------------------------------------------- */
  /*  Week navigation                                                  */
  /* ---------------------------------------------------------------- */

  const prevWeek = () => {
    setWeekStart((prev) => new Date(prev.getTime() - 7 * 86400000));
    setSelectedDay(null);
  };

  const nextWeek = () => {
    setWeekStart((prev) => new Date(prev.getTime() + 7 * 86400000));
    setSelectedDay(null);
  };

  const goToday = () => {
    // Snap to the week containing today's logical date (respects dsh).
    setWeekStart(getMonday(new Date(todayStr(dayStartHour) + 'T00:00:00')));
    setSelectedDay(null);
  };

  /* ---------------------------------------------------------------- */
  /*  Derived data: meals grouped by day                               */
  /* ---------------------------------------------------------------- */

  const dayDates = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => toDateStr(new Date(weekStart.getTime() + i * 86400000)));
  }, [weekStart]);

  const mealsByDay = useMemo(() => {
    const map = new Map<string, MealEntry[]>();
    for (const date of dayDates) {
      map.set(date, []);
    }
    for (const meal of meals ?? []) {
      const list = map.get(meal.logical_date);
      if (list) list.push(meal);
    }
    return map;
  }, [meals, dayDates]);

  const selectedDayMeals = useMemo(() => {
    if (!selectedDay) return [];
    const raw = mealsByDay.get(selectedDay) ?? [];
    return [...raw].sort((a, b) => {
      const groupA = a.meal_prep && !a.completed_at ? 0 : !a.completed_at ? 1 : 2;
      const groupB = b.meal_prep && !b.completed_at ? 0 : !b.completed_at ? 1 : 2;
      if (groupA !== groupB) return groupA - groupB;
      if (groupA === 2 && a.completed_at && b.completed_at) {
        return a.completed_at.localeCompare(b.completed_at);
      }
      return 0;
    });
  }, [selectedDay, mealsByDay]);

  const selectedDayLogs = useMemo(() => {
    if (!selectedDay) return [];
    return (foodLogs ?? []).filter((l) => l.logical_date === selectedDay);
  }, [selectedDay, foodLogs]);

  const selectedDayTemps = useMemo(() => {
    if (!selectedDay) return [];
    return (tempItems ?? []).filter((t) => t.logical_date === selectedDay);
  }, [selectedDay, tempItems]);

  /* ---------------------------------------------------------------- */
  /*  Entry name helper                                                */
  /* ---------------------------------------------------------------- */

  const entryName = (meal: MealEntry): string => meal.recipes?.name ?? meal.products?.name ?? 'Unknown';

  const entryMacros = (meal: MealEntry): { calories: number; protein: number; carbs: number; fat: number } | null => {
    if (meal.products) {
      const s = meal.servings;
      return {
        calories: Math.round(Number(meal.products.calories_per_serving) * s),
        protein: Math.round(Number(meal.products.protein_per_serving) * s),
        carbs: Math.round(Number(meal.products.carbs_per_serving) * s),
        fat: Math.round(Number(meal.products.fat_per_serving) * s),
      };
    }
    if (meal.recipes && meal.recipes.recipe_ingredients?.length > 0) {
      const perServing = computeRecipeMacros(
        meal.recipes.recipe_ingredients.map((ri) => ({
          quantity: Number(ri.quantity),
          unit: ri.unit,
          products: ri.products
            ? {
                calories_per_serving: Number(ri.products.calories_per_serving),
                carbs_per_serving: Number(ri.products.carbs_per_serving),
                protein_per_serving: Number(ri.products.protein_per_serving),
                fat_per_serving: Number(ri.products.fat_per_serving),
                servings_per_container: Number(ri.products.servings_per_container),
              }
            : null,
        })),
        Number(meal.recipes.base_servings) || 1,
      );
      const s = meal.servings;
      return {
        calories: Math.round(perServing.calories * s),
        protein: Math.round(perServing.protein * s),
        carbs: Math.round(perServing.carbs * s),
        fat: Math.round(perServing.fat * s),
      };
    }
    return null;
  };

  /* ---------------------------------------------------------------- */
  /*  Invalidation helper                                              */
  /* ---------------------------------------------------------------- */

  const invalidateMealPlan = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.mealPlan(userId!, startDate) });
  };

  /* ---------------------------------------------------------------- */
  /*  Mutations                                                        */
  /* ---------------------------------------------------------------- */

  const markDoneMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { data, error: rpcErr } = await (chefbyte() as any).rpc('mark_meal_done', { p_meal_id: mealId });
      if (rpcErr) throw new Error(rpcErr.message);
      return data as { partials?: Array<{ product_id: string; needed: number; available: number }> } | null;
    },
    // Full optimistic update (R2 audit #4): flip completed_at AND seed a
    // synthetic food_logs row so the day's "Consumed" panel populates
    // instantly. Without the seed the panel stays empty for ~300ms until
    // onSettled refetches — a partial optimism the audit called out as
    // visually misleading on the most-clicked daily action.
    onMutate: async (mealId: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.mealPlan(userId!, startDate) });
      const previous = queryClient.getQueryData<MealPlanData>(queryKeys.mealPlan(userId!, startDate));
      if (previous) {
        const nowIso = new Date().toISOString();
        const meal = previous.meals.find((m) => m.meal_id === mealId);
        const macros = meal ? entryMacros(meal) : null;
        // Seed synthetic food_logs entry so the Consumed panel reflects
        // the change immediately. Negative log_id sentinel ensures the
        // refetch (which returns real UUIDs) replaces this row cleanly.
        const seededLog: FoodLogEntry | null =
          meal && macros
            ? {
                log_id: `optimistic-${mealId}`,
                logical_date: meal.logical_date,
                qty_consumed: meal.servings,
                unit: 'serving',
                calories: macros.calories,
                protein: macros.protein,
                carbs: macros.carbs,
                fat: macros.fat,
                products: { name: meal.recipes?.name ?? meal.products?.name ?? 'Meal' },
              }
            : null;
        queryClient.setQueryData<MealPlanData>(queryKeys.mealPlan(userId!, startDate), {
          ...previous,
          meals: previous.meals.map((m) => (m.meal_id === mealId ? { ...m, completed_at: nowIso } : m)),
          foodLogs: seededLog ? [...previous.foodLogs, seededLog] : previous.foodLogs,
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      // Zero-shorts: if any ingredient was out of stock, show an info toast
      // listing what was missing. The meal is still completed — this is
      // informational only, not an error.
      if (data?.partials && data.partials.length > 0) {
        const names = data.partials
          .map(
            (p) => `product ${p.product_id.slice(0, 8)} (need ${p.needed.toFixed(2)}, had ${p.available.toFixed(2)})`,
          )
          .join('; ');
        toast.show(`Meal done — some items were out of stock: ${names}`, { variant: 'info', durationMs: 8000 });
      }
    },
    onError: (err: Error, _mealId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.mealPlan(userId!, startDate), context.previous);
      }
      setError(err.message);
    },
    onSettled: () => invalidateMealPlan(),
  });

  const unmarkDoneMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { error: rpcErr } = await (chefbyte() as any).rpc('unmark_meal_done', { p_meal_id: mealId });
      if (rpcErr) throw new Error(rpcErr.message);
    },
    onMutate: async (mealId: string) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.mealPlan(userId!, startDate) });
      const previous = queryClient.getQueryData<MealPlanData>(queryKeys.mealPlan(userId!, startDate));
      if (previous) {
        // Mirror the markDone optimism: clear completed_at AND drop the
        // optimistic food_logs row we seeded. Real refetch via onSettled
        // will reconcile if the server-stored logs have other shapes.
        queryClient.setQueryData<MealPlanData>(queryKeys.mealPlan(userId!, startDate), {
          ...previous,
          meals: previous.meals.map((m) => (m.meal_id === mealId ? { ...m, completed_at: null } : m)),
          foodLogs: previous.foodLogs.filter((l) => l.log_id !== `optimistic-${mealId}`),
        });
      }
      return { previous };
    },
    onError: (err: Error, _mealId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.mealPlan(userId!, startDate), context.previous);
      }
      setError(err.message);
    },
    onSettled: () => invalidateMealPlan(),
  });

  const deleteMealMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { error: deleteErr } = await chefbyte().from('meal_plan_entries').delete().eq('meal_id', mealId);
      if (deleteErr) throw new Error(deleteErr.message);
    },
    onMutate: async (mealId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.mealPlan(userId!, startDate) });
      const previous = queryClient.getQueryData<MealPlanData>(queryKeys.mealPlan(userId!, startDate));
      if (previous) {
        queryClient.setQueryData<MealPlanData>(queryKeys.mealPlan(userId!, startDate), {
          ...previous,
          meals: previous.meals.filter((m) => m.meal_id !== mealId),
        });
      }
      return { previous };
    },
    onError: (err: Error, _mealId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.mealPlan(userId!, startDate), context.previous);
      }
      setError(err.message);
    },
    onSettled: () => invalidateMealPlan(),
  });

  const toggleMealPrepMutation = useMutation({
    mutationFn: async (meal: MealEntry) => {
      const { error: updateErr } = await chefbyte()
        .from('meal_plan_entries')
        .update({ meal_prep: !meal.meal_prep })
        .eq('meal_id', meal.meal_id);
      if (updateErr) throw new Error(updateErr.message);
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => invalidateMealPlan(),
  });

  const addMealMutation = useMutation({
    mutationFn: async () => {
      if (!user || !addSelected || !addDate) return;
      const { error: insertErr } = await chefbyte()
        .from('meal_plan_entries')
        .insert({
          user_id: user.id,
          recipe_id: addSelected.type === 'recipe' ? addSelected.id : null,
          product_id: addSelected.type === 'product' ? addSelected.id : null,
          logical_date: addDate,
          servings: addServings,
          meal_prep: addMealPrep,
          meal_type: addMealType,
        });
      if (insertErr) throw new Error(insertErr.message);
    },
    onSuccess: () => {
      if (!selectedDay) {
        setSelectedDay(addDate);
      }
      setShowAddModal(false);
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => invalidateMealPlan(),
  });

  /* ---------------------------------------------------------------- */
  /*  Delete consumed items (two-click confirm)                        */
  /* ---------------------------------------------------------------- */

  // FLAG (CHEFBYTE_USE) — two-click delete cross-row collision fix.
  // Each click on a "Delete" button starts a 4s confirm window. If the
  // user clicks a different row's button mid-window, row A silently
  // reverts to "Delete" and row B becomes "You sure?" — matching the
  // visual mental model. Auto-clear after 4s so a button left in the
  // pre-confirmed state doesn't persist visually.
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, []);
  const handleDelete = (id: string, doDelete: () => Promise<void>) => {
    if (confirmDeleteId === id) {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      setConfirmDeleteId(null);
      doDelete();
    } else {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
      setConfirmDeleteId(id);
      confirmTimeoutRef.current = setTimeout(() => {
        setConfirmDeleteId((current) => (current === id ? null : current));
      }, 4000);
    }
  };

  const deleteFoodLogMutation = useMutation({
    mutationFn: async (logId: string) => {
      const { error: err } = await chefbyte().from('food_logs').delete().eq('log_id', logId);
      if (err) throw new Error(err.message);
    },
    onSettled: () => invalidateMealPlan(),
  });

  const deleteTempItemMutation = useMutation({
    mutationFn: async (tempId: string) => {
      const { error: err } = await chefbyte().from('temp_items').delete().eq('temp_id', tempId);
      if (err) throw new Error(err.message);
    },
    onSettled: () => invalidateMealPlan(),
  });

  /* Inline qty edit (R2 audit #10) — shares the same update_food_log_qty
   * / update_temp_item_qty RPCs already proven on MacroPage. Optimistic
   * patch scales the row's macros instantly. */
  type EditQtyArg =
    | { kind: 'log'; log: FoodLogEntry; newQty: number }
    | { kind: 'temp'; temp: TempItemEntry; newCalories: number };

  const editQtyMutation = useMutation({
    mutationFn: async (arg: EditQtyArg) => {
      if (arg.kind === 'log') {
        const { error: rpcErr } = await (chefbyte() as any).rpc('update_food_log_qty', {
          p_log_id: arg.log.log_id,
          p_new_qty: arg.newQty,
        });
        if (rpcErr) throw new Error(rpcErr.message);
      } else {
        const scale = arg.temp.calories > 0 ? arg.newCalories / arg.temp.calories : 1;
        const { error: rpcErr } = await (chefbyte() as any).rpc('update_temp_item_qty', {
          p_temp_id: arg.temp.temp_id,
          p_scale: scale,
        });
        if (rpcErr) throw new Error(rpcErr.message);
      }
    },
    onMutate: async (arg) => {
      const key = queryKeys.mealPlan(userId!, startDate);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<MealPlanData>(key);
      if (previous) {
        let scale = 1;
        if (arg.kind === 'log' && arg.log.qty_consumed > 0) {
          scale = arg.newQty / Number(arg.log.qty_consumed);
        } else if (arg.kind === 'temp' && arg.temp.calories > 0) {
          scale = arg.newCalories / arg.temp.calories;
        }
        queryClient.setQueryData<MealPlanData>(key, {
          ...previous,
          foodLogs:
            arg.kind === 'log'
              ? previous.foodLogs.map((l) =>
                  l.log_id !== arg.log.log_id
                    ? l
                    : {
                        ...l,
                        qty_consumed: arg.newQty,
                        calories: Math.round(Number(l.calories) * scale),
                        protein: Math.round(Number(l.protein) * scale),
                        carbs: Math.round(Number(l.carbs) * scale),
                        fat: Math.round(Number(l.fat) * scale),
                      },
                )
              : previous.foodLogs,
          tempItems:
            arg.kind === 'temp'
              ? previous.tempItems.map((t) =>
                  t.temp_id !== arg.temp.temp_id
                    ? t
                    : {
                        ...t,
                        calories: Math.round(Number(t.calories) * scale),
                        protein: Math.round(Number(t.protein) * scale),
                        carbs: Math.round(Number(t.carbs) * scale),
                        fat: Math.round(Number(t.fat) * scale),
                      },
                )
              : previous.tempItems,
        });
      }
      setEditingId(null);
      setEditValue('');
      return { previous };
    },
    onError: (err: Error, _arg, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.mealPlan(userId!, startDate), context.previous);
      }
      setError(err.message);
      toast.show(`Update failed: ${err.message}`, { variant: 'error' });
    },
    onSettled: () => invalidateMealPlan(),
  });

  const startEditLog = (log: FoodLogEntry) => {
    setEditingId(`log-${log.log_id}`);
    setEditValue(String(log.qty_consumed));
  };
  const startEditTemp = (item: TempItemEntry) => {
    setEditingId(`temp-${item.temp_id}`);
    setEditValue(String(item.calories));
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };
  const commitEditLog = (log: FoodLogEntry) => {
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: immediately guarded by Number.isFinite on the next line
    const parsed = Number(editValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Quantity must be greater than 0');
      return;
    }
    editQtyMutation.mutate({ kind: 'log', log, newQty: parsed });
  };
  const commitEditTemp = (temp: TempItemEntry) => {
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: immediately guarded by Number.isFinite on the next line
    const parsed = Number(editValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Calories must be greater than 0');
      return;
    }
    editQtyMutation.mutate({ kind: 'temp', temp, newCalories: parsed });
  };

  /* ---------------------------------------------------------------- */
  /*  Add meal: search recipes + products                              */
  /* ---------------------------------------------------------------- */

  const searchItems = useCallback(
    async (text: string) => {
      if (!user || text.trim().length < 1) {
        setAddSearchResults([]);
        setAddShowDropdown(false);
        return;
      }

      const escaped = escapeIlike(text);

      const { data: recipes } = await chefbyte()
        .from('recipes')
        .select('recipe_id, name')
        .eq('user_id', user.id)
        .ilike('name', `%${escaped}%`)
        .order('name');

      const { data: products } = await chefbyte()
        .from('products')
        .select('product_id, name')
        .eq('user_id', user.id)
        .ilike('name', `%${escaped}%`)
        .order('name');

      const results: SearchResult[] = [];
      for (const r of (recipes ?? []) as { recipe_id: string; name: string }[]) {
        results.push({ id: r.recipe_id, name: r.name, type: 'recipe' });
      }
      for (const p of (products ?? []) as { product_id: string; name: string }[]) {
        results.push({ id: p.product_id, name: p.name, type: 'product' });
      }

      setAddSearchResults(results);
      setAddShowDropdown(results.length > 0);
    },
    [user],
  );

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const handleAddSearchInput = (value: string) => {
    setAddSearchText(value);
    setAddSelected(null);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => searchItems(value), 300);
  };

  const selectAddItem = (item: SearchResult) => {
    setAddSearchText(item.name);
    setAddSelected(item);
    setAddShowDropdown(false);
    setAddSearchResults([]);
  };

  const openAddModal = () => {
    setAddSearchText('');
    setAddSearchResults([]);
    setAddSelected(null);
    setAddServings(1);
    setAddMealPrep(false);
    // ChefByte FLAG (CHEFBYTE_USE) — pre-fill meal_type from local
    // time. See `mealTypeFromHour` for the windowing rules.
    setAddMealType(mealTypeFromHour(new Date().getHours()));
    setAddShowDropdown(false);
    // Default date: selected day or today's logical date
    setAddDate(selectedDay || todayLogical);
    setShowAddModal(true);
  };

  /* Helper: two-click delete button */
  const DeleteBtn = ({ id, onConfirm, testId }: { id: string; onConfirm: () => Promise<void>; testId: string }) => (
    <button
      onClick={() => handleDelete(id, onConfirm)}
      data-testid={testId}
      className={[
        'px-2.5 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors',
        confirmDeleteId === id
          ? 'bg-danger text-white border-none'
          : 'bg-transparent text-danger-text border border-danger hover:bg-danger-subtle',
      ].join(' ')}
    >
      {confirmDeleteId === id ? 'You sure?' : 'Delete'}
    </button>
  );

  const inputCls =
    'w-full px-3 py-2 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary';

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (isLoading) {
    return (
      <ChefLayout title="Meal Plan">
        <div className="space-y-4 p-4" data-testid="mealplan-loading">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </ChefLayout>
    );
  }

  const selectedDayIndex = selectedDay ? dayDates.indexOf(selectedDay) : -1;

  /* Compute totals for the selected day.
   *
   * R2 audit #2: meal_prep entries are pre-cooked food intended to feed
   * MULTIPLE days. Use the shared `reduceDayTotalsExcludingPrep` helper
   * so the exclusion logic is unit-tested independently of the page.
   */
  const dayTotals = reduceDayTotalsExcludingPrep(selectedDayMeals, entryMacros);

  return (
    <ChefLayout title="Meal Plan">
      {/* ============================================================ */}
      {/*  TOP BAR                                                      */}
      {/* ============================================================ */}
      <div data-testid="week-nav" className="mb-4 flex justify-between items-center flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="m-0 text-xl font-bold text-text">Meal Plan</h1>
          <button
            onClick={openAddModal}
            data-testid="add-meal-btn"
            className="px-3.5 py-1.5 bg-success text-white rounded-md font-semibold text-xs hover:bg-success-hover transition-colors"
          >
            + Add Meal
          </button>
        </div>
        <div className="flex gap-1.5 items-center flex-wrap">
          <button
            onClick={prevWeek}
            data-testid="prev-week-btn"
            className="px-3 py-1.5 bg-surface border border-border-strong rounded-md text-xs hover:bg-surface-hover transition-colors"
          >
            Prev
          </button>
          <button
            onClick={goToday}
            data-testid="today-btn"
            className="px-3 py-1.5 bg-success text-white rounded-md font-semibold text-xs hover:bg-success-hover transition-colors"
          >
            Today
          </button>
          <button
            onClick={nextWeek}
            data-testid="next-week-btn"
            className="px-3 py-1.5 bg-surface border border-border-strong rounded-md text-xs hover:bg-surface-hover transition-colors"
          >
            Next
          </button>
          <span data-testid="week-range" className="ml-2 font-bold text-xs text-text-secondary">
            {formatWeekRange(weekStart)}
          </span>
        </div>
      </div>

      {error && <p className="text-danger-text m-0 mb-3">{error}</p>}

      {/* ============================================================ */}
      {/*  RESPONSIVE LAYOUT: vertical on mobile, side-by-side on md+  */}
      {/* ============================================================ */}
      <div className="flex flex-col md:flex-row gap-4 md:items-start">
        {/* ---------------------------------------------------------- */}
        {/*  LEFT PANEL / TOP STRIP -- Week days                       */}
        {/* ---------------------------------------------------------- */}

        {/* Mobile: horizontal scrollable day strip */}
        <div data-testid="week-grid" className="md:hidden flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
          {dayDates.map((date, i) => {
            const dayMeals = mealsByDay.get(date) ?? [];
            const isSelected = selectedDay === date;
            const isToday = date === todayLogical;
            const mealCount = dayMeals.length;

            return (
              <button
                key={date}
                data-testid={`day-col-${date}`}
                onClick={() => setSelectedDay(date)}
                className={[
                  'flex flex-col items-center px-3 py-2 rounded-lg cursor-pointer transition-colors shrink-0 border-none min-w-[56px]',
                  isSelected
                    ? 'bg-success text-white'
                    : isToday
                      ? 'bg-success-subtle text-chef-accent ring-2 ring-emerald-300'
                      : 'bg-surface-hover text-text-secondary hover:bg-border',
                ].join(' ')}
              >
                <span className="font-bold text-xs">{DAY_NAMES[i]}</span>
                <span
                  className={['text-[11px] mt-0.5', isSelected ? 'text-white/80' : 'text-text-secondary'].join(' ')}
                >
                  {formatDateShort(date)}
                </span>
                {mealCount > 0 && (
                  <span
                    className={['mt-1 w-1.5 h-1.5 rounded-full', isSelected ? 'bg-white' : 'bg-success'].join(' ')}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Desktop: vertical week list */}
        <div className="hidden md:flex w-[280px] min-w-[280px] flex-col gap-0.5 bg-surface-hover rounded-lg overflow-hidden border border-border">
          {dayDates.map((date, i) => {
            const dayMeals = mealsByDay.get(date) ?? [];
            const isSelected = selectedDay === date;
            const isToday = date === todayLogical;
            const mealCount = dayMeals.length;

            return (
              <div
                key={date}
                data-testid={`day-col-desktop-${date}`}
                onClick={() => setSelectedDay(date)}
                className={[
                  'flex items-center justify-between px-3.5 py-2.5 cursor-pointer transition-colors border-l-[3px]',
                  isToday
                    ? 'bg-success-subtle border-l-emerald-600'
                    : isSelected
                      ? 'bg-surface-sunken border-l-emerald-600'
                      : 'bg-surface border-l-transparent hover:bg-surface-hover',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      'font-semibold text-xs min-w-[30px]',
                      isToday ? 'text-chef-accent' : 'text-text-secondary',
                    ].join(' ')}
                  >
                    {DAY_NAMES[i]}
                  </span>
                  <span className="text-xs text-text-secondary">{formatDateShort(date)}</span>
                  {isToday && (
                    <span className="text-[10px] font-bold text-chef-accent bg-success-subtle px-1.5 py-0.5 rounded">
                      TODAY
                    </span>
                  )}
                </div>
                {mealCount > 0 && (
                  <span className="text-xs text-text-tertiary">
                    {mealCount} meal{mealCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* ---------------------------------------------------------- */}
        {/*  RIGHT PANEL / BOTTOM -- Selected day detail                */}
        {/* ---------------------------------------------------------- */}
        <div className="flex-1 min-w-0">
          {!selectedDay ? (
            <div className="py-10 px-5 text-center text-text-tertiary text-sm bg-surface-sunken rounded-lg border border-border">
              Select a day to view details
            </div>
          ) : (
            <div data-testid="day-detail">
              <h3 data-testid="day-detail-title" className="m-0 mb-4 text-base font-semibold text-text">
                {formatDateLong(selectedDay, selectedDayIndex)}
              </h3>

              {/* ------- Planned Meals Section ------- */}
              <div className="bg-surface border border-border rounded-lg overflow-hidden mb-4">
                <div className="px-4 py-2.5 bg-surface-sunken border-b border-border">
                  <h4 className="m-0 text-sm font-bold text-text-secondary uppercase tracking-wide">Planned Meals</h4>
                </div>

                {selectedDayMeals.length === 0 ? (
                  <p data-testid="no-meals" className="text-text-tertiary text-sm px-4 py-5 text-center m-0">
                    No meals planned for this day. Use the{' '}
                    <button
                      type="button"
                      onClick={openAddModal}
                      className="text-chef-accent font-medium hover:underline bg-transparent border-none cursor-pointer p-0 text-sm"
                    >
                      + Add Meal
                    </button>{' '}
                    button to plan your meals.
                  </p>
                ) : (
                  <div data-testid="day-detail-table" className="flex flex-col gap-2.5 p-3">
                    {selectedDayMeals.map((meal) => {
                      const macros = entryMacros(meal);
                      return (
                        <div
                          key={meal.meal_id}
                          data-testid={`detail-row-${meal.meal_id}`}
                          className="bg-surface border border-border rounded-lg p-3.5"
                        >
                          <div
                            data-testid={`grid-meal-${meal.meal_id}`}
                            className="flex flex-col sm:flex-row sm:justify-between sm:items-start"
                          >
                            <div className="flex-1 min-w-0">
                              {/* Row 1: Meal name + type badge */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="font-semibold text-[15px] text-text">{entryName(meal)}</div>
                                {meal.meal_type && (
                                  <span
                                    data-testid={`meal-type-label-${meal.meal_id}`}
                                    className="inline-block text-[11px] bg-border px-2 py-0.5 rounded text-text-secondary capitalize"
                                  >
                                    {meal.meal_type}
                                  </span>
                                )}
                              </div>

                              {/* Row 2: Macros */}
                              {macros && (macros.calories > 0 || macros.protein > 0) && (
                                <div
                                  data-testid={`grid-macros-${meal.meal_id}`}
                                  className="text-xs text-text-secondary mt-1.5"
                                >
                                  {macros.calories}cal | {macros.protein}g P | {macros.carbs}g C | {macros.fat}g F
                                </div>
                              )}

                              {/* Row 3: Status badges + prep checkbox */}
                              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                                {meal.completed_at && (
                                  <span
                                    data-testid={`done-badge-${meal.meal_id}`}
                                    className="inline-block text-[11px] bg-success text-white px-2 py-0.5 rounded font-semibold"
                                  >
                                    Done
                                  </span>
                                )}
                                {meal.meal_prep && !meal.completed_at && (
                                  <span
                                    data-testid={`prep-badge-${meal.meal_id}`}
                                    className="inline-block text-[11px] bg-violet-600 text-white px-2 py-0.5 rounded font-semibold"
                                  >
                                    PREP
                                  </span>
                                )}
                                {!meal.meal_prep && !meal.completed_at && (
                                  <span className="text-[11px] text-text-tertiary">Regular</span>
                                )}
                                {meal.completed_at && (
                                  <span className="text-[11px] text-text-tertiary">
                                    at {formatTime(meal.completed_at)}
                                  </span>
                                )}
                                {!meal.completed_at && (
                                  <label className="inline-flex items-center gap-1 text-[11px] text-text-tertiary cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={meal.meal_prep}
                                      onChange={() => toggleMealPrepMutation.mutate(meal)}
                                      disabled={!!meal.completed_at}
                                      aria-label={`Toggle meal prep for ${entryName(meal)}`}
                                      data-testid={`toggle-prep-${meal.meal_id}`}
                                      className="w-3.5 h-3.5"
                                    />
                                    Prep
                                  </label>
                                )}
                              </div>
                            </div>

                            {/* Row 4 (mobile) / Side column (sm+): Action buttons */}
                            <div className="flex flex-row gap-2 mt-2.5 sm:flex-col sm:gap-1 sm:ml-3 sm:mt-0 shrink-0">
                              {!meal.completed_at ? (
                                <>
                                  {meal.meal_prep ? (
                                    /* Prep meals: single "Execute" button — same RPC, no separate Mark Done */
                                    <button
                                      onClick={() => markDoneMutation.mutate(meal.meal_id)}
                                      data-testid={`exec-prep-${meal.meal_id}`}
                                      className="px-3 py-1 bg-violet-600 text-white rounded text-xs font-semibold whitespace-nowrap hover:bg-violet-700 transition-colors"
                                    >
                                      Execute
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => markDoneMutation.mutate(meal.meal_id)}
                                      data-testid={`mark-done-${meal.meal_id}`}
                                      className="px-3 py-1 bg-success text-white rounded text-xs font-semibold whitespace-nowrap hover:bg-success-hover transition-colors"
                                    >
                                      Mark Done
                                    </button>
                                  )}
                                </>
                              ) : (
                                <button
                                  onClick={() => unmarkDoneMutation.mutate(meal.meal_id)}
                                  data-testid={`undo-done-${meal.meal_id}`}
                                  className="px-3 py-1 bg-surface text-amber-500 border border-amber-500 rounded text-xs font-semibold whitespace-nowrap hover:bg-warning-subtle transition-colors"
                                >
                                  Undo
                                </button>
                              )}
                              <DeleteBtn
                                id={`meal-${meal.meal_id}`}
                                onConfirm={async () => {
                                  deleteMealMutation.mutate(meal.meal_id);
                                }}
                                testId={`delete-meal-${meal.meal_id}`}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {/* TOTAL macros row */}
                    <div
                      data-testid="day-detail-total-row"
                      className="bg-surface-sunken border border-border rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1"
                    >
                      <span className="font-bold text-sm text-text">TOTAL</span>
                      <span className="text-sm text-text-secondary font-semibold">
                        {dayTotals.calories} cal | {dayTotals.protein}g P | {dayTotals.carbs}g C | {dayTotals.fat}g F
                      </span>
                    </div>

                    {/* VS GOAL row — audit fix.
                       Shows headroom (under/over) per macro by reading
                       user_config goals. Negative = over goal (red).
                       Pure UI work — pulls already-fetched goals data. */}
                    {goals && (
                      <div
                        data-testid="day-detail-vs-goal-row"
                        className="bg-surface border border-border rounded-lg px-4 py-2 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1 text-xs"
                      >
                        <span className="font-semibold text-text-tertiary uppercase tracking-wide">vs goal</span>
                        <span
                          data-testid="day-detail-vs-goal-values"
                          className="font-semibold tabular-nums flex flex-wrap gap-x-3"
                        >
                          {(() => {
                            // R2 audit #1: sign convention matches every
                            // mainstream fitness app — `consumed - goal`
                            // (delta). Visual treatment differs by macro:
                            //   - calories/carbs/fat: under (negative) is
                            //     good, over (positive) is warning.
                            //   - protein: most users WANT to hit the
                            //     number, so being under is "still need
                            //     more" (warning), at-or-over is good.
                            // The pure helper `vsGoalDeltaParts` returns
                            // {sign, abs, kind} so the formatter only
                            // chooses class names.
                            const fmt = (
                              consumed: number,
                              goal: number,
                              suffix: string,
                              opts: { underIsGood: boolean },
                            ) => {
                              const { sign, abs, kind } = vsGoalDeltaParts(consumed, goal);
                              const cls = opts.underIsGood
                                ? kind === 'over'
                                  ? 'text-danger-text'
                                  : 'text-success-text'
                                : kind === 'under'
                                  ? 'text-amber-600'
                                  : 'text-success-text';
                              return (
                                <span className={cls}>
                                  {sign}
                                  {abs}
                                  {suffix}
                                </span>
                              );
                            };
                            return (
                              <>
                                {fmt(dayTotals.calories, goals.calories, ' cal', { underIsGood: true })}
                                {fmt(dayTotals.protein, goals.protein, 'g P', { underIsGood: false })}
                                {fmt(dayTotals.carbs, goals.carbs, 'g C', { underIsGood: true })}
                                {fmt(dayTotals.fat, goals.fat, 'g F', { underIsGood: true })}
                              </>
                            );
                          })()}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* close Planned Meals wrapper */}

              {/* ------- Consumed Items Section ------- */}
              {(selectedDayLogs.length > 0 || selectedDayTemps.length > 0) && (
                <div
                  data-testid="consumed-section"
                  className="bg-success-subtle/50 border border-success rounded-lg overflow-hidden"
                >
                  <div className="px-4 py-2.5 bg-success-subtle/60 border-b border-success">
                    <h4 className="m-0 text-sm font-bold text-success-text uppercase tracking-wide">Consumed</h4>
                  </div>
                  <div className="flex flex-col gap-1.5 p-3">
                    {selectedDayLogs.map((log) => {
                      const delId = `log-${log.log_id}`;
                      const editKey = `log-${log.log_id}`;
                      const isEditing = editingId === editKey;
                      const isOptimistic = String(log.log_id).startsWith('optimistic-');
                      return (
                        <div
                          key={log.log_id}
                          data-testid={`consumed-log-${log.log_id}`}
                          className="py-2 px-3 border border-border border-l-4 border-l-success rounded-md bg-surface"
                        >
                          <div className="flex justify-between items-start gap-2">
                            <span className="font-semibold text-sm min-w-0">
                              {log.products?.name ?? 'Unknown'}
                              <span className="font-normal text-text-secondary text-xs ml-2">
                                {Number(log.qty_consumed)} {log.unit}
                                {Number(log.qty_consumed) !== 1 ? 's' : ''}
                              </span>
                            </span>
                            {!isEditing && (
                              <div className="flex gap-1 shrink-0">
                                {/* Edit qty wired into MealPlan Consumed (R2 #10).
                                   Hidden on optimistic seeded rows because they
                                   have no real log_id to send to the RPC. */}
                                {!isOptimistic && (
                                  <button
                                    onClick={() => startEditLog(log)}
                                    data-testid={`edit-log-${log.log_id}`}
                                    aria-label={`Edit qty for ${log.products?.name ?? 'log'}`}
                                    className="px-2.5 py-1 rounded text-xs font-semibold border border-border text-text-secondary hover:bg-surface-hover min-w-[44px] min-h-[44px] flex items-center justify-center"
                                  >
                                    Edit
                                  </button>
                                )}
                                <DeleteBtn
                                  id={delId}
                                  onConfirm={async () => {
                                    deleteFoodLogMutation.mutate(log.log_id);
                                  }}
                                  testId={`delete-log-${log.log_id}`}
                                />
                              </div>
                            )}
                          </div>
                          {isEditing && (
                            <div
                              data-testid={`edit-log-form-${log.log_id}`}
                              className="mt-2 flex items-center gap-2 flex-wrap"
                            >
                              <label className="text-xs text-text-tertiary">Qty ({log.unit ?? 'serving'})</label>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitEditLog(log);
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                data-testid={`edit-log-input-${log.log_id}`}
                                className="w-24 px-2 py-1 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                                autoFocus
                              />
                              <button
                                onClick={() => commitEditLog(log)}
                                data-testid={`edit-log-save-${log.log_id}`}
                                className="px-2.5 py-1 bg-success text-white rounded text-xs font-semibold hover:bg-success-hover"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                data-testid={`edit-log-cancel-${log.log_id}`}
                                className="px-2.5 py-1 bg-surface border border-border-strong text-text-secondary rounded text-xs font-semibold hover:bg-surface-hover"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                          <div className="text-xs text-text-secondary mt-1">
                            {Math.round(Number(log.calories))} cal | {Math.round(Number(log.protein))}g P |{' '}
                            {Math.round(Number(log.carbs))}g C | {Math.round(Number(log.fat))}g F
                          </div>
                        </div>
                      );
                    })}
                    {selectedDayTemps.map((item) => {
                      const delId = `temp-${item.temp_id}`;
                      const editKey = `temp-${item.temp_id}`;
                      const isEditing = editingId === editKey;
                      return (
                        <div
                          key={item.temp_id}
                          data-testid={`consumed-temp-${item.temp_id}`}
                          className="py-2 px-3 border border-border border-l-4 border-l-amber-500 rounded-md bg-surface"
                        >
                          <div className="flex justify-between items-start gap-2">
                            <span className="font-semibold text-sm min-w-0">
                              {item.name}
                              <span className="font-normal text-text-tertiary text-xs ml-1.5">quick-add</span>
                            </span>
                            {!isEditing && (
                              <div className="flex gap-1 shrink-0">
                                <button
                                  onClick={() => startEditTemp(item)}
                                  data-testid={`edit-temp-${item.temp_id}`}
                                  aria-label={`Edit calories for ${item.name}`}
                                  className="px-2.5 py-1 rounded text-xs font-semibold border border-border text-text-secondary hover:bg-surface-hover min-w-[44px] min-h-[44px] flex items-center justify-center"
                                >
                                  Edit
                                </button>
                                <DeleteBtn
                                  id={delId}
                                  onConfirm={async () => {
                                    deleteTempItemMutation.mutate(item.temp_id);
                                  }}
                                  testId={`delete-temp-${item.temp_id}`}
                                />
                              </div>
                            )}
                          </div>
                          {isEditing && (
                            <div
                              data-testid={`edit-temp-form-${item.temp_id}`}
                              className="mt-2 flex items-center gap-2 flex-wrap"
                            >
                              <label className="text-xs text-text-tertiary">Calories (kcal)</label>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitEditTemp(item);
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                data-testid={`edit-temp-input-${item.temp_id}`}
                                className="w-24 px-2 py-1 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
                                autoFocus
                              />
                              <button
                                onClick={() => commitEditTemp(item)}
                                data-testid={`edit-temp-save-${item.temp_id}`}
                                className="px-2.5 py-1 bg-success text-white rounded text-xs font-semibold hover:bg-success-hover"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                data-testid={`edit-temp-cancel-${item.temp_id}`}
                                className="px-2.5 py-1 bg-surface border border-border-strong text-text-secondary rounded text-xs font-semibold hover:bg-surface-hover"
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                          <div className="text-xs text-text-secondary mt-1">
                            {Math.round(Number(item.calories))} cal | {Math.round(Number(item.protein))}g P |{' '}
                            {Math.round(Number(item.carbs))}g C | {Math.round(Number(item.fat))}g F
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/*  ADD MEAL MODAL                                                */}
      {/* ============================================================ */}
      <ModalOverlay
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Meal"
        testId="add-meal-modal"
      >
        <div className="mb-3">
          <label className="block text-sm font-semibold mb-1 text-text-secondary">Date</label>
          <input
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            data-testid="add-meal-date"
            className={inputCls}
          />
        </div>
        <div className="mb-3 relative">
          <label className="block text-sm font-semibold mb-1 text-text-secondary">Search recipe or product</label>
          <input
            type="text"
            value={addSearchText}
            onChange={(e) => handleAddSearchInput(e.target.value)}
            data-testid="add-meal-search"
            placeholder="Type to search..."
            className={inputCls}
          />
          {addShowDropdown && (
            <div
              data-testid="add-meal-dropdown"
              className="absolute top-full left-0 right-0 bg-surface border border-border-strong rounded shadow-lg z-10 max-h-[200px] overflow-auto"
            >
              {addSearchResults.map((item) => (
                <div
                  key={`${item.type}-${item.id}`}
                  onClick={() => selectAddItem(item)}
                  data-testid={`add-dropdown-${item.type}-${item.id}`}
                  className="px-3 py-2 cursor-pointer hover:bg-surface-hover text-sm"
                >
                  {item.name} ({item.type})
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mb-3">
          <label className="block text-sm font-semibold mb-1 text-text-secondary">Servings</label>
          <input
            type="number"
            min={0}
            value={addServings}
            onChange={(e) => setAddServings(Number(e.target.value) || 1)}
            data-testid="add-meal-servings"
            className={inputCls}
          />
        </div>
        <div className="mb-3">
          <label className="block text-sm font-semibold mb-1 text-text-secondary">Meal Type</label>
          <select
            value={addMealType ?? ''}
            onChange={(e) => setAddMealType(e.target.value || null)}
            data-testid="add-meal-type-select"
            className={inputCls}
          >
            <option value="">Select type (optional)</option>
            <option value="breakfast">Breakfast</option>
            <option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option>
            <option value="snack">Snack</option>
          </select>
        </div>
        <div className="mb-3 flex items-center gap-2">
          <label className="text-sm text-text-secondary">Meal Prep</label>
          <input
            type="checkbox"
            checked={addMealPrep}
            onChange={(e) => setAddMealPrep(e.target.checked)}
            data-testid="add-meal-prep-toggle"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => setShowAddModal(false)}
            data-testid="add-meal-cancel"
            className="px-4 py-2 bg-surface-hover text-text-secondary rounded-md text-sm hover:bg-border transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => addMealMutation.mutate()}
            disabled={!addSelected}
            data-testid="add-meal-confirm"
            className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
