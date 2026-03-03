import { useEffect, useState, useCallback } from 'react';
import {
  IonSpinner,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonInput,
  IonTextarea,
} from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';

const chefbyte = () => supabase.schema('chefbyte') as any;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MacroTotals {
  consumed: { calories: number; protein: number; carbs: number; fat: number };
  goals: { calories: number; protein: number; carbs: number; fats: number };
}

interface MealPrepEntry {
  meal_id: string;
  servings: number;
  recipes: { name: string } | null;
  products: { name: string } | null;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for testing)                                 */
/* ------------------------------------------------------------------ */

export function pctOf(val: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(Math.round((val / goal) * 100), 100);
}

/* ================================================================== */
/*  HomePage                                                           */
/* ================================================================== */

export function HomePage() {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);

  /* ---- Status cards ---- */
  const [missingPrices, setMissingPrices] = useState(0);
  const [placeholders, setPlaceholders] = useState(0);
  const [belowMinStock, setBelowMinStock] = useState(0);
  const [cartValue, setCartValue] = useState(0);

  /* ---- Macro summary ---- */
  const [macros, setMacros] = useState<MacroTotals | null>(null);

  /* ---- Today's meal prep ---- */
  const [mealPrep, setMealPrep] = useState<MealPrepEntry[]>([]);

  /* ---- Target Macros modal ---- */
  const [showTargetModal, setShowTargetModal] = useState(false);
  const [targetProtein, setTargetProtein] = useState(0);
  const [targetCarbs, setTargetCarbs] = useState(0);
  const [targetFats, setTargetFats] = useState(0);

  /* ---- Taste Profile modal ---- */
  const [showTasteModal, setShowTasteModal] = useState(false);
  const [tasteProfile, setTasteProfile] = useState('');

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const today = new Date().toISOString().slice(0, 10);

  const loadData = useCallback(async () => {
    if (!userId) return;

    // 1. Status cards — missing prices
    const { data: mp } = await chefbyte().from('products').select('product_id').eq('user_id', userId).is('price', null);
    setMissingPrices((mp ?? []).length);

    // 2. Placeholders
    const { data: ph } = await chefbyte()
      .from('products')
      .select('product_id')
      .eq('user_id', userId)
      .eq('is_placeholder', true);
    setPlaceholders((ph ?? []).length);

    // 3. Below min stock — fetch products with min_stock_amount > 0, then compare with stock_lots
    const { data: stockProducts } = await chefbyte()
      .from('products')
      .select('product_id, min_stock_amount')
      .eq('user_id', userId)
      .gt('min_stock_amount', 0);

    let belowCount = 0;
    for (const p of (stockProducts ?? []) as any[]) {
      const { data: lots } = await chefbyte()
        .from('stock_lots')
        .select('qty_containers')
        .eq('product_id', p.product_id);
      const totalStock = (lots ?? []).reduce((s: number, l: any) => s + Number(l.qty_containers), 0);
      if (totalStock < Number(p.min_stock_amount)) belowCount++;
    }
    setBelowMinStock(belowCount);

    // 4. Cart value — shopping_list joined with products
    const { data: cartItems } = await chefbyte()
      .from('shopping_list')
      .select('qty_containers, products:product_id(price)')
      .eq('user_id', userId);

    const total = (cartItems ?? []).reduce((sum: number, item: any) => {
      const price = Number(item.products?.price ?? 0);
      const qty = Number(item.qty_containers ?? 0);
      return sum + price * qty;
    }, 0);
    setCartValue(total);

    // 5. Macro day summary
    const { data: macroData } = await (chefbyte() as any).rpc('get_daily_macros', {
      p_logical_date: today,
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
          fats: Number(rpc.fat?.goal) || 0,
        },
      });
    } else {
      setMacros(null);
    }

    // 6. Today's meal prep
    const { data: prepData } = await chefbyte()
      .from('meal_plan_entries')
      .select('meal_id, servings, recipes:recipe_id(name), products:product_id(name)')
      .eq('user_id', userId)
      .eq('logical_date', today)
      .eq('meal_prep', true)
      .is('completed_at', null);
    setMealPrep((prepData ?? []) as MealPrepEntry[]);

    setLoading(false);
  }, [userId, today]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

  /* ---------------------------------------------------------------- */
  /*  Target Macros modal actions                                      */
  /* ---------------------------------------------------------------- */

  const openTargetModal = () => {
    if (macros?.goals) {
      setTargetProtein(macros.goals.protein || 0);
      setTargetCarbs(macros.goals.carbs || 0);
      setTargetFats(macros.goals.fats || 0);
    }
    setShowTargetModal(true);
  };

  const saveTargets = async () => {
    if (!user) return;
    const calories = calcCaloriesFromMacros(targetProtein, targetCarbs, targetFats);
    const keys = [
      { key: 'goal_calories', value: String(calories) },
      { key: 'goal_protein', value: String(targetProtein) },
      { key: 'goal_carbs', value: String(targetCarbs) },
      { key: 'goal_fats', value: String(targetFats) },
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

  /* ---------------------------------------------------------------- */
  /*  Quick actions                                                    */
  /* ---------------------------------------------------------------- */

  const importShopping = async () => {
    if (!user) return;

    // Get user's default location (first by created_at)
    const { data: locations } = await chefbyte()
      .from('locations')
      .select('location_id')
      .eq('user_id', user.id)
      .order('created_at')
      .limit(1);
    const defaultLocationId = (locations?.[0] as any)?.location_id;
    if (!defaultLocationId) return; // No locations — can't import

    // Get non-placeholder items from shopping list
    const { data: items } = await chefbyte()
      .from('shopping_list')
      .select('*, products:product_id(is_placeholder)')
      .eq('user_id', user.id)
      .eq('purchased', false);

    for (const item of (items ?? []) as any[]) {
      if (item.products?.is_placeholder) continue;
      // Insert stock lot for each shopping item
      await chefbyte()
        .from('stock_lots')
        .insert({
          user_id: user.id,
          product_id: item.product_id,
          qty_containers: Number(item.qty_containers),
          location_id: defaultLocationId,
        });
      // Remove from shopping list
      await chefbyte().from('shopping_list').delete().eq('cart_item_id', item.cart_item_id);
    }
    await loadData();
  };

  const mealPlanToCart = async () => {
    if (!user) return;
    // Get upcoming meal plan entries that need ingredients
    // For now, this is a simplified version - adds recipe ingredients to shopping list
    // TODO: Full implementation in Phase 8
    await loadData();
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Home">
        <IonSpinner data-testid="home-loading" />
      </ChefLayout>
    );
  }

  const consumed = macros?.consumed ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const goals = macros?.goals ?? { calories: 2000, protein: 150, carbs: 250, fats: 65 };

  return (
    <ChefLayout title="Home">
      <h2>CHEFBYTE</h2>

      {/* ============================================================ */}
      {/*  STATUS CARDS                                                 */}
      {/* ============================================================ */}
      <div
        data-testid="status-cards"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '24px' }}
      >
        <div
          data-testid="card-missing-prices"
          style={{
            background: '#f7f7f9',
            border: '1px solid #eee',
            borderRadius: '8px',
            padding: '12px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '24px', fontWeight: 700 }}>{missingPrices}</div>
          <div style={{ fontSize: '12px', color: '#666' }}>Missing Prices</div>
        </div>
        <div
          data-testid="card-placeholders"
          style={{
            background: '#f7f7f9',
            border: '1px solid #eee',
            borderRadius: '8px',
            padding: '12px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '24px', fontWeight: 700 }}>{placeholders}</div>
          <div style={{ fontSize: '12px', color: '#666' }}>Placeholders</div>
        </div>
        <div
          data-testid="card-below-min"
          style={{
            background: '#f7f7f9',
            border: '1px solid #eee',
            borderRadius: '8px',
            padding: '12px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '24px', fontWeight: 700 }}>{belowMinStock}</div>
          <div style={{ fontSize: '12px', color: '#666' }}>Below Min Stock</div>
        </div>
        <div
          data-testid="card-cart-value"
          style={{
            background: '#f7f7f9',
            border: '1px solid #eee',
            borderRadius: '8px',
            padding: '12px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '24px', fontWeight: 700 }}>${cartValue.toFixed(2)}</div>
          <div style={{ fontSize: '12px', color: '#666' }}>Cart Value</div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  COMPACT MACRO SUMMARY                                        */}
      {/* ============================================================ */}
      <div data-testid="macro-summary" style={{ marginBottom: '24px' }}>
        <h3>Today&apos;s Macros</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
          {/* Calories */}
          <div data-testid="compact-calories" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.8em', color: '#666' }}>Calories</div>
            <div style={{ fontWeight: 700 }}>
              {consumed.calories}/{goals.calories}
            </div>
            <div style={{ background: '#eee', borderRadius: '4px', height: '8px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${pctOf(consumed.calories, goals.calories)}%`,
                  height: '100%',
                  background: '#3880ff',
                  borderRadius: '4px',
                }}
              />
            </div>
          </div>
          {/* Protein */}
          <div data-testid="compact-protein" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.8em', color: '#666' }}>Protein</div>
            <div style={{ fontWeight: 700 }}>
              {consumed.protein}g/{goals.protein}g
            </div>
            <div style={{ background: '#eee', borderRadius: '4px', height: '8px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${pctOf(consumed.protein, goals.protein)}%`,
                  height: '100%',
                  background: '#2dd36f',
                  borderRadius: '4px',
                }}
              />
            </div>
          </div>
          {/* Carbs */}
          <div data-testid="compact-carbs" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.8em', color: '#666' }}>Carbs</div>
            <div style={{ fontWeight: 700 }}>
              {consumed.carbs}g/{goals.carbs}g
            </div>
            <div style={{ background: '#eee', borderRadius: '4px', height: '8px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${pctOf(consumed.carbs, goals.carbs)}%`,
                  height: '100%',
                  background: '#ffc409',
                  borderRadius: '4px',
                }}
              />
            </div>
          </div>
          {/* Fats */}
          <div data-testid="compact-fats" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.8em', color: '#666' }}>Fats</div>
            <div style={{ fontWeight: 700 }}>
              {consumed.fat}g/{goals.fats}g
            </div>
            <div style={{ background: '#eee', borderRadius: '4px', height: '8px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${pctOf(consumed.fat, goals.fats)}%`,
                  height: '100%',
                  background: '#eb445a',
                  borderRadius: '4px',
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  QUICK ACTIONS                                                */}
      {/* ============================================================ */}
      <div data-testid="quick-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
        <IonButton size="small" onClick={importShopping} data-testid="import-shopping-btn">
          Import Shopping
        </IonButton>
        <IonButton size="small" onClick={openTargetModal} data-testid="target-macros-btn">
          Target Macros
        </IonButton>
        <IonButton size="small" onClick={openTasteModal} data-testid="taste-profile-btn">
          Taste Profile
        </IonButton>
        <IonButton size="small" onClick={mealPlanToCart} data-testid="meal-plan-cart-btn">
          Meal Plan → Cart
        </IonButton>
      </div>

      {/* ============================================================ */}
      {/*  TODAY'S MEAL PREP                                            */}
      {/* ============================================================ */}
      <div data-testid="meal-prep-section" style={{ marginBottom: '24px' }}>
        <h3>Today&apos;s Meal Prep</h3>
        {mealPrep.length === 0 ? (
          <p data-testid="no-meal-prep" style={{ color: '#666', fontStyle: 'italic' }}>
            No meal prep scheduled for today
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {mealPrep.map((entry) => (
              <div
                key={entry.meal_id}
                data-testid={`prep-entry-${entry.meal_id}`}
                style={{
                  padding: '10px 12px',
                  border: '1px solid #eee',
                  borderLeft: '4px solid #3880ff',
                  borderRadius: '6px',
                  background: '#f7f7f9',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontWeight: 600 }}>{entry.recipes?.name ?? entry.products?.name ?? 'Unknown'}</span>
                <span style={{ color: '#666', fontSize: '0.9em' }}>
                  {entry.servings} serving{entry.servings !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

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
                  value={targetFats}
                  onIonInput={(e) => setTargetFats(Number(e.detail.value) || 0)}
                  data-testid="target-fats"
                />
                <div
                  data-testid="target-calories"
                  style={{ padding: '8px', background: '#f4f5f8', borderRadius: '4px' }}
                >
                  <strong>Calories (auto): </strong>
                  {calcCaloriesFromMacros(targetProtein, targetCarbs, targetFats)}
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
