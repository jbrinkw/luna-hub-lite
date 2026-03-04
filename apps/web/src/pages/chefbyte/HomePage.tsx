import { useEffect, useState, useCallback } from 'react';
import { IonSpinner, IonButton, IonInput, IonTextarea, IonCard, IonCardContent } from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { MacroProgressBar } from '@/components/shared/MacroProgressBar';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MacroTotals {
  consumed: { calories: number; protein: number; carbs: number; fat: number };
  goals: { calories: number; protein: number; carbs: number; fat: number };
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
  const [loadError, setLoadError] = useState<string | null>(null);

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
  const [targetFat, setTargetFat] = useState(0);

  /* ---- Taste Profile modal ---- */
  const [showTasteModal, setShowTasteModal] = useState(false);
  const [tasteProfile, setTasteProfile] = useState('');

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const today = todayStr();

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoadError(null);

    // 1. Status cards — missing prices
    const { data: mp, error: mpErr } = await chefbyte()
      .from('products')
      .select('product_id')
      .eq('user_id', userId)
      .is('price', null);
    if (mpErr) {
      setLoadError(mpErr.message);
      return;
    }
    setMissingPrices((mp ?? []).length);

    // 2. Placeholders
    const { data: ph } = await chefbyte()
      .from('products')
      .select('product_id')
      .eq('user_id', userId)
      .eq('is_placeholder', true);
    setPlaceholders((ph ?? []).length);

    // 3. Below min stock — fetch products with min_stock_amount > 0, then batch-fetch stock_lots
    const { data: stockProducts } = await chefbyte()
      .from('products')
      .select('product_id, min_stock_amount')
      .eq('user_id', userId)
      .gt('min_stock_amount', 0);

    let belowCount = 0;
    const spArr = (stockProducts ?? []) as any[];
    if (spArr.length > 0) {
      const productIds = spArr.map((p: any) => p.product_id);
      const { data: allLots } = await chefbyte()
        .from('stock_lots')
        .select('product_id, qty_containers')
        .in('product_id', productIds);

      // Group stock by product_id
      const stockByProduct = new Map<string, number>();
      for (const lot of (allLots ?? []) as any[]) {
        const current = stockByProduct.get(lot.product_id) ?? 0;
        stockByProduct.set(lot.product_id, current + Number(lot.qty_containers));
      }

      for (const p of spArr) {
        const totalStock = stockByProduct.get(p.product_id) ?? 0;
        if (totalStock < Number(p.min_stock_amount)) belowCount++;
      }
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
          fat: Number(rpc.fat?.goal) || 0,
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
      setTargetFat(macros.goals.fat || 0);
    }
    setShowTargetModal(true);
  };

  const saveTargets = async () => {
    if (!user) return;
    const calories = calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat);
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
      .eq('purchased', true);

    const validItems = ((items ?? []) as any[]).filter((item) => !item.products?.is_placeholder);
    if (validItems.length > 0) {
      const stockRows = validItems.map((item) => ({
        user_id: user.id,
        product_id: item.product_id,
        qty_containers: Number(item.qty_containers),
        location_id: defaultLocationId,
      }));
      const { error: insertErr } = await chefbyte().from('stock_lots').insert(stockRows);

      // Only delete shopping items if stock insert succeeded
      if (!insertErr) {
        const cartIds = validItems.map((item: any) => item.cart_item_id);
        await chefbyte().from('shopping_list').delete().in('cart_item_id', cartIds);
      }
    }
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
  const goals = macros?.goals ?? { ...DEFAULT_MACRO_GOALS };

  return (
    <ChefLayout title="Home">
      <h2>CHEFBYTE</h2>

      {loadError && (
        <IonCard color="danger" data-testid="load-error">
          <IonCardContent>
            <p>Failed to load data: {loadError}</p>
            <IonButton onClick={loadData}>Retry</IonButton>
          </IonCardContent>
        </IonCard>
      )}

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
        <MacroProgressBar
          label="Calories"
          current={consumed.calories}
          goal={goals.calories}
          color="#3880ff"
          testId="compact-calories"
        />
        <MacroProgressBar
          label="Protein"
          current={consumed.protein}
          goal={goals.protein}
          color="#2dd36f"
          unit="g"
          testId="compact-protein"
        />
        <MacroProgressBar
          label="Carbs"
          current={consumed.carbs}
          goal={goals.carbs}
          color="#ffc409"
          unit="g"
          testId="compact-carbs"
        />
        <MacroProgressBar
          label="Fats"
          current={consumed.fat}
          goal={goals.fat}
          color="#eb445a"
          unit="g"
          testId="compact-fats"
        />
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
        <IonButton size="small" disabled title="Coming soon" data-testid="meal-plan-cart-btn">
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
      </ModalOverlay>
    </ChefLayout>
  );
}
