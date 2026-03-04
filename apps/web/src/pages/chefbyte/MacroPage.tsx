import { useEffect, useState, useCallback } from 'react';
import {
  IonSpinner,
  IonButton,
  IonInput,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonTextarea,
} from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { toDateStr, formatDateDisplay } from '@/shared/dates';
import { computeRecipeMacros } from './RecipesPage';

// Cast needed: chefbyte schema types not yet generated
const chefbyte = () => supabase.schema('chefbyte') as any;

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
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(() => toDateStr(new Date()));
  const [macros, setMacros] = useState<MacroTotals | null>(null);
  const [consumed, setConsumed] = useState<ConsumedItem[]>([]);
  const [planned, setPlanned] = useState<PlannedItem[]>([]);

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

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const userId = user?.id;

  const loadData = useCallback(async () => {
    if (!userId) return;

    // 1. Fetch daily macro summary via RPC
    // RPC returns: { calories: { consumed, goal, remaining }, protein: {...}, carbs: {...}, fat: {...} }
    const { data: macroData } = await (chefbyte() as any).rpc('get_daily_macros', {
      p_logical_date: currentDate,
    });

    if (macroData) {
      const rpc = macroData as Record<string, { consumed: number; goal: number; remaining: number }>;
      setMacros({
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
      });
    } else {
      setMacros(null);
    }

    // 2. Fetch consumed items from 3 sources
    const items: ConsumedItem[] = [];

    // food_logs (from meal plan completions and scanner)
    const { data: foodLogs } = await chefbyte()
      .from('food_logs')
      .select('log_id, product_id, calories, protein, carbs, fat, products:product_id(name)')
      .eq('user_id', userId)
      .eq('logical_date', currentDate)
      .order('created_at');

    for (const log of (foodLogs ?? []) as any[]) {
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

    // temp_items
    const { data: tempItems } = await chefbyte()
      .from('temp_items')
      .select('temp_id, name, calories, protein, carbs, fat')
      .eq('user_id', userId)
      .eq('logical_date', currentDate)
      .order('created_at');

    for (const ti of (tempItems ?? []) as any[]) {
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

    // liquidtrack_events
    const { data: ltEvents } = await chefbyte()
      .from('liquidtrack_events')
      .select('event_id, calories, protein, carbs, fat')
      .eq('user_id', userId)
      .eq('logical_date', currentDate)
      .order('created_at');

    for (const ev of (ltEvents ?? []) as any[]) {
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

    setConsumed(items);

    // 3. Planned items: meal_plan_entries for date where completed_at IS NULL and meal_prep=false
    const { data: plannedData } = await chefbyte()
      .from('meal_plan_entries')
      .select(
        'meal_id, servings, recipes:recipe_id(name, base_servings, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving)',
      )
      .eq('user_id', userId)
      .eq('logical_date', currentDate)
      .eq('meal_prep', false)
      .is('completed_at', null);

    const plannedItems: PlannedItem[] = [];
    for (const entry of (plannedData ?? []) as any[]) {
      const servings = Number(entry.servings) || 1;
      if (entry.recipes) {
        // Recipe-based entry: compute macros from ingredients
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
        // Product-based entry: use per-serving macros directly
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
    setPlanned(plannedItems);

    setLoading(false);
  }, [userId, currentDate]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

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
  /*  Progress bar helper                                              */
  /* ---------------------------------------------------------------- */

  const pct = (val: number, goal: number): number => {
    if (goal <= 0) return 0;
    return Math.min(Math.round((val / goal) * 100), 100);
  };

  /* ---------------------------------------------------------------- */
  /*  Temp Item modal actions                                          */
  /* ---------------------------------------------------------------- */

  const openTempModal = () => {
    setTempName('');
    setTempCalories(0);
    setTempProtein(0);
    setTempCarbs(0);
    setTempFat(0);
    setShowTempModal(true);
  };

  const saveTempItem = async () => {
    if (!user || !tempName.trim()) return;
    await chefbyte().from('temp_items').insert({
      user_id: user.id,
      name: tempName.trim(),
      calories: tempCalories,
      protein: tempProtein,
      carbs: tempCarbs,
      fat: tempFat,
      logical_date: currentDate,
    });
    setShowTempModal(false);
    await loadData();
  };

  /* ---------------------------------------------------------------- */
  /*  Target Macros modal actions                                      */
  /* ---------------------------------------------------------------- */

  const openTargetModal = () => {
    // Pre-fill from current goals if available
    if (macros?.goals) {
      setTargetProtein(macros.goals.protein || 0);
      setTargetCarbs(macros.goals.carbs || 0);
      setTargetFat(macros.goals.fat || 0);
    }
    setShowTargetModal(true);
  };

  const saveTargets = async () => {
    if (!user) return;
    const calories = calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat);

    // Upsert each config key
    const keys = [
      { key: 'goal_calories', value: String(calories) },
      { key: 'goal_protein', value: String(targetProtein) },
      { key: 'goal_carbs', value: String(targetCarbs) },
      { key: 'goal_fat', value: String(targetFat) },
    ];

    for (const { key, value } of keys) {
      await chefbyte().from('user_config').upsert({ user_id: user.id, key, value }, { onConflict: 'user_id,key' });
    }

    setShowTargetModal(false);
    await loadData();
  };

  /* ---------------------------------------------------------------- */
  /*  Taste Profile modal actions                                      */
  /* ---------------------------------------------------------------- */

  const openTasteModal = async () => {
    if (!user) return;
    // Load current taste profile
    const { data } = await chefbyte()
      .from('user_config')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'taste_profile')
      .single();
    setTasteProfile((data as any)?.value ?? '');
    setShowTasteModal(true);
  };

  const saveTasteProfile = async () => {
    if (!user) return;
    await chefbyte()
      .from('user_config')
      .upsert({ user_id: user.id, key: 'taste_profile', value: tasteProfile }, { onConflict: 'user_id,key' });
    setShowTasteModal(false);
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Macros">
        <IonSpinner data-testid="macro-loading" />
      </ChefLayout>
    );
  }

  const consumedTotals = macros?.consumed ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const goals = macros?.goals ?? { calories: 2000, protein: 150, carbs: 250, fat: 65 };

  return (
    <ChefLayout title="Macros">
      <h2>MACROS</h2>

      {/* ============================================================ */}
      {/*  DATE NAVIGATION                                              */}
      {/* ============================================================ */}
      <div data-testid="date-nav" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <IonButton size="small" fill="outline" onClick={prevDate} data-testid="prev-date-btn">
          Prev
        </IonButton>
        <IonButton size="small" fill="outline" onClick={goToday} data-testid="today-date-btn">
          Today
        </IonButton>
        <IonButton size="small" fill="outline" onClick={nextDate} data-testid="next-date-btn">
          Next
        </IonButton>
        <span data-testid="current-date" style={{ marginLeft: '8px', fontWeight: 'bold' }}>
          {formatDateDisplay(currentDate)}
        </span>
      </div>

      {/* ============================================================ */}
      {/*  DAY SUMMARY — PROGRESS BARS                                  */}
      {/* ============================================================ */}
      <div data-testid="macro-summary" style={{ marginBottom: '24px' }}>
        <h3>Day Summary</h3>

        {/* Calories */}
        <div data-testid="progress-calories" style={{ marginBottom: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9em' }}>
            <span>Calories</span>
            <span>
              {consumedTotals.calories} / {goals.calories} ({pct(consumedTotals.calories, goals.calories)}%)
            </span>
          </div>
          <div style={{ background: '#eee', borderRadius: '4px', height: '16px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct(consumedTotals.calories, goals.calories)}%`,
                height: '100%',
                background: '#3880ff',
                borderRadius: '4px',
              }}
            />
          </div>
        </div>

        {/* Protein */}
        <div data-testid="progress-protein" style={{ marginBottom: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9em' }}>
            <span>Protein</span>
            <span>
              {consumedTotals.protein}g / {goals.protein}g ({pct(consumedTotals.protein, goals.protein)}%)
            </span>
          </div>
          <div style={{ background: '#eee', borderRadius: '4px', height: '16px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct(consumedTotals.protein, goals.protein)}%`,
                height: '100%',
                background: '#2dd36f',
                borderRadius: '4px',
              }}
            />
          </div>
        </div>

        {/* Carbs */}
        <div data-testid="progress-carbs" style={{ marginBottom: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9em' }}>
            <span>Carbs</span>
            <span>
              {consumedTotals.carbs}g / {goals.carbs}g ({pct(consumedTotals.carbs, goals.carbs)}%)
            </span>
          </div>
          <div style={{ background: '#eee', borderRadius: '4px', height: '16px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct(consumedTotals.carbs, goals.carbs)}%`,
                height: '100%',
                background: '#ffc409',
                borderRadius: '4px',
              }}
            />
          </div>
        </div>

        {/* Fats */}
        <div data-testid="progress-fats" style={{ marginBottom: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9em' }}>
            <span>Fats</span>
            <span>
              {consumedTotals.fat}g / {goals.fat}g ({pct(consumedTotals.fat, goals.fat)}%)
            </span>
          </div>
          <div style={{ background: '#eee', borderRadius: '4px', height: '16px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct(consumedTotals.fat, goals.fat)}%`,
                height: '100%',
                background: '#eb445a',
                borderRadius: '4px',
              }}
            />
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  CONSUMED ITEMS TABLE                                         */}
      {/* ============================================================ */}
      <div data-testid="consumed-section" style={{ marginBottom: '24px' }}>
        <h3>Consumed Items</h3>
        {consumed.length === 0 ? (
          <p data-testid="no-consumed">No consumed items for this day.</p>
        ) : (
          <table data-testid="consumed-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Source</th>
                <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Item</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>Cal</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>P</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>C</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>F</th>
              </tr>
            </thead>
            <tbody>
              {consumed.map((item) => (
                <tr key={item.id} data-testid={`consumed-row-${item.id}`}>
                  <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{item.source}</td>
                  <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{item.name}</td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>
                    {item.calories}
                  </td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>
                    {item.protein}g
                  </td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>{item.carbs}g</td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>{item.fat}g</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ============================================================ */}
      {/*  PLANNED ITEMS                                                */}
      {/* ============================================================ */}
      <div data-testid="planned-section" style={{ marginBottom: '24px' }}>
        <h3>Planned (not yet consumed)</h3>
        {planned.length === 0 ? (
          <p data-testid="no-planned">No planned items for this day.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Item</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>Cal</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>P</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>C</th>
                <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>F</th>
              </tr>
            </thead>
            <tbody>
              {planned.map((item) => (
                <tr key={item.meal_id} data-testid={`planned-row-${item.meal_id}`}>
                  <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{item.name}</td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>
                    {item.calories}
                  </td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>
                    {item.protein}g
                  </td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>{item.carbs}g</td>
                  <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>{item.fat}g</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ============================================================ */}
      {/*  ACTION BUTTONS                                               */}
      {/* ============================================================ */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        <IonButton size="small" onClick={openTempModal} data-testid="log-temp-btn">
          + Log Temp Item
        </IonButton>
        <IonButton size="small" onClick={openTargetModal} data-testid="target-macros-btn">
          Edit Targets
        </IonButton>
        <IonButton size="small" onClick={openTasteModal} data-testid="taste-profile-btn">
          Taste Profile
        </IonButton>
      </div>

      {/* ============================================================ */}
      {/*  LOG TEMP ITEM MODAL                                          */}
      {/* ============================================================ */}
      {showTempModal && (
        <div
          data-testid="temp-item-modal"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <IonCard style={{ width: '100%', maxWidth: '500px', margin: '16px' }}>
            <IonCardHeader>
              <IonCardTitle>Log Temp Item</IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <div style={{ display: 'grid', gap: '8px' }}>
                <IonInput
                  label="Name"
                  value={tempName}
                  onIonInput={(e) => setTempName(e.detail.value ?? '')}
                  data-testid="temp-name"
                />
                <IonInput
                  label="Calories"
                  type="number"
                  value={tempCalories}
                  onIonInput={(e) => setTempCalories(Number(e.detail.value) || 0)}
                  data-testid="temp-calories"
                />
                <IonInput
                  label="Protein"
                  type="number"
                  value={tempProtein}
                  onIonInput={(e) => setTempProtein(Number(e.detail.value) || 0)}
                  data-testid="temp-protein"
                />
                <IonInput
                  label="Carbs"
                  type="number"
                  value={tempCarbs}
                  onIonInput={(e) => setTempCarbs(Number(e.detail.value) || 0)}
                  data-testid="temp-carbs"
                />
                <IonInput
                  label="Fat"
                  type="number"
                  value={tempFat}
                  onIonInput={(e) => setTempFat(Number(e.detail.value) || 0)}
                  data-testid="temp-fat"
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <IonButton fill="clear" onClick={() => setShowTempModal(false)} data-testid="temp-cancel-btn">
                  Cancel
                </IonButton>
                <IonButton onClick={saveTempItem} disabled={!tempName.trim()} data-testid="temp-save-btn">
                  Log Item
                </IonButton>
              </div>
            </IonCardContent>
          </IonCard>
        </div>
      )}

      {/* ============================================================ */}
      {/*  TARGET MACROS MODAL                                          */}
      {/* ============================================================ */}
      {showTargetModal && (
        <div
          data-testid="target-macros-modal"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <IonCard style={{ width: '100%', maxWidth: '500px', margin: '16px' }}>
            <IonCardHeader>
              <IonCardTitle>Target Macros</IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <div style={{ display: 'grid', gap: '8px' }}>
                <IonInput
                  label="Protein (g)"
                  type="number"
                  value={targetProtein}
                  onIonInput={(e) => setTargetProtein(Number(e.detail.value) || 0)}
                  data-testid="target-protein"
                />
                <IonInput
                  label="Carbs (g)"
                  type="number"
                  value={targetCarbs}
                  onIonInput={(e) => setTargetCarbs(Number(e.detail.value) || 0)}
                  data-testid="target-carbs"
                />
                <IonInput
                  label="Fats (g)"
                  type="number"
                  value={targetFat}
                  onIonInput={(e) => setTargetFat(Number(e.detail.value) || 0)}
                  data-testid="target-fats"
                />
                <div
                  data-testid="target-calories"
                  style={{ padding: '8px', background: '#f4f5f8', borderRadius: '4px' }}
                >
                  <strong>Calories (auto): </strong>
                  {calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat)}
                  <div style={{ fontSize: '0.8em', color: '#666' }}>(protein*4 + carbs*4 + fat*9)</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <IonButton fill="clear" onClick={() => setShowTargetModal(false)} data-testid="target-cancel-btn">
                  Cancel
                </IonButton>
                <IonButton onClick={saveTargets} data-testid="target-save-btn">
                  Save
                </IonButton>
              </div>
            </IonCardContent>
          </IonCard>
        </div>
      )}

      {/* ============================================================ */}
      {/*  TASTE PROFILE MODAL                                          */}
      {/* ============================================================ */}
      {showTasteModal && (
        <div
          data-testid="taste-modal"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <IonCard style={{ width: '100%', maxWidth: '500px', margin: '16px' }}>
            <IonCardHeader>
              <IonCardTitle>Taste Profile</IonCardTitle>
            </IonCardHeader>
            <IonCardContent>
              <p style={{ fontSize: '0.9em', color: '#666', marginBottom: '12px' }}>
                Dietary preferences and notes for recipe filtering and AI suggestions:
              </p>
              <IonTextarea
                value={tasteProfile}
                onIonInput={(e) => setTasteProfile(e.detail.value ?? '')}
                data-testid="taste-textarea"
                rows={5}
              />
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <IonButton fill="clear" onClick={() => setShowTasteModal(false)} data-testid="taste-cancel-btn">
                  Cancel
                </IonButton>
                <IonButton onClick={saveTasteProfile} data-testid="taste-save-btn">
                  Save
                </IonButton>
              </div>
            </IonCardContent>
          </IonCard>
        </div>
      )}
    </ChefLayout>
  );
}
