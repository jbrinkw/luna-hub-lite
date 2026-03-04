import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { IonSpinner, IonButton, IonBadge, IonInput, IonToggle, IonText } from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { toDateStr } from '@/shared/dates';

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
  completed_at: string | null;
  recipes: { name: string } | null;
  products: { name: string } | null;
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
      .select('*, recipes:recipe_id(name), products:product_id(name)')
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

      const { data: recipes } = await chefbyte()
        .from('recipes')
        .select('recipe_id, name')
        .eq('user_id', user.id)
        .ilike('name', `%${text}%`)
        .order('name');

      const { data: products } = await chefbyte()
        .from('products')
        .select('product_id, name')
        .eq('user_id', user.id)
        .ilike('name', `%${text}%`)
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
        <IonSpinner data-testid="mealplan-loading" />
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Meal Plan">
      <h2>MEAL PLAN</h2>

      {error && (
        <IonText color="danger">
          <p>{error}</p>
        </IonText>
      )}

      {/* ============================================================ */}
      {/*  WEEK NAVIGATION                                              */}
      {/* ============================================================ */}
      <div data-testid="week-nav" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <IonButton size="small" fill="outline" onClick={prevWeek} data-testid="prev-week-btn">
          Prev
        </IonButton>
        <IonButton size="small" fill="outline" onClick={goToday} data-testid="today-btn">
          Today
        </IonButton>
        <IonButton size="small" fill="outline" onClick={nextWeek} data-testid="next-week-btn">
          Next
        </IonButton>
        <span data-testid="week-range" style={{ marginLeft: '8px', fontWeight: 'bold' }}>
          {formatWeekRange(weekStart)}
        </span>
      </div>

      {/* ============================================================ */}
      {/*  7-DAY GRID                                                   */}
      {/* ============================================================ */}
      <div
        data-testid="week-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '4px',
          marginBottom: '16px',
        }}
      >
        {dayDates.map((date, i) => {
          const dayMeals = mealsByDay.get(date) ?? [];
          const dayNum = new Date(date + 'T00:00:00').getDate();
          const isSelected = selectedDay === date;

          return (
            <div
              key={date}
              data-testid={`day-col-${date}`}
              onClick={() => setSelectedDay(date)}
              style={{
                padding: '8px',
                border: isSelected ? '2px solid #3880ff' : '1px solid #ddd',
                borderRadius: '4px',
                cursor: 'pointer',
                minHeight: '80px',
                background: isSelected ? '#e8f0fe' : undefined,
              }}
            >
              <div style={{ fontWeight: 'bold', fontSize: '0.85em', marginBottom: '4px' }}>
                {DAY_NAMES[i]} {dayNum}
              </div>
              {dayMeals.length === 0 && <span style={{ color: '#aaa', fontSize: '0.8em' }}>(empty)</span>}
              {dayMeals.map((meal) => (
                <div
                  key={meal.meal_id}
                  data-testid={`grid-meal-${meal.meal_id}`}
                  style={{ fontSize: '0.8em', marginBottom: '2px' }}
                >
                  {entryName(meal)}
                  {meal.completed_at && (
                    <IonBadge
                      color="success"
                      style={{ marginLeft: '4px', fontSize: '0.7em' }}
                      data-testid={`done-badge-${meal.meal_id}`}
                    >
                      done
                    </IonBadge>
                  )}
                  {meal.meal_prep && !meal.completed_at && (
                    <IonBadge
                      color="tertiary"
                      style={{ marginLeft: '4px', fontSize: '0.7em' }}
                      data-testid={`prep-badge-${meal.meal_id}`}
                    >
                      PREP
                    </IonBadge>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* ============================================================ */}
      {/*  ADD MEAL BUTTON                                               */}
      {/* ============================================================ */}
      <IonButton
        size="small"
        onClick={openAddModal}
        disabled={!selectedDay}
        data-testid="add-meal-btn"
        style={{ marginBottom: '16px' }}
      >
        + Add Meal
      </IonButton>

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
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Mode</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {selectedDayMeals.map((meal) => (
                  <tr key={meal.meal_id} data-testid={`detail-row-${meal.meal_id}`}>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{entryName(meal)}</td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                      {meal.meal_prep ? 'Prep' : 'Regular'}
                    </td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                      {meal.completed_at ? `DONE (${formatTime(meal.completed_at)})` : 'Planned'}
                    </td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                      {!meal.completed_at && (
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <IonButton
                            size="small"
                            color="success"
                            onClick={() => markDone(meal.meal_id)}
                            data-testid={`mark-done-${meal.meal_id}`}
                          >
                            Mark Done
                          </IonButton>
                          {meal.meal_prep && (
                            <IonButton
                              size="small"
                              color="tertiary"
                              onClick={() => setPrepTarget(meal)}
                              data-testid={`exec-prep-${meal.meal_id}`}
                            >
                              Execute Prep
                            </IonButton>
                          )}
                          <IonButton
                            size="small"
                            color="danger"
                            fill="clear"
                            onClick={() => deleteMeal(meal.meal_id)}
                            data-testid={`delete-meal-${meal.meal_id}`}
                          >
                            Delete
                          </IonButton>
                        </div>
                      )}
                      {meal.completed_at && <span>\u2014</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
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
          <IonInput
            label="Search recipe or product"
            value={addSearchText}
            onIonInput={(e) => handleAddSearchInput(e.detail.value ?? '')}
            data-testid="add-meal-search"
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
          <IonInput
            label="Servings"
            type="number"
            value={addServings}
            onIonInput={(e) => setAddServings(Number(e.detail.value) || 1)}
            data-testid="add-meal-servings"
          />
        </div>
        <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label>Meal Prep</label>
          <IonToggle
            checked={addMealPrep}
            onIonChange={(e) => setAddMealPrep(e.detail.checked)}
            data-testid="add-meal-prep-toggle"
          />
        </div>
        <div style={{ marginBottom: '8px', fontSize: '0.85em', color: '#666' }}>Date: {selectedDay}</div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <IonButton fill="clear" onClick={() => setShowAddModal(false)} data-testid="add-meal-cancel">
            Cancel
          </IonButton>
          <IonButton onClick={addMeal} disabled={!addSelected} data-testid="add-meal-confirm">
            Add
          </IonButton>
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
          <IonButton fill="clear" onClick={() => setPrepTarget(null)} data-testid="prep-cancel-btn">
            Cancel
          </IonButton>
          <IonButton color="tertiary" onClick={executePrepConfirmed} data-testid="prep-execute-btn">
            Execute
          </IonButton>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
