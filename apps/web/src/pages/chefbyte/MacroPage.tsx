import { useEffect, useState, useCallback } from 'react';
import { IonSpinner, IonButton, IonInput, IonTextarea, IonText, IonCard, IonCardContent } from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { MacroProgressBar } from '@/components/shared/MacroProgressBar';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { toDateStr, formatDateDisplay } from '@/shared/dates';
import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { computeRecipeMacros } from './RecipesPage';

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
  const [loadError, setLoadError] = useState<string | null>(null);
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
    setLoadError(null);

    // 1. Fetch daily macro summary via RPC
    // RPC returns: { calories: { consumed, goal, remaining }, protein: {...}, carbs: {...}, fat: {...} }
    const { data: macroData, error: macroErr } = await (chefbyte() as any).rpc('get_daily_macros', {
      p_logical_date: currentDate,
    });

    if (macroErr) {
      setLoadError(macroErr.message);
      setLoading(false);
      return;
    }

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
  /*  Realtime subscriptions                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel('macro-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'chefbyte',
          table: 'food_logs',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          loadData();
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'chefbyte',
          table: 'temp_items',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          loadData();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const [mutationError, setMutationError] = useState<string | null>(null);

  const saveTempItem = async () => {
    if (!user || !tempName.trim()) return;
    setMutationError(null);
    const { error: err } = await chefbyte().from('temp_items').insert({
      user_id: user.id,
      name: tempName.trim(),
      calories: tempCalories,
      protein: tempProtein,
      carbs: tempCarbs,
      fat: tempFat,
      logical_date: currentDate,
    });
    if (err) {
      setMutationError(err.message);
      return;
    }
    setShowTempModal(false);
    await loadData();
  };

  /* ---------------------------------------------------------------- */
  /*  Delete consumed item                                             */
  /* ---------------------------------------------------------------- */

  const deleteConsumedItem = async (item: ConsumedItem) => {
    if (item.source === 'LiquidTrack') return; // IoT data, not user-deletable
    setMutationError(null);

    let error;
    if (item.source === 'Meal Plan') {
      ({ error } = await chefbyte().from('food_logs').delete().eq('log_id', item.id));
    } else if (item.source === 'Temp Item') {
      ({ error } = await chefbyte().from('temp_items').delete().eq('temp_id', item.id));
    }

    if (error) {
      setMutationError(error.message);
      return;
    }

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
    setMutationError(null);
    const calories = calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat);

    // Upsert each config key
    const keys = [
      { key: 'goal_calories', value: String(calories) },
      { key: 'goal_protein', value: String(targetProtein) },
      { key: 'goal_carbs', value: String(targetCarbs) },
      { key: 'goal_fat', value: String(targetFat) },
    ];

    for (const { key, value } of keys) {
      const { error: err } = await chefbyte()
        .from('user_config')
        .upsert({ user_id: user.id, key, value }, { onConflict: 'user_id,key' });
      if (err) {
        setMutationError(err.message);
        return;
      }
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
    setMutationError(null);
    const { error: err } = await chefbyte()
      .from('user_config')
      .upsert({ user_id: user.id, key: 'taste_profile', value: tasteProfile }, { onConflict: 'user_id,key' });
    if (err) {
      setMutationError(err.message);
      return;
    }
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
  const goals = macros?.goals ?? { ...DEFAULT_MACRO_GOALS };

  return (
    <ChefLayout title="Macros">
      <h2>MACROS</h2>
      {loadError && (
        <IonCard color="danger" data-testid="load-error">
          <IonCardContent>
            <p>Failed to load data: {loadError}</p>
            <IonButton onClick={loadData}>Retry</IonButton>
          </IonCardContent>
        </IonCard>
      )}
      {mutationError && (
        <IonText color="danger">
          <p>{mutationError}</p>
        </IonText>
      )}

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
        <MacroProgressBar
          label="Calories"
          current={consumedTotals.calories}
          goal={goals.calories}
          color="#3880ff"
          testId="progress-calories"
        />
        <MacroProgressBar
          label="Protein"
          current={consumedTotals.protein}
          goal={goals.protein}
          color="#2dd36f"
          unit="g"
          testId="progress-protein"
        />
        <MacroProgressBar
          label="Carbs"
          current={consumedTotals.carbs}
          goal={goals.carbs}
          color="#ffc409"
          unit="g"
          testId="progress-carbs"
        />
        <MacroProgressBar
          label="Fats"
          current={consumedTotals.fat}
          goal={goals.fat}
          color="#eb445a"
          unit="g"
          testId="progress-fats"
        />
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
                <th style={{ padding: '8px', borderBottom: '1px solid #ddd', width: '40px' }}></th>
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
                  <td style={{ padding: '4px', borderBottom: '1px solid #eee', textAlign: 'center' }}>
                    {item.source !== 'LiquidTrack' && (
                      <IonButton
                        fill="clear"
                        color="danger"
                        size="small"
                        data-testid={`delete-consumed-${item.id}`}
                        onClick={() => deleteConsumedItem(item)}
                        aria-label={`Remove ${item.name}`}
                        style={{ '--padding-start': '4px', '--padding-end': '4px', minHeight: 'auto' }}
                      >
                        x
                      </IonButton>
                    )}
                  </td>
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
      <ModalOverlay
        isOpen={showTempModal}
        onClose={() => setShowTempModal(false)}
        title="Log Temp Item"
        testId="temp-item-modal"
      >
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
            min="0"
            value={tempCalories}
            onIonInput={(e) => setTempCalories(Number(e.detail.value) || 0)}
            data-testid="temp-calories"
          />
          <IonInput
            label="Protein"
            type="number"
            min="0"
            value={tempProtein}
            onIonInput={(e) => setTempProtein(Number(e.detail.value) || 0)}
            data-testid="temp-protein"
          />
          <IonInput
            label="Carbs"
            type="number"
            min="0"
            value={tempCarbs}
            onIonInput={(e) => setTempCarbs(Number(e.detail.value) || 0)}
            data-testid="temp-carbs"
          />
          <IonInput
            label="Fat"
            type="number"
            min="0"
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
        <div style={{ display: 'grid', gap: '8px' }}>
          <IonInput
            label="Protein (g)"
            type="number"
            min="0"
            value={targetProtein}
            onIonInput={(e) => setTargetProtein(Number(e.detail.value) || 0)}
            data-testid="target-protein"
          />
          <IonInput
            label="Carbs (g)"
            type="number"
            min="0"
            value={targetCarbs}
            onIonInput={(e) => setTargetCarbs(Number(e.detail.value) || 0)}
            data-testid="target-carbs"
          />
          <IonInput
            label="Fats (g)"
            type="number"
            min="0"
            value={targetFat}
            onIonInput={(e) => setTargetFat(Number(e.detail.value) || 0)}
            data-testid="target-fats"
          />
          <div data-testid="target-calories" style={{ padding: '8px', background: '#f4f5f8', borderRadius: '4px' }}>
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
        <p style={{ fontSize: '0.9em', color: '#666', marginBottom: '12px' }}>
          Dietary preferences and notes for recipe filtering and AI suggestions:
        </p>
        <IonTextarea
          value={tasteProfile}
          onIonInput={(e) => setTasteProfile(e.detail.value ?? '')}
          data-testid="taste-textarea"
          aria-label="Taste profile"
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
      </ModalOverlay>
    </ChefLayout>
  );
}
