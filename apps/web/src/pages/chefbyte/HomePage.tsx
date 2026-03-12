import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChefHat, UtensilsCrossed, AlertTriangle, DollarSign, PackageSearch, ShoppingCart } from 'lucide-react';

import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';
import { computeRecipeMacros, computeStockStatus, type StockStatus } from '@/pages/chefbyte/RecipesPage';
import { CardSkeleton, MacroBarSkeleton, ListSkeleton } from '@/components/SkeletonScreen';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MacroTotals {
  consumed: { calories: number; protein: number; carbs: number; fat: number };
  goals: { calories: number; protein: number; carbs: number; fat: number };
}

interface FoodLogEntry {
  log_id: string;
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
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
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
    base_servings: number;
    recipe_ingredients: Array<{
      product_id: string;
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
  product_id: string | null;
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

export function computeMealEntryMacros(
  entry: MealEntry,
): { calories: number; protein: number; carbs: number; fat: number } | null {
  if (entry.recipes?.recipe_ingredients) {
    const perServing = computeRecipeMacros(entry.recipes.recipe_ingredients, 1);
    const servings = Number(entry.servings);
    return {
      calories: Math.round(perServing.calories * servings),
      protein: Math.round(perServing.protein * servings),
      carbs: Math.round(perServing.carbs * servings),
      fat: Math.round(perServing.fat * servings),
    };
  } else if (entry.products) {
    const servings = Number(entry.servings);
    return {
      calories: Math.round(Number(entry.products.calories_per_serving) * servings),
      protein: Math.round(Number(entry.products.protein_per_serving) * servings),
      carbs: Math.round(Number(entry.products.carbs_per_serving) * servings),
      fat: Math.round(Number(entry.products.fat_per_serving) * servings),
    };
  }
  return null;
}

/* ================================================================== */
/*  HomePage                                                           */
/* ================================================================== */

export function HomePage() {
  const { user } = useAuth();
  const { dayStartHour } = useAppContext();
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
  const [stockByProduct, setStockByProduct] = useState<Map<string, number>>(new Map());

  /* ---- Consumed items (food_logs + temp_items) ---- */
  const [foodLogs, setFoodLogs] = useState<FoodLogEntry[]>([]);
  const [tempItems, setTempItems] = useState<TempItemEntry[]>([]);

  /* ---- Two-click delete confirmation ---- */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

  const today = todayStr(dayStartHour);

  const loadData = useCallback(async () => {
    if (!userId) return;
    setLoadError(null);

    // 1. Status cards — missing prices (exclude [MEAL] lots)
    const { data: mp, error: mpErr } = await chefbyte()
      .from('products')
      .select('product_id')
      .eq('user_id', userId)
      .is('price', null)
      .not('name', 'ilike', '[MEAL]%');
    if (mpErr) {
      setLoadError(mpErr.message);
      return;
    }
    setMissingPrices((mp ?? []).length);

    // 2. Placeholders
    const { data: ph, error: phErr } = await chefbyte()
      .from('products')
      .select('product_id')
      .eq('user_id', userId)
      .eq('is_placeholder', true);
    if (phErr) {
      setLoadError(phErr.message);
      return;
    }
    setPlaceholders((ph ?? []).length);

    // 3. Below min stock — fetch products with min_stock_amount > 0, then batch-fetch stock_lots
    const { data: stockProducts, error: spErr } = await chefbyte()
      .from('products')
      .select('product_id, min_stock_amount')
      .eq('user_id', userId)
      .gt('min_stock_amount', 0);
    if (spErr) {
      setLoadError(spErr.message);
      return;
    }

    let belowCount = 0;
    const spArr = (stockProducts ?? []) as any[];
    if (spArr.length > 0) {
      const productIds = spArr.map((p: any) => p.product_id);
      const { data: allLots, error: lotsErr } = await chefbyte()
        .from('stock_lots')
        .select('product_id, qty_containers')
        .in('product_id', productIds);
      if (lotsErr) {
        setLoadError(lotsErr.message);
        return;
      }

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
    const { data: cartItems, error: cartErr } = await chefbyte()
      .from('shopping_list')
      .select('qty_containers, products:product_id(price)')
      .eq('user_id', userId);
    if (cartErr) {
      setLoadError(cartErr.message);
      return;
    }

    const total = (cartItems ?? []).reduce((sum: number, item: any) => {
      const price = Number(item.products?.price ?? 0);
      const qty = Number(item.qty_containers ?? 0);
      return sum + price * qty;
    }, 0);
    setCartValue(total);

    // 5. Macro day summary
    const { data: macroData, error: macroErr } = await (chefbyte() as any).rpc('get_daily_macros', {
      p_logical_date: today,
    });
    if (macroErr) {
      setLoadError(macroErr.message);
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

    // 6. Today's meal prep
    const { data: prepData, error: prepErr } = await chefbyte()
      .from('meal_plan_entries')
      .select('meal_id, servings, recipes:recipe_id(name), products:product_id(name)')
      .eq('user_id', userId)
      .eq('logical_date', today)
      .eq('meal_prep', true)
      .is('completed_at', null);
    if (prepErr) {
      setLoadError(prepErr.message);
      return;
    }
    setMealPrep((prepData ?? []) as MealPrepEntry[]);

    // 7. Today's meals (non-prep)
    const { data: mealsData, error: mealsErr } = await chefbyte()
      .from('meal_plan_entries')
      .select(
        'meal_id, servings, meal_type, completed_at, product_id, recipes:recipe_id(name, base_servings, recipe_ingredients(product_id, quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container)',
      )
      .eq('user_id', userId)
      .eq('logical_date', today)
      .eq('meal_prep', false);
    if (mealsErr) {
      setLoadError(mealsErr.message);
      return;
    }
    setTodaysMeals((mealsData ?? []) as MealEntry[]);

    // 8. Consumed items — food_logs + temp_items
    const { data: logData, error: logErr } = await chefbyte()
      .from('food_logs')
      .select('log_id, qty_consumed, unit, calories, protein, carbs, fat, products:product_id(name)')
      .eq('user_id', userId)
      .eq('logical_date', today);
    if (logErr) {
      setLoadError(logErr.message);
      return;
    }
    setFoodLogs((logData ?? []) as FoodLogEntry[]);

    const { data: tempData, error: tempErr } = await chefbyte()
      .from('temp_items')
      .select('temp_id, name, calories, protein, carbs, fat')
      .eq('user_id', userId)
      .eq('logical_date', today);
    if (tempErr) {
      setLoadError(tempErr.message);
      return;
    }
    setTempItems((tempData ?? []) as TempItemEntry[]);

    // 9. Stock by product — for stock availability badges on meals
    const { data: allStockLots, error: stockErr } = await chefbyte()
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', userId);
    if (stockErr) {
      setLoadError(stockErr.message);
      return;
    }
    const stockMap = new Map<string, number>();
    for (const lot of (allStockLots ?? []) as any[]) {
      const cur = stockMap.get(lot.product_id) ?? 0;
      stockMap.set(lot.product_id, cur + Number(lot.qty_containers));
    }
    setStockByProduct(stockMap);

    setLoading(false);
  }, [userId, today]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case

    loadData();
  }, [loadData]);

  /* ---------------------------------------------------------------- */
  /*  Realtime subscriptions                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('home-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'chefbyte', table: 'meal_plan_entries', filter: `user_id=eq.${user.id}` },
        () => loadData(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'chefbyte', table: 'food_logs', filter: `user_id=eq.${user.id}` },
        () => loadData(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'chefbyte', table: 'temp_items', filter: `user_id=eq.${user.id}` },
        () => loadData(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'chefbyte', table: 'stock_lots', filter: `user_id=eq.${user.id}` },
        () => loadData(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, loadData]);

  // Re-load on tab focus to catch midnight date changes
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') loadData();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
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
      const { error } = await chefbyte()
        .from('user_config')
        .upsert({ user_id: user.id, key, value }, { onConflict: 'user_id,key' });
      if (error) {
        setLoadError(error.message);
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
    const { error } = await chefbyte()
      .from('user_config')
      .upsert({ user_id: user.id, key: 'taste_profile', value: tasteProfile }, { onConflict: 'user_id,key' });
    if (error) {
      setLoadError(error.message);
      return;
    }
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
    if (!defaultLocationId) return; // No locations -- can't import

    // Get non-placeholder items from shopping list
    const { data: items } = await chefbyte()
      .from('shopping_list')
      .select('*, products:product_id(is_placeholder)')
      .eq('user_id', user.id)
      .eq('purchased', true);

    const validItems = ((items ?? []) as any[]).filter((item) => !item.products?.is_placeholder);
    if (validItems.length > 0) {
      // Merge stock lots: check for existing lot per item, increment qty or insert new
      let stockError = false;
      for (const item of validItems) {
        const { data: existingLot } = await chefbyte()
          .from('stock_lots')
          .select('lot_id, qty_containers')
          .eq('user_id', user.id)
          .eq('product_id', item.product_id)
          .eq('location_id', defaultLocationId)
          .is('expires_on', null)
          .single();

        if (existingLot) {
          const { error: updateErr } = await chefbyte()
            .from('stock_lots')
            .update({ qty_containers: Number((existingLot as any).qty_containers) + Number(item.qty_containers) })
            .eq('lot_id', (existingLot as any).lot_id);
          if (updateErr) {
            stockError = true;
            break;
          }
        } else {
          const { error: insertErr } = await chefbyte()
            .from('stock_lots')
            .insert({
              user_id: user.id,
              product_id: item.product_id,
              qty_containers: Number(item.qty_containers),
              location_id: defaultLocationId,
            });
          if (insertErr) {
            stockError = true;
            break;
          }
        }
      }

      // Only delete shopping items if all stock operations succeeded
      if (!stockError) {
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
            // 'serving' unit -- convert to containers
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
    if (error) {
      setLoadError(error.message);
      return;
    }
    await loadData();
  };

  const unmarkMealDone = async (mealId: string) => {
    const { error } = await (chefbyte() as any).rpc('unmark_meal_done', { p_meal_id: mealId });
    if (error) {
      setLoadError(error.message);
      return;
    }
    await loadData();
  };

  const executePrepMeal = async (mealId: string) => {
    setConfirmPrepId(null);
    const { error } = await (chefbyte() as any).rpc('mark_meal_done', { p_meal_id: mealId });
    if (error) {
      setLoadError(error.message);
      return;
    }
    await loadData();
  };

  /* ---------------------------------------------------------------- */
  /*  Delete handlers (two-click confirm)                              */
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
    const { error } = await chefbyte().from('food_logs').delete().eq('log_id', logId);
    if (error) {
      setLoadError(error.message);
      return;
    }
    await loadData();
  };

  const deleteTempItem = async (tempId: string) => {
    const { error } = await chefbyte().from('temp_items').delete().eq('temp_id', tempId);
    if (error) {
      setLoadError(error.message);
      return;
    }
    await loadData();
  };

  const deleteMealEntry = async (mealId: string) => {
    const { error } = await chefbyte().from('meal_plan_entries').delete().eq('meal_id', mealId);
    if (error) {
      setLoadError(error.message);
      return;
    }
    await loadData();
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

  // Compute planned macros from uncompleted meal entries
  const planned = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const entry of todaysMeals) {
    if (entry.completed_at) continue;
    const m = computeMealEntryMacros(entry);
    if (m) {
      planned.calories += m.calories;
      planned.protein += m.protein;
      planned.carbs += m.carbs;
      planned.fat += m.fat;
    }
  }

  /* Helper: progress bar colors */
  const macroColors = {
    calories: 'bg-emerald-600',
    protein: 'bg-green-500',
    carbs: 'bg-amber-500',
    fat: 'bg-red-500',
  } as const;

  const macroColorValues = {
    calories: '#059669',
    protein: '#22c55e',
    carbs: '#f59e0b',
    fat: '#ef4444',
  } as const;

  /* Helper: inline progress bar with optional planned segment */
  const ProgressBar = ({
    value,
    plannedValue,
    goal,
    color,
    colorClass,
    label,
    unit,
    testId,
  }: {
    value: number;
    plannedValue?: number;
    goal: number;
    color: string;
    colorClass: string;
    label: string;
    unit: string;
    testId: string;
  }) => {
    const pct = pctOf(value, goal);
    const plannedPct = plannedValue ? Math.min(pctOf(value + plannedValue, goal), 100) : 0;
    return (
      <div data-testid={testId} className="bg-white/70 border border-slate-200/60 rounded-lg p-3.5">
        <div className="flex justify-between items-center mb-1.5">
          <label className="font-semibold text-sm text-slate-700">{label}</label>
          <span className="text-xs font-bold tabular-nums" style={{ color }}>
            {pct}%
          </span>
        </div>
        <div
          data-testid={`${testId}-bar`}
          className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden relative mb-1"
        >
          {plannedPct > pct && (
            <div
              data-testid={`${testId}-planned`}
              className={`absolute inset-y-0 left-0 rounded-full ${colorClass} opacity-30`}
              style={{ width: `${plannedPct}%` }}
            />
          )}
          <div
            className={`relative h-full rounded-full ${colorClass} transition-all duration-300`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-xs text-slate-500">
          {Math.round(value)}
          {plannedValue ? ` + ${Math.round(plannedValue)} planned` : ''} / {goal}
          {unit}
        </div>
      </div>
    );
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

  /* Helper: stock badge classes */
  const stockBadgeClass = (status: StockStatus) => {
    const base = 'inline-block px-1.5 py-0.5 rounded text-[10px] font-bold text-white';
    switch (status) {
      case 'CAN MAKE':
        return `${base} bg-green-600`;
      case 'PARTIAL':
        return `${base} bg-amber-500`;
      case 'NO STOCK':
        return `${base} bg-red-600`;
      case 'N/A':
        return `${base} bg-slate-400`;
    }
  };

  return (
    <ChefLayout title="Home">
      {loadError && (
        <div data-testid="load-error" className="border border-red-400 bg-red-50 rounded-lg p-4 mb-4">
          <p className="m-0 mb-2 text-red-600">Failed to load data: {loadError}</p>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-red-600 text-white rounded-md font-semibold text-sm hover:bg-red-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/*  MACRO SUMMARY — hero card, clickable to /chef/macros         */}
      {/* ============================================================ */}
      <div data-testid="macro-summary" className="mb-5">
        <Link to="/chef/macros" className="no-underline text-inherit block">
          <div className="bg-gradient-to-br from-slate-50 to-emerald-50 border border-slate-200 rounded-xl p-4 shadow-sm hover:shadow transition-shadow">
            <div className="mb-3">
              <span className="font-bold text-base text-slate-900">Today</span>{' '}
              <span className="text-sm text-slate-500">(6:00 AM - 5:59 AM)</span>
            </div>
            <div data-testid="status-cards" className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 cursor-pointer">
              <ProgressBar
                testId="compact-calories"
                label="Calories"
                value={consumed.calories}
                plannedValue={planned.calories}
                goal={goals.calories}
                color={macroColorValues.calories}
                colorClass={macroColors.calories}
                unit=""
              />
              <ProgressBar
                testId="compact-protein"
                label="Protein"
                value={consumed.protein}
                plannedValue={planned.protein}
                goal={goals.protein}
                color={macroColorValues.protein}
                colorClass={macroColors.protein}
                unit="g"
              />
              <ProgressBar
                testId="compact-carbs"
                label="Carbs"
                value={consumed.carbs}
                plannedValue={planned.carbs}
                goal={goals.carbs}
                color={macroColorValues.carbs}
                colorClass={macroColors.carbs}
                unit="g"
              />
              <ProgressBar
                testId="compact-fats"
                label="Fats"
                value={consumed.fat}
                plannedValue={planned.fat}
                goal={goals.fat}
                color={macroColorValues.fat}
                colorClass={macroColors.fat}
                unit="g"
              />
            </div>
          </div>
        </Link>
      </div>

      {/* ============================================================ */}
      {/*  NOTIFICATION STRIP — compact alert badges                    */}
      {/* ============================================================ */}
      <div data-testid="card-missing-prices" className="grid grid-cols-2 sm:flex sm:items-center gap-1.5 sm:gap-2 mb-3">
        <Link
          to="/chef/inventory"
          data-testid="card-below-min"
          className={[
            'no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium transition-colors',
            belowMinStock > 0 ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'bg-slate-100 text-slate-400',
          ].join(' ')}
        >
          <AlertTriangle className="w-3 h-3" />
          Stock: {belowMinStock}
        </Link>
        <Link
          to="/chef/settings?tab=walmart"
          className={[
            'no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium transition-colors',
            missingPrices > 0 ? 'bg-red-100 text-red-600 hover:bg-red-200' : 'bg-slate-100 text-slate-400',
          ].join(' ')}
        >
          <DollarSign className="w-3 h-3" />
          Prices: {missingPrices}
        </Link>
        <Link
          to="/chef/settings?tab=products"
          data-testid="card-placeholders"
          className="no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-slate-100 text-slate-400 hover:bg-slate-200 transition-colors"
        >
          <PackageSearch className="w-3 h-3" />
          Placeholders: {placeholders}
        </Link>
        <Link
          to="/chef/shopping"
          data-testid="card-cart-value"
          className="no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-slate-100 text-slate-400 hover:bg-slate-200 transition-colors"
        >
          <ShoppingCart className="w-3 h-3" />
          Cart: ${cartValue.toFixed(2)}
        </Link>
      </div>

      {/* ============================================================ */}
      {/*  ACTION BUTTONS — primary workflow + secondary settings        */}
      {/* ============================================================ */}
      <div data-testid="quick-actions" className="mb-5 space-y-2">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-2">
          <button
            onClick={importShopping}
            data-testid="import-shopping-btn"
            className="px-3 py-2 sm:py-1.5 bg-emerald-600 text-white rounded-md font-semibold text-xs hover:bg-emerald-700 transition-colors"
          >
            Import Shopping List
          </button>
          <button
            onClick={syncMealPlanToCart}
            disabled={syncing}
            data-testid="meal-plan-cart-btn"
            className="px-3 py-2 sm:py-1.5 bg-emerald-600 text-white rounded-md font-semibold text-xs hover:bg-emerald-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {syncing ? 'Syncing...' : 'Meal Plan \u2192 Cart'}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={openTasteModal}
            data-testid="taste-profile-btn"
            className="px-2 py-1 text-slate-500 text-xs hover:text-emerald-600 hover:underline transition-colors bg-transparent border-none cursor-pointer"
          >
            Taste Profile
          </button>
          <button
            onClick={openTargetModal}
            data-testid="target-macros-btn"
            className="px-2 py-1 text-slate-500 text-xs hover:text-emerald-600 hover:underline transition-colors bg-transparent border-none cursor-pointer"
          >
            Target Macros
          </button>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  CONSUMED TODAY                                               */}
      {/* ============================================================ */}
      {(foodLogs.length > 0 || tempItems.length > 0) && (
        <div data-testid="consumed-section" className="mb-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-3">Consumed Today</h3>
          <div className="flex flex-col gap-1.5">
            {foodLogs.map((log) => (
              <div
                key={log.log_id}
                data-testid={`consumed-log-${log.log_id}`}
                className="py-2 px-3 border border-slate-200 border-l-4 border-l-green-500 rounded-md bg-green-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <span className="font-semibold text-sm text-slate-900 min-w-0">
                    {log.products?.name ?? 'Unknown'}
                    <span className="font-normal text-slate-500 text-xs ml-2">
                      {Number(log.qty_consumed)} {log.unit}
                      {Number(log.qty_consumed) !== 1 ? 's' : ''}
                    </span>
                  </span>
                  <DeleteBtn
                    id={`log-${log.log_id}`}
                    onConfirm={() => deleteFoodLog(log.log_id)}
                    testId={`delete-log-${log.log_id}`}
                  />
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {Math.round(Number(log.calories))} cal | {Math.round(Number(log.protein))}g P |{' '}
                  {Math.round(Number(log.carbs))}g C | {Math.round(Number(log.fat))}g F
                </div>
              </div>
            ))}
            {tempItems.map((item) => (
              <div
                key={item.temp_id}
                data-testid={`consumed-temp-${item.temp_id}`}
                className="py-2 px-3 border border-slate-200 border-l-4 border-l-amber-500 rounded-md bg-amber-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <span className="font-semibold text-sm text-slate-900 min-w-0">
                    {item.name}
                    <span className="font-normal text-slate-400 text-xs ml-1.5">quick-add</span>
                  </span>
                  <DeleteBtn
                    id={`temp-${item.temp_id}`}
                    onConfirm={() => deleteTempItem(item.temp_id)}
                    testId={`delete-temp-${item.temp_id}`}
                  />
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {Math.round(Number(item.calories))} cal | {Math.round(Number(item.protein))}g P |{' '}
                  {Math.round(Number(item.carbs))}g C | {Math.round(Number(item.fat))}g F
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/*  TODAY'S MEAL PREP — amber accent                             */}
      {/* ============================================================ */}
      <div data-testid="meal-prep-section" className="mb-6 border-l-4 border-l-amber-400 pl-3">
        <h3 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <ChefHat className="w-5 h-5 text-amber-500" />
          Today&apos;s Meal Prep
        </h3>
        {mealPrep.length === 0 ? (
          <p data-testid="no-meal-prep" className="text-slate-500 italic">
            No meal prep scheduled for today
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {mealPrep.map((entry) => (
              <div
                key={entry.meal_id}
                data-testid={`prep-entry-${entry.meal_id}`}
                className="py-2.5 px-3 border border-slate-200 border-l-4 border-l-emerald-600 rounded-md bg-slate-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-900">
                      {entry.recipes?.name ?? entry.products?.name ?? 'Unknown'}
                    </span>
                    <span className="text-slate-500 text-sm ml-2">
                      {entry.servings} serving{entry.servings !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="flex gap-1.5 items-center shrink-0">
                    {confirmPrepId === entry.meal_id ? (
                      <>
                        <span className="text-xs text-slate-500">Execute?</span>
                        <button
                          onClick={() => executePrepMeal(entry.meal_id)}
                          data-testid={`prep-confirm-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-green-500 text-white rounded text-xs font-semibold hover:bg-green-600 transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmPrepId(null)}
                          data-testid={`prep-cancel-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-slate-200 text-slate-700 rounded text-xs font-semibold hover:bg-slate-300 transition-colors"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmPrepId(entry.meal_id)}
                        data-testid={`prep-execute-${entry.meal_id}`}
                        className="px-3 py-1 bg-emerald-600 text-white rounded text-xs font-semibold hover:bg-emerald-700 transition-colors"
                      >
                        Execute
                      </button>
                    )}
                    <DeleteBtn
                      id={`prep-${entry.meal_id}`}
                      onConfirm={() => deleteMealEntry(entry.meal_id)}
                      testId={`delete-prep-${entry.meal_id}`}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/*  TODAY'S MEALS — green accent                                 */}
      {/* ============================================================ */}
      <div data-testid="todays-meals-section" className="mb-6 border-l-4 border-l-green-500 pl-3">
        <h3 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <UtensilsCrossed className="w-5 h-5 text-green-600" />
          Today&apos;s Meals
        </h3>
        {todaysMeals.length === 0 ? (
          <p data-testid="no-todays-meals" className="text-slate-500 italic">
            No meals planned for today
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {todaysMeals.map((entry) => {
              const name = entry.recipes?.name ?? entry.products?.name ?? 'Unknown';
              const isDone = entry.completed_at !== null;

              // Stock status for this meal
              let mealStockStatus: StockStatus = 'N/A';
              if (!isDone) {
                if (entry.recipes?.recipe_ingredients) {
                  const scaleFactor = Number(entry.servings) / (Number(entry.recipes.base_servings) || 1);
                  const scaledIngredients = entry.recipes.recipe_ingredients.map((ing) => ({
                    ...ing,
                    quantity: Number(ing.quantity) * scaleFactor,
                  }));
                  mealStockStatus = computeStockStatus(scaledIngredients, stockByProduct);
                } else if (entry.product_id && entry.products) {
                  const spc = Number(entry.products.servings_per_container) || 1;
                  const neededContainers = Number(entry.servings) / spc;
                  const available = stockByProduct.get(entry.product_id) ?? 0;
                  mealStockStatus = available >= neededContainers ? 'CAN MAKE' : available > 0 ? 'PARTIAL' : 'NO STOCK';
                }
              }

              const mealMacros = computeMealEntryMacros(entry);

              return (
                <div
                  key={entry.meal_id}
                  data-testid={`meal-entry-${entry.meal_id}`}
                  className={[
                    'py-2.5 px-3 border border-slate-200 border-l-4 rounded-md',
                    isDone ? 'border-l-green-600 bg-green-50 opacity-80' : 'border-l-amber-400 bg-slate-50',
                  ].join(' ')}
                >
                  {/* Content + actions: stack on mobile, side-by-side on sm+ */}
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2">
                    {/* Top: name, badge, meal type, macros */}
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5 items-center">
                        <span className={['font-semibold text-slate-900', isDone ? 'line-through' : ''].join(' ')}>
                          {name}
                        </span>
                        {!isDone && mealStockStatus !== 'N/A' && (
                          <span
                            data-testid={`meal-stock-${entry.meal_id}`}
                            className={stockBadgeClass(mealStockStatus)}
                          >
                            {mealStockStatus === 'CAN MAKE' ? '✓ IN STOCK' : mealStockStatus}
                          </span>
                        )}
                      </div>
                      {entry.meal_type && (
                        <span data-testid={`meal-type-${entry.meal_id}`} className="text-xs text-slate-400 capitalize">
                          {entry.meal_type}
                        </span>
                      )}
                      {mealMacros && (
                        <div data-testid={`meal-macros-${entry.meal_id}`} className="text-xs text-slate-500 mt-1">
                          {mealMacros.calories} cal | {mealMacros.protein}g P | {mealMacros.carbs}g C | {mealMacros.fat}
                          g F
                        </div>
                      )}
                    </div>
                    {/* Bottom on mobile, right side on sm+: action buttons */}
                    <div className="flex gap-1.5 items-center sm:shrink-0 sm:ml-1">
                      {isDone ? (
                        <button
                          onClick={() => unmarkMealDone(entry.meal_id)}
                          data-testid={`meal-undo-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-white text-amber-500 border border-amber-500 rounded text-xs font-semibold hover:bg-amber-50 transition-colors"
                        >
                          Undo
                        </button>
                      ) : (
                        <button
                          onClick={() => markMealDone(entry.meal_id)}
                          data-testid={`meal-done-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-green-500 text-white rounded text-xs font-semibold hover:bg-green-600 transition-colors"
                        >
                          Mark Done
                        </button>
                      )}
                      <DeleteBtn
                        id={`meal-${entry.meal_id}`}
                        onConfirm={() => deleteMealEntry(entry.meal_id)}
                        testId={`delete-meal-${entry.meal_id}`}
                      />
                    </div>
                  </div>
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
        <div className="grid gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Protein (g)</label>
            <input
              type="number"
              min={0}
              value={targetProtein}
              onChange={(e) => setTargetProtein(Number(e.target.value) || 0)}
              data-testid="target-protein"
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Carbs (g)</label>
            <input
              type="number"
              min={0}
              value={targetCarbs}
              onChange={(e) => setTargetCarbs(Number(e.target.value) || 0)}
              data-testid="target-carbs"
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Fats (g)</label>
            <input
              type="number"
              min={0}
              value={targetFat}
              onChange={(e) => setTargetFat(Number(e.target.value) || 0)}
              data-testid="target-fats"
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
          </div>
          <div data-testid="target-calories" className="p-2 bg-slate-50 rounded text-sm">
            <strong>Calories (auto): </strong>
            {calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat)}
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            onClick={() => setShowTargetModal(false)}
            className="px-4 py-2 bg-white border border-slate-300 text-slate-600 rounded-md text-sm hover:bg-slate-50 transition-colors"
            data-testid="target-cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={saveTargets}
            className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
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
          className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm resize-y font-[inherit] focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
        />
        <div className="flex gap-2 justify-end mt-4">
          <button
            onClick={() => setShowTasteModal(false)}
            className="px-4 py-2 bg-white border border-slate-300 text-slate-600 rounded-md text-sm hover:bg-slate-50 transition-colors"
            data-testid="taste-cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={saveTasteProfile}
            className="px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
            data-testid="taste-save-btn"
          >
            Save
          </button>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
