import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, escapeIlike } from '@/shared/supabase';
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

  /* ---- Meal prep confirmation modal state ---- */
  const [prepTarget, setPrepTarget] = useState<MealEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const userId = user?.id;

  const loadMeals = useCallback(async () => {
    if (!userId) return;

    const startDate = toDateStr(weekStart);
    const endDate = toDateStr(new Date(weekStart.getTime() + 6 * 86400000));

    const { data } = await chefbyte()
      .from('meal_plan_entries')
      .select(
        '*, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving)',
      )
      .eq('user_id', userId)
      .gte('logical_date', startDate)
      .lte('logical_date', endDate)
      .order('created_at');

    setMeals((data ?? []) as MealEntry[]);
    setLoading(false);
  }, [userId, weekStart]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case

    loadMeals();
  }, [loadMeals]);

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
    return mealsByDay.get(selectedDay) ?? [];
  }, [selectedDay, mealsByDay]);

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

  const executePrepConfirmed = async () => {
    if (!prepTarget) return;
    await markDone(prepTarget.meal_id);
    setPrepTarget(null);
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

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Meal Plan">
        <div style={{ padding: '20px' }} data-testid="mealplan-loading">
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
      <div
        data-testid="week-nav"
        style={{
          marginBottom: '16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1 style={{ margin: 0, fontSize: '1.4em' }}>Meal Plan</h1>
          <button
            onClick={openAddModal}
            data-testid="add-meal-btn"
            style={{
              padding: '6px 14px',
              background: '#2f9e44',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '13px',
            }}
          >
            + Add Meal
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={prevWeek}
            data-testid="prev-week-btn"
            style={{
              padding: '6px 12px',
              background: '#fff',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Prev
          </button>
          <button
            onClick={goToday}
            data-testid="today-btn"
            style={{
              padding: '6px 12px',
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '13px',
            }}
          >
            Today
          </button>
          <button
            onClick={nextWeek}
            data-testid="next-week-btn"
            style={{
              padding: '6px 12px',
              background: '#fff',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Next
          </button>
          <span
            data-testid="week-range"
            style={{ marginLeft: '8px', fontWeight: 'bold', fontSize: '13px', color: '#555' }}
          >
            {formatWeekRange(weekStart)}
          </span>
        </div>
      </div>

      {error && <p style={{ color: '#d33', margin: '0 0 12px' }}>{error}</p>}

      {/* ============================================================ */}
      {/*  SIDE-BY-SIDE LAYOUT                                          */}
      {/* ============================================================ */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        {/* ---------------------------------------------------------- */}
        {/*  LEFT PANEL — Compact week list                             */}
        {/* ---------------------------------------------------------- */}
        <div
          data-testid="week-grid"
          style={{
            width: '280px',
            minWidth: '280px',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            background: '#f0f0f0',
            borderRadius: '8px',
            overflow: 'hidden',
            border: '1px solid #ddd',
          }}
        >
          {dayDates.map((date, i) => {
            const dayMeals = mealsByDay.get(date) ?? [];
            const isSelected = selectedDay === date;
            const isToday = date === todayStr;
            const mealCount = dayMeals.length;

            return (
              <div
                key={date}
                data-testid={`day-col-${date}`}
                onClick={() => setSelectedDay(date)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  cursor: 'pointer',
                  background: isToday ? '#e8f4fd' : isSelected ? '#f5f5f5' : '#fff',
                  borderLeft: isSelected || isToday ? '3px solid #1e66f5' : '3px solid transparent',
                  transition: 'background 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span
                    style={{ fontWeight: 600, fontSize: '13px', color: isToday ? '#1e66f5' : '#333', minWidth: '30px' }}
                  >
                    {DAY_NAMES[i]}
                  </span>
                  <span style={{ fontSize: '13px', color: '#666' }}>{formatDateShort(date)}</span>
                  {isToday && (
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        color: '#1e66f5',
                        background: '#d0e8ff',
                        padding: '1px 6px',
                        borderRadius: '3px',
                      }}
                    >
                      TODAY
                    </span>
                  )}
                </div>
                {mealCount > 0 && (
                  <span style={{ fontSize: '12px', color: '#888' }}>
                    {mealCount} meal{mealCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* ---------------------------------------------------------- */}
        {/*  RIGHT PANEL — Selected day detail                          */}
        {/* ---------------------------------------------------------- */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selectedDay ? (
            <div
              style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: '#999',
                fontSize: '15px',
                background: '#fafafa',
                borderRadius: '8px',
                border: '1px solid #eee',
              }}
            >
              Select a day to view details
            </div>
          ) : (
            <div data-testid="day-detail">
              <h3 data-testid="day-detail-title" style={{ margin: '0 0 16px', fontSize: '1.1em', color: '#222' }}>
                {formatDateLong(selectedDay, selectedDayIndex)}
              </h3>

              {selectedDayMeals.length === 0 ? (
                <p data-testid="no-meals" style={{ color: '#888', fontSize: '14px' }}>
                  No meals planned. Click + Add Meal to get started.
                </p>
              ) : (
                <div data-testid="day-detail-table" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {selectedDayMeals.map((meal) => {
                    const macros = entryMacros(meal);
                    return (
                      <div
                        key={meal.meal_id}
                        data-testid={`detail-row-${meal.meal_id}`}
                        style={{
                          background: '#fff',
                          border: '1px solid #e8e8e8',
                          borderRadius: '8px',
                          padding: '14px 16px',
                        }}
                      >
                        {/* Also keep grid-meal testid for E2E compat */}
                        <div
                          data-testid={`grid-meal-${meal.meal_id}`}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {/* Name */}
                            <div style={{ fontWeight: 600, fontSize: '15px', color: '#111' }}>{entryName(meal)}</div>

                            {/* Meal type badge */}
                            {meal.meal_type && (
                              <span
                                data-testid={`meal-type-label-${meal.meal_id}`}
                                style={{
                                  display: 'inline-block',
                                  marginTop: '4px',
                                  fontSize: '11px',
                                  background: '#eee',
                                  padding: '2px 8px',
                                  borderRadius: '3px',
                                  textTransform: 'capitalize',
                                  color: '#555',
                                }}
                              >
                                {meal.meal_type}
                              </span>
                            )}

                            {/* Macros — text format, no emoji */}
                            {macros && (macros.calories > 0 || macros.protein > 0) && (
                              <div
                                data-testid={`grid-macros-${meal.meal_id}`}
                                style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}
                              >
                                {macros.calories}cal | {macros.protein}g P | {macros.carbs}g C | {macros.fat}g F
                              </div>
                            )}

                            {/* Status badges + mode */}
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                marginTop: '8px',
                                flexWrap: 'wrap',
                              }}
                            >
                              {meal.completed_at && (
                                <span
                                  data-testid={`done-badge-${meal.meal_id}`}
                                  style={{
                                    display: 'inline-block',
                                    fontSize: '11px',
                                    background: '#2f9e44',
                                    color: '#fff',
                                    padding: '2px 8px',
                                    borderRadius: '3px',
                                    fontWeight: 600,
                                  }}
                                >
                                  Done
                                </span>
                              )}
                              {meal.meal_prep && !meal.completed_at && (
                                <span
                                  data-testid={`prep-badge-${meal.meal_id}`}
                                  style={{
                                    display: 'inline-block',
                                    fontSize: '11px',
                                    background: '#6c5ce7',
                                    color: '#fff',
                                    padding: '2px 8px',
                                    borderRadius: '3px',
                                    fontWeight: 600,
                                  }}
                                >
                                  PREP
                                </span>
                              )}
                              {!meal.meal_prep && !meal.completed_at && (
                                <span style={{ fontSize: '11px', color: '#888' }}>Regular</span>
                              )}
                              {meal.completed_at && (
                                <span style={{ fontSize: '11px', color: '#888' }}>
                                  at {formatTime(meal.completed_at)}
                                </span>
                              )}
                              {/* Prep toggle (hidden label for accessibility) */}
                              {!meal.completed_at && (
                                <label
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '3px',
                                    fontSize: '11px',
                                    color: '#888',
                                    cursor: 'pointer',
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={meal.meal_prep}
                                    onChange={() => toggleMealPrep(meal)}
                                    disabled={!!meal.completed_at}
                                    aria-label={`Toggle meal prep for ${entryName(meal)}`}
                                    data-testid={`toggle-prep-${meal.meal_id}`}
                                    style={{ width: '13px', height: '13px' }}
                                  />
                                  Prep
                                </label>
                              )}
                            </div>
                          </div>

                          {/* Action buttons */}
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '4px',
                              marginLeft: '12px',
                              flexShrink: 0,
                            }}
                          >
                            {!meal.completed_at && (
                              <>
                                <button
                                  onClick={() => markDone(meal.meal_id)}
                                  data-testid={`mark-done-${meal.meal_id}`}
                                  style={{
                                    padding: '5px 12px',
                                    background: '#2f9e44',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    fontSize: '12px',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  Mark Done
                                </button>
                                {meal.meal_prep && (
                                  <button
                                    onClick={() => setPrepTarget(meal)}
                                    data-testid={`exec-prep-${meal.meal_id}`}
                                    style={{
                                      padding: '5px 12px',
                                      background: '#6c5ce7',
                                      color: '#fff',
                                      border: 'none',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      fontWeight: 600,
                                      fontSize: '12px',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    Execute Prep
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              onClick={() => deleteMeal(meal.meal_id)}
                              data-testid={`delete-meal-${meal.meal_id}`}
                              style={{
                                padding: '5px 12px',
                                background: 'transparent',
                                color: '#d33',
                                border: 'none',
                                cursor: 'pointer',
                                fontWeight: 600,
                                fontSize: '12px',
                                whiteSpace: 'nowrap',
                                textAlign: 'right',
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* TOTAL macros row */}
                  <div
                    data-testid="day-detail-total-row"
                    style={{
                      background: '#f7f7f9',
                      border: '1px solid #e0e0e0',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: '14px', color: '#222' }}>TOTAL</span>
                    <span style={{ fontSize: '14px', color: '#444', fontWeight: 600 }}>
                      {dayTotals.calories} cal | {dayTotals.protein}g P | {dayTotals.carbs}g C | {dayTotals.fat}g F
                    </span>
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
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Date</label>
          <input
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            data-testid="add-meal-date"
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ccc',
              borderRadius: '6px',
              fontSize: '14px',
            }}
          />
        </div>
        <div style={{ marginBottom: '12px', position: 'relative' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>
            Search recipe or product
          </label>
          <input
            type="text"
            value={addSearchText}
            onChange={(e) => handleAddSearchInput(e.target.value)}
            data-testid="add-meal-search"
            placeholder="Type to search..."
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ccc',
              borderRadius: '6px',
              fontSize: '14px',
            }}
          />
          {addShowDropdown && (
            <div
              data-testid="add-meal-dropdown"
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: '#fff',
                border: '1px solid #ccc',
                borderRadius: '4px',
                zIndex: 10,
                maxHeight: '200px',
                overflow: 'auto',
              }}
            >
              {addSearchResults.map((item) => (
                <div
                  key={`${item.type}-${item.id}`}
                  onClick={() => selectAddItem(item)}
                  data-testid={`add-dropdown-${item.type}-${item.id}`}
                  style={{ padding: '8px 12px', cursor: 'pointer' }}
                >
                  {item.name} ({item.type})
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Servings</label>
          <input
            type="number"
            min={0}
            value={addServings}
            onChange={(e) => setAddServings(Number(e.target.value) || 1)}
            data-testid="add-meal-servings"
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ccc',
              borderRadius: '6px',
              fontSize: '14px',
            }}
          />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Meal Type</label>
          <select
            value={addMealType ?? ''}
            onChange={(e) => setAddMealType(e.target.value || null)}
            data-testid="add-meal-type-select"
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #ccc',
              borderRadius: '6px',
              fontSize: '14px',
              background: '#fff',
            }}
          >
            <option value="">Select type (optional)</option>
            <option value="breakfast">Breakfast</option>
            <option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option>
            <option value="snack">Snack</option>
          </select>
        </div>
        <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label>Meal Prep</label>
          <input
            type="checkbox"
            checked={addMealPrep}
            onChange={(e) => setAddMealPrep(e.target.checked)}
            data-testid="add-meal-prep-toggle"
          />
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => setShowAddModal(false)}
            data-testid="add-meal-cancel"
            style={{ padding: '8px 16px', background: '#eee', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={addMeal}
            disabled={!addSelected}
            data-testid="add-meal-confirm"
            style={{
              padding: '8px 16px',
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Add
          </button>
        </div>
      </ModalOverlay>

      {/* ============================================================ */}
      {/*  MEAL PREP CONFIRMATION MODAL                                  */}
      {/* ============================================================ */}
      <ModalOverlay
        isOpen={prepTarget !== null}
        onClose={() => setPrepTarget(null)}
        title="Execute Meal Prep"
        maxWidth="450px"
        testId="prep-confirm-modal"
      >
        <p>This will consume ingredients and create a [MEAL] lot.</p>
        {prepTarget && (
          <p style={{ fontWeight: 'bold', margin: '12px 0' }}>
            {entryName(prepTarget)} &mdash; {Number(prepTarget.servings).toFixed(1)} servings
          </p>
        )}
        <p style={{ fontSize: '0.85em', color: '#666' }}>Macros will not be logged until the [MEAL] lot is consumed.</p>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button
            onClick={() => setPrepTarget(null)}
            data-testid="prep-cancel-btn"
            style={{ padding: '8px 16px', background: '#eee', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={executePrepConfirmed}
            data-testid="prep-execute-btn"
            style={{
              padding: '8px 16px',
              background: '#6c5ce7',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Execute
          </button>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
