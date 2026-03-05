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

function formatWeekRange(monday: Date): string {
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${fmt(monday)} \u2014 ${fmt(sunday)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMeals();
  }, [loadMeals]);

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

  const todayStr = toDateStr(new Date());

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
    setShowAddModal(true);
  };

  const addMeal = async () => {
    if (!user || !addSelected || !selectedDay) return;

    setError(null);
    const { error: insertErr } = await chefbyte()
      .from('meal_plan_entries')
      .insert({
        user_id: user.id,
        recipe_id: addSelected.type === 'recipe' ? addSelected.id : null,
        product_id: addSelected.type === 'product' ? addSelected.id : null,
        logical_date: selectedDay,
        servings: addServings,
        meal_prep: addMealPrep,
        meal_type: addMealType,
      });
    if (insertErr) {
      setError(insertErr.message);
      return;
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

  return (
    <ChefLayout title="Meal Plan">
      {/* ============================================================ */}
      {/*  HEADER                                                       */}
      {/* ============================================================ */}
      <div
        style={{
          marginBottom: '20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <h1 style={{ margin: 0 }}>Meal Plan</h1>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={openAddModal}
            disabled={!selectedDay}
            data-testid="add-meal-btn"
            style={{
              padding: '8px 16px',
              background: '#2f9e44',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Add Meal
          </button>
          <button
            onClick={prevWeek}
            data-testid="prev-week-btn"
            style={{
              padding: '8px 16px',
              background: '#fff',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Previous
          </button>
          <button
            onClick={goToday}
            data-testid="today-btn"
            style={{
              padding: '8px 16px',
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Today
          </button>
          <button
            onClick={nextWeek}
            data-testid="next-week-btn"
            style={{
              padding: '8px 16px',
              background: '#fff',
              border: '1px solid #ddd',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Next
          </button>
        </div>
      </div>

      {error && <p style={{ color: '#d33', margin: '0 0 12px' }}>{error}</p>}

      <span
        data-testid="week-range"
        style={{ display: 'block', marginBottom: '12px', fontWeight: 'bold', fontSize: '14px', color: '#555' }}
      >
        {formatWeekRange(weekStart)}
      </span>

      {/* ============================================================ */}
      {/*  7-DAY GRID                                                   */}
      {/* ============================================================ */}
      <div data-testid="week-grid" className="week-grid" style={{ marginBottom: '16px' }}>
        {dayDates.map((date, i) => {
          const dayMeals = mealsByDay.get(date) ?? [];
          const isSelected = selectedDay === date;
          const isToday = date === todayStr;

          return (
            <div
              key={date}
              data-testid={`day-col-${date}`}
              onClick={() => setSelectedDay(date)}
              style={{
                background: isToday ? '#e8f4fd' : '#fff',
                border: isToday ? '2px solid #1e66f5' : isSelected ? '2px solid #1e66f5' : '1px solid #ddd',
                borderRadius: '8px',
                padding: '12px',
                cursor: 'pointer',
                minHeight: '200px',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: '12px',
                  paddingBottom: '8px',
                  borderBottom: '1px solid #eee',
                  color: isToday ? '#1e66f5' : '#111',
                }}
              >
                <div>{DAY_NAMES[i]}</div>
                <div>
                  {new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                {isToday && <div style={{ fontSize: '0.8em', color: '#1890ff', fontWeight: 'bold' }}>TODAY</div>}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
                {dayMeals.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#999', fontSize: '13px', padding: '20px 0' }}>
                    No meals planned
                  </div>
                )}
                {dayMeals.map((meal) => {
                  const macros = entryMacros(meal);
                  return (
                    <div
                      key={meal.meal_id}
                      data-testid={`grid-meal-${meal.meal_id}`}
                      style={{
                        background: '#f7f7f9',
                        padding: '8px',
                        borderRadius: '6px',
                        fontSize: '13px',
                        border: '1px solid #eee',
                        position: 'relative',
                      }}
                    >
                      <div style={{ paddingRight: '20px' }}>
                        <div style={{ fontWeight: 600, lineHeight: '1.2' }}>{entryName(meal)}</div>
                        {meal.meal_type && (
                          <div
                            data-testid={`meal-type-label-${meal.meal_id}`}
                            style={{ fontSize: '11px', color: '#666', marginTop: '2px' }}
                          >
                            <span
                              style={{
                                background: '#eee',
                                padding: '1px 4px',
                                borderRadius: '3px',
                                textTransform: 'capitalize',
                              }}
                            >
                              {meal.meal_type}
                            </span>
                          </div>
                        )}
                        {meal.completed_at && (
                          <span
                            data-testid={`done-badge-${meal.meal_id}`}
                            style={{
                              display: 'inline-block',
                              marginTop: '4px',
                              fontSize: '10px',
                              background: '#2f9e44',
                              color: '#fff',
                              padding: '1px 6px',
                              borderRadius: '3px',
                            }}
                          >
                            done
                          </span>
                        )}
                        {meal.meal_prep && !meal.completed_at && (
                          <span
                            data-testid={`prep-badge-${meal.meal_id}`}
                            style={{
                              display: 'inline-block',
                              marginTop: '4px',
                              fontSize: '10px',
                              background: '#6c5ce7',
                              color: '#fff',
                              padding: '1px 6px',
                              borderRadius: '3px',
                            }}
                          >
                            PREP
                          </span>
                        )}
                      </div>

                      {macros && (macros.calories > 0 || macros.protein > 0) && (
                        <div
                          data-testid={`grid-macros-${meal.meal_id}`}
                          style={{
                            fontSize: '11px',
                            color: '#555',
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '6px',
                            marginTop: '2px',
                          }}
                        >
                          <span>
                            {'\ud83d\udd25'}
                            {macros.calories}
                          </span>
                          <span>
                            {'\ud83e\udea9'}
                            {macros.protein}
                          </span>
                          <span>
                            {'\ud83c\udf5e'}
                            {macros.carbs}
                          </span>
                          <span>
                            {'\ud83e\udd51'}
                            {macros.fat}
                          </span>
                        </div>
                      )}

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteMeal(meal.meal_id);
                        }}
                        data-testid={`delete-meal-${meal.meal_id}`}
                        title="Remove"
                        style={{
                          position: 'absolute',
                          top: '4px',
                          right: '4px',
                          padding: '2px 6px',
                          background: '#d33',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          opacity: 0.8,
                        }}
                      >
                        {'\u00d7'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* ============================================================ */}
      {/*  DAY DETAIL TABLE                                              */}
      {/* ============================================================ */}
      {selectedDay && (
        <div data-testid="day-detail">
          <h3 data-testid="day-detail-title">
            {DAY_NAMES[dayDates.indexOf(selectedDay)]} {new Date(selectedDay + 'T00:00:00').getDate()} Detail
          </h3>

          {selectedDayMeals.length === 0 ? (
            <p data-testid="no-meals">No meals planned for this day.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="day-detail-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Entry</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Type</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Mode</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {selectedDayMeals.map((meal) => {
                  const macros = entryMacros(meal);
                  return (
                    <tr key={meal.meal_id} data-testid={`detail-row-${meal.meal_id}`}>
                      <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                        <div>{entryName(meal)}</div>
                        {macros && (
                          <div style={{ fontSize: '0.8em', color: '#888' }}>
                            {macros.calories} cal | {macros.protein}g P | {macros.carbs}g C | {macros.fat}g F
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #eee', textTransform: 'capitalize' }}>
                        {meal.meal_type ?? '\u2014'}
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <input
                            type="checkbox"
                            checked={meal.meal_prep}
                            onChange={() => toggleMealPrep(meal)}
                            disabled={!!meal.completed_at}
                            aria-label={`Toggle meal prep for ${entryName(meal)}`}
                            data-testid={`toggle-prep-${meal.meal_id}`}
                          />
                          <span>{meal.meal_prep ? 'Prep' : 'Regular'}</span>
                        </div>
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                        {meal.completed_at ? `DONE (${formatTime(meal.completed_at)})` : 'Planned'}
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                        {!meal.completed_at && (
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                              onClick={() => markDone(meal.meal_id)}
                              data-testid={`mark-done-${meal.meal_id}`}
                              style={{
                                padding: '6px 12px',
                                background: '#2f9e44',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontWeight: 600,
                                fontSize: '13px',
                              }}
                            >
                              Mark Done
                            </button>
                            {meal.meal_prep && (
                              <button
                                onClick={() => setPrepTarget(meal)}
                                data-testid={`exec-prep-${meal.meal_id}`}
                                style={{
                                  padding: '6px 12px',
                                  background: '#6c5ce7',
                                  color: '#fff',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontWeight: 600,
                                  fontSize: '13px',
                                }}
                              >
                                Execute Prep
                              </button>
                            )}
                            <button
                              onClick={() => deleteMeal(meal.meal_id)}
                              data-testid={`delete-meal-${meal.meal_id}`}
                              style={{
                                padding: '6px 12px',
                                background: 'transparent',
                                color: '#d33',
                                border: 'none',
                                cursor: 'pointer',
                                fontWeight: 600,
                                fontSize: '13px',
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                        {meal.completed_at && <span>{'\u2014'}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                {(() => {
                  const totals = selectedDayMeals.reduce(
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
                    <tr data-testid="day-detail-total-row">
                      <td
                        style={{
                          padding: '8px',
                          borderTop: '2px solid #333',
                          fontWeight: 700,
                        }}
                      >
                        <div>TOTAL</div>
                        <div style={{ fontSize: '0.8em', color: '#444' }}>
                          {totals.calories} cal | {totals.protein}g P | {totals.carbs}g C | {totals.fat}g F
                        </div>
                      </td>
                      <td style={{ padding: '8px', borderTop: '2px solid #333' }} />
                      <td style={{ padding: '8px', borderTop: '2px solid #333' }} />
                      <td style={{ padding: '8px', borderTop: '2px solid #333' }} />
                      <td style={{ padding: '8px', borderTop: '2px solid #333' }} />
                    </tr>
                  );
                })()}
              </tfoot>
            </table>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/*  ADD MEAL MODAL                                                */}
      {/* ============================================================ */}
      <ModalOverlay
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Meal"
        testId="add-meal-modal"
      >
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
        <div style={{ marginBottom: '8px', fontSize: '0.85em', color: '#666' }}>Date: {selectedDay}</div>
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
