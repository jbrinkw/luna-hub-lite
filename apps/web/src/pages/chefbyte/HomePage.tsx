import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';

import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';
import { computeRecipeMacros } from '@/pages/chefbyte/RecipesPage';
import { CardSkeleton, MacroBarSkeleton, ListSkeleton } from '@/components/SkeletonScreen';

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

interface MealEntry {
  meal_id: string;
  servings: number;
  meal_type: string | null;
  completed_at: string | null;
  recipes: {
    name: string;
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
    protein_per_serving: number;
    carbs_per_serving: number;
    fat_per_serving: number;
    servings_per_container: number;
  } | null;
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

  /* ---- Today's meals (non-prep) ---- */
  const [todaysMeals, setTodaysMeals] = useState<MealEntry[]>([]);

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

    // 7. Today's meals (non-prep)
    const { data: mealsData } = await chefbyte()
      .from('meal_plan_entries')
      .select(
        'meal_id, servings, meal_type, completed_at, recipes:recipe_id(name, recipe_ingredients(quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container)',
      )
      .eq('user_id', userId)
      .eq('logical_date', today)
      .eq('meal_prep', false);
    setTodaysMeals((mealsData ?? []) as MealEntry[]);

    setLoading(false);
  }, [userId, today]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case

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

  /* ---------------------------------------------------------------- */
  /*  Meal Plan -> Cart                                                */
  /* ---------------------------------------------------------------- */

  const [syncing, setSyncing] = useState(false);

  const syncMealPlanToCart = async () => {
    if (!user) return;
    setSyncing(true);
    setLoadError(null);

    try {
      // Get today's incomplete meal plan entries that have recipes
      const { data: entries } = await chefbyte()
        .from('meal_plan_entries')
        .select(
          'meal_id, servings, recipe_id, recipes:recipe_id(base_servings, recipe_ingredients(quantity, unit, product_id, products:product_id(servings_per_container)))',
        )
        .eq('user_id', user.id)
        .eq('logical_date', today)
        .is('completed_at', null);

      if (!entries || entries.length === 0) {
        setSyncing(false);
        return;
      }

      // Aggregate product quantities (in containers) across all meal entries
      const productQty = new Map<string, number>();

      for (const entry of entries as any[]) {
        if (!entry.recipes?.recipe_ingredients) continue;
        const mealServings = Number(entry.servings) || 1;
        const baseServings = Number(entry.recipes.base_servings) || 1;
        const ratio = mealServings / baseServings;

        for (const ri of entry.recipes.recipe_ingredients) {
          const productId = ri.product_id as string;
          const qty = Number(ri.quantity) || 0;
          const unit = ri.unit as string;
          const spc = Number(ri.products?.servings_per_container) || 1;

          // Convert ingredient quantity to containers
          let containers: number;
          if (unit === 'container') {
            containers = qty * ratio;
          } else {
            // 'serving' unit — convert to containers
            containers = (qty * ratio) / spc;
          }

          const current = productQty.get(productId) ?? 0;
          productQty.set(productId, current + containers);
        }
      }

      // Also handle product-based entries (no recipe, just a product)
      for (const entry of entries as any[]) {
        if (entry.recipe_id) continue;
        // Re-fetch if product_id present but no recipe
        // The query above doesn't fetch product_id directly, so fetch separately
      }

      // Fetch product-based entries separately
      const { data: productEntries } = await chefbyte()
        .from('meal_plan_entries')
        .select('product_id, servings, products:product_id(servings_per_container)')
        .eq('user_id', user.id)
        .eq('logical_date', today)
        .is('completed_at', null)
        .is('recipe_id', null)
        .not('product_id', 'is', null);

      for (const pe of (productEntries ?? []) as any[]) {
        if (!pe.product_id) continue;
        const spc = Number(pe.products?.servings_per_container) || 1;
        const servings = Number(pe.servings) || 1;
        const containers = servings / spc;
        const current = productQty.get(pe.product_id) ?? 0;
        productQty.set(pe.product_id, current + containers);
      }

      // Upsert each product into shopping_list (round up to whole containers)
      for (const [productId, qty] of productQty) {
        const roundedQty = Math.ceil(qty);
        if (roundedQty <= 0) continue;

        await chefbyte().from('shopping_list').upsert(
          {
            user_id: user.id,
            product_id: productId,
            qty_containers: roundedQty,
            purchased: false,
          },
          { onConflict: 'user_id,product_id' },
        );
      }

      await loadData();
    } catch {
      setLoadError('Failed to sync meal plan to cart');
    } finally {
      setSyncing(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Mark meal done / execute prep                                    */
  /* ---------------------------------------------------------------- */

  const [confirmPrepId, setConfirmPrepId] = useState<string | null>(null);

  const markMealDone = async (mealId: string) => {
    const { error } = await (chefbyte() as any).rpc('mark_meal_done', { p_meal_id: mealId });
    if (!error) await loadData();
  };

  const executePrepMeal = async (mealId: string) => {
    setConfirmPrepId(null);
    const { error } = await (chefbyte() as any).rpc('mark_meal_done', { p_meal_id: mealId });
    if (!error) await loadData();
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Home">
        <div data-testid="home-loading">
          <CardSkeleton />
          <MacroBarSkeleton />
          <ListSkeleton rows={3} />
        </div>
      </ChefLayout>
    );
  }

  const consumed = macros?.consumed ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const goals = macros?.goals ?? { ...DEFAULT_MACRO_GOALS };

  /* Helper: progress bar colors */
  const macroColors = {
    calories: '#1e66f5',
    protein: '#22c55e',
    carbs: '#f59e0b',
    fat: '#ef4444',
  } as const;

  /* Helper: inline progress bar */
  const ProgressBar = ({
    value,
    goal,
    color,
    label,
    unit,
    testId,
  }: {
    value: number;
    goal: number;
    color: string;
    label: string;
    unit: string;
    testId: string;
  }) => {
    const pct = pctOf(value, goal);
    return (
      <div
        data-testid={testId}
        style={{ background: '#f7f7f9', border: '1px solid #eee', borderRadius: '8px', padding: '12px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <label style={{ fontWeight: 600, fontSize: '14px' }}>{label}</label>
          <span style={{ fontSize: '12px', fontWeight: 600, color }}>{pct}%</span>
        </div>
        <div
          data-testid={`${testId}-bar`}
          style={{
            width: '100%',
            height: '8px',
            background: '#e5e7eb',
            borderRadius: '4px',
            overflow: 'hidden',
            marginBottom: '4px',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: color,
              borderRadius: '4px',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <div style={{ fontSize: '13px', color: '#555' }}>
          {Math.round(value)} / {goal}
          {unit}
        </div>
      </div>
    );
  };

  /* Helper: button styles */
  const primaryBtnStyle: React.CSSProperties = {
    background: '#1e66f5',
    color: '#fff',
    border: 'none',
    padding: '10px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '14px',
  };

  const outlineBtnStyle: React.CSSProperties = {
    background: '#fff',
    color: '#1e66f5',
    border: '2px solid #1e66f5',
    padding: '10px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '14px',
  };

  return (
    <ChefLayout title="Home">
      {loadError && (
        <div
          data-testid="load-error"
          style={{
            border: '1px solid #ef4444',
            background: '#fef2f2',
            borderRadius: '8px',
            padding: '16px',
            marginBottom: '16px',
          }}
        >
          <p style={{ margin: '0 0 8px 0', color: '#d33' }}>Failed to load data: {loadError}</p>
          <button onClick={loadData} className="primary-btn" style={{ background: '#d33' }}>
            Retry
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/*  MACRO SUMMARY — progress bars, clickable to /chef/macros     */}
      {/* ============================================================ */}
      <div data-testid="macro-summary" style={{ marginBottom: '16px' }}>
        <div style={{ marginBottom: '8px' }}>
          <span style={{ fontWeight: 600 }}>Today</span>{' '}
          <span style={{ fontSize: '14px', color: '#666' }}>(6:00 AM - 5:59 AM)</span>
        </div>
        <Link to="/chef/macros" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <div
            data-testid="status-cards"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '12px',
              marginBottom: '12px',
              cursor: 'pointer',
            }}
          >
            <ProgressBar
              testId="compact-calories"
              label="Calories"
              value={consumed.calories}
              goal={goals.calories}
              color={macroColors.calories}
              unit=""
            />
            <ProgressBar
              testId="compact-protein"
              label="Protein"
              value={consumed.protein}
              goal={goals.protein}
              color={macroColors.protein}
              unit="g"
            />
            <ProgressBar
              testId="compact-carbs"
              label="Carbs"
              value={consumed.carbs}
              goal={goals.carbs}
              color={macroColors.carbs}
              unit="g"
            />
            <ProgressBar
              testId="compact-fats"
              label="Fats"
              value={consumed.fat}
              goal={goals.fat}
              color={macroColors.fat}
              unit="g"
            />
          </div>
        </Link>

        {/* Alert Badge Cards */}
        <div
          data-testid="card-missing-prices"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}
        >
          <Link
            to="/chef/inventory"
            data-testid="card-below-min"
            style={{
              textDecoration: 'none',
              color: belowMinStock > 0 ? '#fff' : '#666',
              background: belowMinStock > 0 ? '#f59e0b' : '#f0f0f0',
              padding: '8px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              display: 'inline-block',
            }}
          >
            Below Min Stock: {belowMinStock}
          </Link>
          <Link
            to="/chef/settings?tab=walmart"
            style={{
              textDecoration: 'none',
              color: missingPrices > 0 ? '#fff' : '#666',
              background: missingPrices > 0 ? '#ef4444' : '#f0f0f0',
              padding: '8px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              display: 'inline-block',
            }}
          >
            Missing Prices: {missingPrices}
          </Link>
          <Link
            to="/chef/settings?tab=products"
            data-testid="card-placeholders"
            style={{
              textDecoration: 'none',
              color: placeholders > 0 ? '#333' : '#666',
              background: placeholders > 0 ? '#fde68a' : '#f0f0f0',
              padding: '8px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              display: 'inline-block',
            }}
          >
            Placeholders: {placeholders}
          </Link>
          <Link
            to="/chef/shopping"
            data-testid="card-cart-value"
            style={{
              textDecoration: 'none',
              color: '#666',
              background: '#f0f0f0',
              padding: '8px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              display: 'inline-block',
            }}
          >
            Cart: ${cartValue.toFixed(2)}
          </Link>
        </div>

        {/* Action Buttons — standardized blue primary / outlined secondary */}
        <div data-testid="quick-actions" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button onClick={importShopping} data-testid="import-shopping-btn" style={primaryBtnStyle}>
            Import Shopping List
          </button>
          <button
            onClick={syncMealPlanToCart}
            disabled={syncing}
            data-testid="meal-plan-cart-btn"
            style={{
              ...primaryBtnStyle,
              opacity: syncing ? 0.6 : 1,
              cursor: syncing ? 'not-allowed' : 'pointer',
            }}
          >
            {syncing ? 'Syncing...' : 'Meal Plan \u2192 Cart'}
          </button>
          <button onClick={openTasteModal} data-testid="taste-profile-btn" style={outlineBtnStyle}>
            Taste Profile
          </button>
          <button onClick={openTargetModal} data-testid="target-macros-btn" style={outlineBtnStyle}>
            Target Macros
          </button>
        </div>
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
                  borderLeft: '4px solid #1e66f5',
                  borderRadius: '6px',
                  background: '#f7f7f9',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>{entry.recipes?.name ?? entry.products?.name ?? 'Unknown'}</span>
                  <span style={{ color: '#666', fontSize: '0.9em', marginLeft: '8px' }}>
                    {entry.servings} serving{entry.servings !== 1 ? 's' : ''}
                  </span>
                </div>
                {confirmPrepId === entry.meal_id ? (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: '#666' }}>Execute?</span>
                    <button
                      onClick={() => executePrepMeal(entry.meal_id)}
                      data-testid={`prep-confirm-${entry.meal_id}`}
                      style={{
                        background: '#22c55e',
                        color: '#fff',
                        border: 'none',
                        padding: '4px 10px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: '12px',
                      }}
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmPrepId(null)}
                      data-testid={`prep-cancel-${entry.meal_id}`}
                      style={{
                        background: '#e5e7eb',
                        color: '#333',
                        border: 'none',
                        padding: '4px 10px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: '12px',
                      }}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmPrepId(entry.meal_id)}
                    data-testid={`prep-execute-${entry.meal_id}`}
                    style={{
                      background: '#1e66f5',
                      color: '#fff',
                      border: 'none',
                      padding: '5px 12px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '12px',
                    }}
                  >
                    Execute
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/*  TODAY'S MEALS                                                */}
      {/* ============================================================ */}
      <div data-testid="todays-meals-section" style={{ marginBottom: '24px' }}>
        <h3>Today&apos;s Meals</h3>
        {todaysMeals.length === 0 ? (
          <p data-testid="no-todays-meals" style={{ color: '#666', fontStyle: 'italic' }}>
            No meals planned for today
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {todaysMeals.map((entry) => {
              const name = entry.recipes?.name ?? entry.products?.name ?? 'Unknown';
              const isDone = entry.completed_at !== null;

              // Calculate per-serving macros for this meal entry
              let mealMacros: { calories: number; protein: number; carbs: number; fat: number } | null = null;
              if (entry.recipes?.recipe_ingredients) {
                const perServing = computeRecipeMacros(entry.recipes.recipe_ingredients, 1);
                const servings = Number(entry.servings);
                mealMacros = {
                  calories: Math.round(perServing.calories * servings),
                  protein: Math.round(perServing.protein * servings),
                  carbs: Math.round(perServing.carbs * servings),
                  fat: Math.round(perServing.fat * servings),
                };
              } else if (entry.products) {
                const servings = Number(entry.servings);
                mealMacros = {
                  calories: Math.round(Number(entry.products.calories_per_serving) * servings),
                  protein: Math.round(Number(entry.products.protein_per_serving) * servings),
                  carbs: Math.round(Number(entry.products.carbs_per_serving) * servings),
                  fat: Math.round(Number(entry.products.fat_per_serving) * servings),
                };
              }

              return (
                <div
                  key={entry.meal_id}
                  data-testid={`meal-entry-${entry.meal_id}`}
                  style={{
                    padding: '10px 12px',
                    border: '1px solid #eee',
                    borderLeft: `4px solid ${isDone ? '#2f9e44' : '#ffc409'}`,
                    borderRadius: '6px',
                    background: isDone ? '#f0faf4' : '#f7f7f9',
                    opacity: isDone ? 0.8 : 1,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, textDecoration: isDone ? 'line-through' : 'none' }}>{name}</span>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      {entry.meal_type && (
                        <span
                          data-testid={`meal-type-${entry.meal_id}`}
                          style={{ fontSize: '0.75em', color: '#888', textTransform: 'capitalize' }}
                        >
                          {entry.meal_type}
                        </span>
                      )}
                      {isDone ? (
                        <span
                          data-testid={`meal-status-${entry.meal_id}`}
                          style={{
                            fontSize: '0.8em',
                            fontWeight: 600,
                            color: '#2f9e44',
                          }}
                        >
                          Done
                        </span>
                      ) : (
                        <button
                          onClick={() => markMealDone(entry.meal_id)}
                          data-testid={`meal-done-${entry.meal_id}`}
                          style={{
                            background: '#22c55e',
                            color: '#fff',
                            border: 'none',
                            padding: '4px 10px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '12px',
                          }}
                        >
                          Mark Done
                        </button>
                      )}
                    </div>
                  </div>
                  {mealMacros && (
                    <div
                      data-testid={`meal-macros-${entry.meal_id}`}
                      style={{ fontSize: '0.8em', color: '#666', marginTop: '4px' }}
                    >
                      {mealMacros.calories} cal | {mealMacros.protein}g P | {mealMacros.carbs}g C | {mealMacros.fat}g F
                    </div>
                  )}
                </div>
              );
            })}
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
        <div style={{ display: 'grid', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px', color: '#555' }}>
              Protein (g)
            </label>
            <input
              type="number"
              min={0}
              value={targetProtein}
              onChange={(e) => setTargetProtein(Number(e.target.value) || 0)}
              data-testid="target-protein"
              style={{
                width: '100%',
                padding: '10px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px', color: '#555' }}>
              Carbs (g)
            </label>
            <input
              type="number"
              min={0}
              value={targetCarbs}
              onChange={(e) => setTargetCarbs(Number(e.target.value) || 0)}
              data-testid="target-carbs"
              style={{
                width: '100%',
                padding: '10px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px', color: '#555' }}>
              Fats (g)
            </label>
            <input
              type="number"
              min={0}
              value={targetFat}
              onChange={(e) => setTargetFat(Number(e.target.value) || 0)}
              data-testid="target-fats"
              style={{
                width: '100%',
                padding: '10px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div data-testid="target-calories" style={{ padding: '8px', background: '#f7f7f9', borderRadius: '4px' }}>
            <strong>Calories (auto): </strong>
            {calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button
            onClick={() => setShowTargetModal(false)}
            className="primary-btn"
            style={{
              background: 'transparent',
              color: '#1e66f5',
              border: '1px solid #e5e7eb',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
            data-testid="target-cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={saveTargets}
            className="primary-btn"
            style={{
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
            data-testid="target-save-btn"
          >
            Save
          </button>
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
        <textarea
          value={tasteProfile}
          onChange={(e) => setTasteProfile(e.target.value ?? '')}
          data-testid="taste-textarea"
          rows={5}
          style={{
            width: '100%',
            padding: '10px',
            border: '1px solid #ddd',
            borderRadius: '6px',
            fontSize: '14px',
            resize: 'vertical',
            boxSizing: 'border-box',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button
            onClick={() => setShowTasteModal(false)}
            className="primary-btn"
            style={{
              background: 'transparent',
              color: '#1e66f5',
              border: '1px solid #e5e7eb',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
            data-testid="taste-cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={saveTasteProfile}
            className="primary-btn"
            style={{
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
            data-testid="taste-save-btn"
          >
            Save
          </button>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
