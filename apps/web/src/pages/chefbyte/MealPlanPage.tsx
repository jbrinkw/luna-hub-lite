import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, escapeIlike } from '@/shared/supabase';
import { toDateStr } from '@/shared/dates';
import { computeRecipeMacros } from './RecipesPage';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

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

/* ================================================================== */
/*  MealPlanPage                                                       */
/* ================================================================== */

export function MealPlanPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
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

  const todayStr = toDateStr(new Date());

  useEffect(() => {
    if (!isLoading && selectedDay === null) {
      if (todayStr >= startDate && todayStr <= endDate) {
        setSelectedDay(todayStr);
      }
    }
    // Only run when loading finishes, not on every todayStr change
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
    setWeekStart(getMonday(new Date()));
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
      const { error: rpcErr } = await (chefbyte() as any).rpc('mark_meal_done', { p_meal_id: mealId });
      if (rpcErr) throw new Error(rpcErr.message);
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => invalidateMealPlan(),
  });

  const unmarkDoneMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { error: rpcErr } = await (chefbyte() as any).rpc('unmark_meal_done', { p_meal_id: mealId });
      if (rpcErr) throw new Error(rpcErr.message);
    },
    onError: (err: Error) => setError(err.message),
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

  const handleDelete = (id: string, doDelete: () => Promise<void>) => {
    if (confirmDeleteId === id) {
      setConfirmDeleteId(null);
      doDelete();
    } else {
      setConfirmDeleteId(id);
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
    setAddMealType(null);
    setAddShowDropdown(false);
    // Default date: selected day or today
    setAddDate(selectedDay || todayStr);
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

  /* Compute totals for the selected day */
  const dayTotals = selectedDayMeals.reduce(
    (acc, meal) => {
      const m = entryMacros(meal);
      if (m) {
        acc.calories += m.calories;
        acc.protein += m.protein;
        acc.carbs += m.carbs;
        acc.fat += m.fat;
      }
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

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
            const isToday = date === todayStr;
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
            const isToday = date === todayStr;
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
                                  <button
                                    onClick={() => markDoneMutation.mutate(meal.meal_id)}
                                    data-testid={`mark-done-${meal.meal_id}`}
                                    className="px-3 py-1 bg-success text-white rounded text-xs font-semibold whitespace-nowrap hover:bg-success-hover transition-colors"
                                  >
                                    Mark Done
                                  </button>
                                  {meal.meal_prep && (
                                    <button
                                      onClick={() => markDoneMutation.mutate(meal.meal_id)}
                                      data-testid={`exec-prep-${meal.meal_id}`}
                                      className="px-3 py-1 bg-violet-600 text-white rounded text-xs font-semibold whitespace-nowrap hover:bg-violet-700 transition-colors"
                                    >
                                      Execute Prep
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
                            <DeleteBtn
                              id={delId}
                              onConfirm={async () => {
                                deleteFoodLogMutation.mutate(log.log_id);
                              }}
                              testId={`delete-log-${log.log_id}`}
                            />
                          </div>
                          <div className="text-xs text-text-secondary mt-1">
                            {Math.round(Number(log.calories))} cal | {Math.round(Number(log.protein))}g P |{' '}
                            {Math.round(Number(log.carbs))}g C | {Math.round(Number(log.fat))}g F
                          </div>
                        </div>
                      );
                    })}
                    {selectedDayTemps.map((item) => {
                      const delId = `temp-${item.temp_id}`;
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
                            <DeleteBtn
                              id={delId}
                              onConfirm={async () => {
                                deleteTempItemMutation.mutate(item.temp_id);
                              }}
                              testId={`delete-temp-${item.temp_id}`}
                            />
                          </div>
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
