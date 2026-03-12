import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, supabase, escapeIlike } from '@/shared/supabase';
import { toDateStr } from '@/shared/dates';
import { computeRecipeMacros } from './RecipesPage';

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
  const [loading, setLoading] = useState(true);
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [meals, setMeals] = useState<MealEntry[]>([]);
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

  /* ---- Consumed items (food_logs + temp_items) ---- */
  const [foodLogs, setFoodLogs] = useState<FoodLogEntry[]>([]);
  const [tempItems, setTempItems] = useState<TempItemEntry[]>([]);

  /* ---- Two-click delete confirmation ---- */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const userId = user?.id;

  const loadMeals = useCallback(async () => {
    if (!userId) return;

    const startDate = toDateStr(weekStart);
    const endDate = toDateStr(new Date(weekStart.getTime() + 6 * 86400000));

    const [mealsRes, logRes, tempRes] = await Promise.all([
      chefbyte()
        .from('meal_plan_entries')
        .select(
          '*, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving)',
        )
        .eq('user_id', userId)
        .gte('logical_date', startDate)
        .lte('logical_date', endDate)
        .order('created_at'),
      chefbyte()
        .from('food_logs')
        .select('log_id, logical_date, qty_consumed, unit, calories, protein, carbs, fat, products:product_id(name)')
        .eq('user_id', userId)
        .gte('logical_date', startDate)
        .lte('logical_date', endDate)
        .order('created_at'),
      chefbyte()
        .from('temp_items')
        .select('temp_id, logical_date, name, calories, protein, carbs, fat')
        .eq('user_id', userId)
        .gte('logical_date', startDate)
        .lte('logical_date', endDate)
        .order('created_at'),
    ]);

    if (mealsRes.error) {
      setError(mealsRes.error.message);
      setLoading(false);
      return;
    }

    setMeals((mealsRes.data ?? []) as MealEntry[]);
    setFoodLogs((logRes.data ?? []) as FoodLogEntry[]);
    setTempItems((tempRes.data ?? []) as TempItemEntry[]);
    setLoading(false);
  }, [userId, weekStart]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case

    loadMeals();
  }, [loadMeals]);

  /* ---------------------------------------------------------------- */
  /*  Realtime subscriptions                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('mealplan-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'chefbyte', table: 'meal_plan_entries', filter: `user_id=eq.${user.id}` },
        () => loadMeals(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'chefbyte', table: 'food_logs', filter: `user_id=eq.${user.id}` },
        () => loadMeals(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'chefbyte', table: 'temp_items', filter: `user_id=eq.${user.id}` },
        () => loadMeals(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, loadMeals]);

  /* ---------------------------------------------------------------- */
  /*  Auto-select today on initial load                                */
  /* ---------------------------------------------------------------- */

  const todayStr = toDateStr(new Date());

  useEffect(() => {
    if (!loading && selectedDay === null) {
      // Auto-select today if it's in the current week
      const startDate = toDateStr(weekStart);
      const endDate = toDateStr(new Date(weekStart.getTime() + 6 * 86400000));
      if (todayStr >= startDate && todayStr <= endDate) {
        setSelectedDay(todayStr);
      }
    }
    // Only run when loading finishes, not on every todayStr change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

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
    for (const meal of meals) {
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
    return foodLogs.filter((l) => l.logical_date === selectedDay);
  }, [selectedDay, foodLogs]);

  const selectedDayTemps = useMemo(() => {
    if (!selectedDay) return [];
    return tempItems.filter((t) => t.logical_date === selectedDay);
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
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const markDone = async (mealId: string) => {
    setError(null);
    const { error: rpcErr } = await (chefbyte() as any).rpc('mark_meal_done', { p_meal_id: mealId });
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    await loadMeals();
  };

  const unmarkDone = async (mealId: string) => {
    setError(null);
    const { error: rpcErr } = await (chefbyte() as any).rpc('unmark_meal_done', { p_meal_id: mealId });
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    await loadMeals();
  };

  const deleteMeal = async (mealId: string) => {
    setError(null);
    const { error: deleteErr } = await chefbyte().from('meal_plan_entries').delete().eq('meal_id', mealId);
    if (deleteErr) {
      setError(deleteErr.message);
      return;
    }
    await loadMeals();
  };

  const toggleMealPrep = async (meal: MealEntry) => {
    setError(null);
    const { error: updateErr } = await chefbyte()
      .from('meal_plan_entries')
      .update({ meal_prep: !meal.meal_prep })
      .eq('meal_id', meal.meal_id);
    if (updateErr) {
      setError(updateErr.message);
      return;
    }
    await loadMeals();
  };

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

  const deleteFoodLog = async (logId: string) => {
    await chefbyte().from('food_logs').delete().eq('log_id', logId);
    await loadMeals();
  };

  const deleteTempItem = async (tempId: string) => {
    await chefbyte().from('temp_items').delete().eq('temp_id', tempId);
    await loadMeals();
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
    setAddMealType(null);
    setAddShowDropdown(false);
    // Default date: selected day or today
    setAddDate(selectedDay || todayStr);
    setShowAddModal(true);
  };

  const addMeal = async () => {
    if (!user || !addSelected || !addDate) return;

    setError(null);
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
    if (insertErr) {
      setError(insertErr.message);
      return;
    }

    // If the added date is in the current week and we don't have a day selected, select it
    if (!selectedDay) {
      setSelectedDay(addDate);
    }

    setShowAddModal(false);
    await loadMeals();
  };

  /* Helper: two-click delete button */
  const DeleteBtn = ({ id, onConfirm, testId }: { id: string; onConfirm: () => Promise<void>; testId: string }) => (
    <button
      onClick={() => handleDelete(id, onConfirm)}
      data-testid={testId}
      className={[
        'px-2.5 py-1 rounded text-xs font-semibold whitespace-nowrap transition-colors',
        confirmDeleteId === id
          ? 'bg-red-600 text-white border-none'
          : 'bg-transparent text-red-600 border border-red-600 hover:bg-red-50',
      ].join(' ')}
    >
      {confirmDeleteId === id ? 'You sure?' : 'Delete'}
    </button>
  );

  const inputCls =
    'w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500';

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Meal Plan">
        <div className="p-5" data-testid="mealplan-loading">
          Loading meal plan...
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
          <h1 className="m-0 text-xl font-bold text-slate-900">Meal Plan</h1>
          <button
            onClick={openAddModal}
            data-testid="add-meal-btn"
            className="px-3.5 py-1.5 bg-emerald-600 text-white rounded-md font-semibold text-xs hover:bg-emerald-700 transition-colors"
          >
            + Add Meal
          </button>
        </div>
        <div className="flex gap-1.5 items-center flex-wrap">
          <button
            onClick={prevWeek}
            data-testid="prev-week-btn"
            className="px-3 py-1.5 bg-white border border-slate-300 rounded-md text-xs hover:bg-slate-50 transition-colors"
          >
            Prev
          </button>
          <button
            onClick={goToday}
            data-testid="today-btn"
            className="px-3 py-1.5 bg-emerald-600 text-white rounded-md font-semibold text-xs hover:bg-emerald-700 transition-colors"
          >
            Today
          </button>
          <button
            onClick={nextWeek}
            data-testid="next-week-btn"
            className="px-3 py-1.5 bg-white border border-slate-300 rounded-md text-xs hover:bg-slate-50 transition-colors"
          >
            Next
          </button>
          <span data-testid="week-range" className="ml-2 font-bold text-xs text-slate-500">
            {formatWeekRange(weekStart)}
          </span>
        </div>
      </div>

      {error && <p className="text-red-600 m-0 mb-3">{error}</p>}

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
                    ? 'bg-emerald-600 text-white'
                    : isToday
                      ? 'bg-emerald-50 text-emerald-700 ring-2 ring-emerald-300'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
                ].join(' ')}
              >
                <span className="font-bold text-xs">{DAY_NAMES[i]}</span>
                <span className={['text-[11px] mt-0.5', isSelected ? 'text-white/80' : 'text-slate-500'].join(' ')}>
                  {formatDateShort(date)}
                </span>
                {mealCount > 0 && (
                  <span
                    className={['mt-1 w-1.5 h-1.5 rounded-full', isSelected ? 'bg-white' : 'bg-emerald-500'].join(' ')}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Desktop: vertical week list */}
        <div className="hidden md:flex w-[280px] min-w-[280px] flex-col gap-0.5 bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
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
                    ? 'bg-emerald-50 border-l-emerald-600'
                    : isSelected
                      ? 'bg-slate-50 border-l-emerald-600'
                      : 'bg-white border-l-transparent hover:bg-slate-50',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      'font-semibold text-xs min-w-[30px]',
                      isToday ? 'text-emerald-600' : 'text-slate-700',
                    ].join(' ')}
                  >
                    {DAY_NAMES[i]}
                  </span>
                  <span className="text-xs text-slate-500">{formatDateShort(date)}</span>
                  {isToday && (
                    <span className="text-[10px] font-bold text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded">
                      TODAY
                    </span>
                  )}
                </div>
                {mealCount > 0 && (
                  <span className="text-xs text-slate-400">
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
            <div className="py-10 px-5 text-center text-slate-400 text-sm bg-slate-50 rounded-lg border border-slate-200">
              Select a day to view details
            </div>
          ) : (
            <div data-testid="day-detail">
              <h3 data-testid="day-detail-title" className="m-0 mb-4 text-base font-semibold text-slate-800">
                {formatDateLong(selectedDay, selectedDayIndex)}
              </h3>

              {/* ------- Planned Meals Section ------- */}
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden mb-4">
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                  <h4 className="m-0 text-sm font-bold text-slate-700 uppercase tracking-wide">Planned Meals</h4>
                </div>

                {selectedDayMeals.length === 0 ? (
                  <p data-testid="no-meals" className="text-slate-400 text-sm px-4 py-5 text-center m-0">
                    No meals planned for this day. Use the{' '}
                    <button
                      type="button"
                      onClick={openAddModal}
                      className="text-emerald-600 font-medium hover:underline bg-transparent border-none cursor-pointer p-0 text-sm"
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
                          className="bg-white border border-slate-200 rounded-lg p-3.5"
                        >
                          <div
                            data-testid={`grid-meal-${meal.meal_id}`}
                            className="flex flex-col sm:flex-row sm:justify-between sm:items-start"
                          >
                            <div className="flex-1 min-w-0">
                              {/* Row 1: Meal name + type badge */}
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="font-semibold text-[15px] text-slate-900">{entryName(meal)}</div>
                                {meal.meal_type && (
                                  <span
                                    data-testid={`meal-type-label-${meal.meal_id}`}
                                    className="inline-block text-[11px] bg-slate-200 px-2 py-0.5 rounded text-slate-600 capitalize"
                                  >
                                    {meal.meal_type}
                                  </span>
                                )}
                              </div>

                              {/* Row 2: Macros */}
                              {macros && (macros.calories > 0 || macros.protein > 0) && (
                                <div
                                  data-testid={`grid-macros-${meal.meal_id}`}
                                  className="text-xs text-slate-500 mt-1.5"
                                >
                                  {macros.calories}cal | {macros.protein}g P | {macros.carbs}g C | {macros.fat}g F
                                </div>
                              )}

                              {/* Row 3: Status badges + prep checkbox */}
                              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                                {meal.completed_at && (
                                  <span
                                    data-testid={`done-badge-${meal.meal_id}`}
                                    className="inline-block text-[11px] bg-green-600 text-white px-2 py-0.5 rounded font-semibold"
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
                                  <span className="text-[11px] text-slate-400">Regular</span>
                                )}
                                {meal.completed_at && (
                                  <span className="text-[11px] text-slate-400">at {formatTime(meal.completed_at)}</span>
                                )}
                                {!meal.completed_at && (
                                  <label className="inline-flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={meal.meal_prep}
                                      onChange={() => toggleMealPrep(meal)}
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
                                    onClick={() => markDone(meal.meal_id)}
                                    data-testid={`mark-done-${meal.meal_id}`}
                                    className="px-3 py-1 bg-green-600 text-white rounded text-xs font-semibold whitespace-nowrap hover:bg-green-700 transition-colors"
                                  >
                                    Mark Done
                                  </button>
                                  {meal.meal_prep && (
                                    <button
                                      onClick={() => markDone(meal.meal_id)}
                                      data-testid={`exec-prep-${meal.meal_id}`}
                                      className="px-3 py-1 bg-violet-600 text-white rounded text-xs font-semibold whitespace-nowrap hover:bg-violet-700 transition-colors"
                                    >
                                      Execute Prep
                                    </button>
                                  )}
                                </>
                              ) : (
                                <button
                                  onClick={() => unmarkDone(meal.meal_id)}
                                  data-testid={`undo-done-${meal.meal_id}`}
                                  className="px-3 py-1 bg-white text-amber-500 border border-amber-500 rounded text-xs font-semibold whitespace-nowrap hover:bg-amber-50 transition-colors"
                                >
                                  Undo
                                </button>
                              )}
                              <DeleteBtn
                                id={`meal-${meal.meal_id}`}
                                onConfirm={() => deleteMeal(meal.meal_id)}
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
                      className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1"
                    >
                      <span className="font-bold text-sm text-slate-800">TOTAL</span>
                      <span className="text-sm text-slate-600 font-semibold">
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
                  className="bg-green-50/50 border border-green-200 rounded-lg overflow-hidden"
                >
                  <div className="px-4 py-2.5 bg-green-100/60 border-b border-green-200">
                    <h4 className="m-0 text-sm font-bold text-green-800 uppercase tracking-wide">Consumed</h4>
                  </div>
                  <div className="flex flex-col gap-1.5 p-3">
                    {selectedDayLogs.map((log) => {
                      const delId = `log-${log.log_id}`;
                      return (
                        <div
                          key={log.log_id}
                          data-testid={`consumed-log-${log.log_id}`}
                          className="py-2 px-3 border border-slate-200 border-l-4 border-l-green-500 rounded-md bg-white"
                        >
                          <div className="flex justify-between items-start gap-2">
                            <span className="font-semibold text-sm min-w-0">
                              {log.products?.name ?? 'Unknown'}
                              <span className="font-normal text-slate-500 text-xs ml-2">
                                {Number(log.qty_consumed)} {log.unit}
                                {Number(log.qty_consumed) !== 1 ? 's' : ''}
                              </span>
                            </span>
                            <DeleteBtn
                              id={delId}
                              onConfirm={() => deleteFoodLog(log.log_id)}
                              testId={`delete-log-${log.log_id}`}
                            />
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
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
                          className="py-2 px-3 border border-slate-200 border-l-4 border-l-amber-500 rounded-md bg-white"
                        >
                          <div className="flex justify-between items-start gap-2">
                            <span className="font-semibold text-sm min-w-0">
                              {item.name}
                              <span className="font-normal text-slate-400 text-xs ml-1.5">quick-add</span>
                            </span>
                            <DeleteBtn
                              id={delId}
                              onConfirm={() => deleteTempItem(item.temp_id)}
                              testId={`delete-temp-${item.temp_id}`}
                            />
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
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
          <label className="block text-sm font-semibold mb-1 text-slate-700">Date</label>
          <input
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            data-testid="add-meal-date"
            className={inputCls}
          />
        </div>
        <div className="mb-3 relative">
          <label className="block text-sm font-semibold mb-1 text-slate-700">Search recipe or product</label>
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
              className="absolute top-full left-0 right-0 bg-white border border-slate-300 rounded shadow-lg z-10 max-h-[200px] overflow-auto"
            >
              {addSearchResults.map((item) => (
                <div
                  key={`${item.type}-${item.id}`}
                  onClick={() => selectAddItem(item)}
                  data-testid={`add-dropdown-${item.type}-${item.id}`}
                  className="px-3 py-2 cursor-pointer hover:bg-slate-50 text-sm"
                >
                  {item.name} ({item.type})
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mb-3">
          <label className="block text-sm font-semibold mb-1 text-slate-700">Servings</label>
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
          <label className="block text-sm font-semibold mb-1 text-slate-700">Meal Type</label>
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
          <label className="text-sm text-slate-700">Meal Prep</label>
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
            className="px-4 py-2 bg-slate-100 text-slate-600 rounded-md text-sm hover:bg-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={addMeal}
            disabled={!addSelected}
            data-testid="add-meal-confirm"
            className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
