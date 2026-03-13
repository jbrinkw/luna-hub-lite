import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ChefHat,
  UtensilsCrossed,
  AlertTriangle,
  DollarSign,
  PackageSearch,
  ShoppingCart,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { DEFAULT_MACRO_GOALS } from '@/shared/constants';
import { calcCaloriesFromMacros } from '@/pages/chefbyte/MacroPage';
import { computeRecipeMacros, computeStockStatus, type StockStatus } from '@/pages/chefbyte/RecipesPage';
import { CardSkeleton, MacroBarSkeleton, ListSkeleton } from '@/components/SkeletonScreen';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';

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
  meal_id: string | null;
  products: { name: string } | null;
  meal_plan_entries: {
    recipes: { name: string } | null;
    products: { name: string } | null;
  } | null;
}

interface MealGroup {
  meal_id: string;
  mealName: string;
  logs: FoodLogEntry[];
  totalCalories: number;
  totalProtein: number;
  totalCarbs: number;
  totalFat: number;
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

interface HomePageData {
  missingPrices: number;
  placeholders: number;
  belowMinStock: number;
  cartValue: number;
  macros: MacroTotals | null;
  mealPrep: MealPrepEntry[];
  todaysMeals: MealEntry[];
  foodLogs: FoodLogEntry[];
  tempItems: TempItemEntry[];
  stockByProduct: Map<string, number>;
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
  const queryClient = useQueryClient();
  const userId = user?.id;

  /* ---- Consumed meal expand/collapse ---- */
  const [expandedMeals, setExpandedMeals] = useState<Set<string>>(new Set());

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

  const [mutationError, setMutationError] = useState<string | null>(null);

  /* ---- Meal Plan -> Cart ---- */
  const [syncing, setSyncing] = useState(false);

  /* ---- Prep confirm ---- */
  const [confirmPrepId, setConfirmPrepId] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading via useQuery                                        */
  /* ---------------------------------------------------------------- */

  const today = todayStr(dayStartHour);

  // Use a stable composite key for all homepage data
  const homeQueryKey = ['chef-home', userId, today] as const;

  const {
    data,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey: [...homeQueryKey],
    queryFn: async (): Promise<HomePageData> => {
      // Fire all independent queries in parallel
      const [mpRes, phRes, spRes, cartRes, macroRes, prepRes, mealsRes, logRes, tempRes, stockRes] = await Promise.all([
        // 1. Missing prices
        chefbyte()
          .from('products')
          .select('product_id')
          .eq('user_id', userId!)
          .is('price', null)
          .not('name', 'ilike', '[MEAL]%'),
        // 2. Placeholders
        chefbyte().from('products').select('product_id').eq('user_id', userId!).eq('is_placeholder', true),
        // 3. Products with min_stock
        chefbyte()
          .from('products')
          .select('product_id, min_stock_amount')
          .eq('user_id', userId!)
          .gt('min_stock_amount', 0),
        // 4. Cart value
        chefbyte().from('shopping_list').select('qty_containers, products:product_id(price)').eq('user_id', userId!),
        // 5. Macro summary
        (chefbyte() as any).rpc('get_daily_macros', { p_logical_date: today }),
        // 6. Meal prep
        chefbyte()
          .from('meal_plan_entries')
          .select('meal_id, servings, recipes:recipe_id(name), products:product_id(name)')
          .eq('user_id', userId!)
          .eq('logical_date', today)
          .eq('meal_prep', true)
          .is('completed_at', null),
        // 7. Today's meals
        chefbyte()
          .from('meal_plan_entries')
          .select(
            'meal_id, servings, meal_type, completed_at, product_id, recipes:recipe_id(name, base_servings, recipe_ingredients(product_id, quantity, unit, products:product_id(calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))), products:product_id(name, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container)',
          )
          .eq('user_id', userId!)
          .eq('logical_date', today)
          .eq('meal_prep', false),
        // 8. Food logs
        chefbyte()
          .from('food_logs')
          .select(
            'log_id, qty_consumed, unit, calories, protein, carbs, fat, meal_id, products:product_id(name), meal_plan_entries:meal_id(recipes:recipe_id(name), products:product_id(name))',
          )
          .eq('user_id', userId!)
          .eq('logical_date', today),
        // 9. Temp items
        chefbyte()
          .from('temp_items')
          .select('temp_id, name, calories, protein, carbs, fat')
          .eq('user_id', userId!)
          .eq('logical_date', today),
        // 10. All stock lots
        chefbyte().from('stock_lots').select('product_id, qty_containers').eq('user_id', userId!),
      ]);

      // Check for errors
      const firstError = [mpRes, phRes, spRes, cartRes, macroRes, prepRes, mealsRes, logRes, tempRes, stockRes].find(
        (r) => r.error,
      );
      if (firstError?.error) throw new Error(firstError.error.message);

      // 1. Missing prices
      const missingPrices = (mpRes.data ?? []).length;

      // 2. Placeholders
      const placeholders = (phRes.data ?? []).length;

      // 3. Below min stock
      const spArr = (spRes.data ?? []) as any[];
      let belowCount = 0;
      const stockMap = new Map<string, number>();

      // Build stock map first (needed for both below-min-stock and meal stock status)
      for (const lot of (stockRes.data ?? []) as any[]) {
        const cur = stockMap.get(lot.product_id) ?? 0;
        stockMap.set(lot.product_id, cur + Number(lot.qty_containers));
      }

      if (spArr.length > 0) {
        const minStockIds = new Set(spArr.map((p: any) => p.product_id));
        const stockByMinProduct = new Map<string, number>();
        for (const lot of (stockRes.data ?? []) as any[]) {
          if (!minStockIds.has(lot.product_id)) continue;
          const current = stockByMinProduct.get(lot.product_id) ?? 0;
          stockByMinProduct.set(lot.product_id, current + Number(lot.qty_containers));
        }
        for (const p of spArr) {
          const totalStock = stockByMinProduct.get(p.product_id) ?? 0;
          if (totalStock < Number(p.min_stock_amount)) belowCount++;
        }
      }

      // 4. Cart value
      const cartValue = (cartRes.data ?? []).reduce((sum: number, item: any) => {
        const price = Number(item.products?.price ?? 0);
        const qty = Number(item.qty_containers ?? 0);
        return sum + price * qty;
      }, 0);

      // 5. Macros
      let macros: MacroTotals | null = null;
      if (macroRes.data) {
        const rpc = macroRes.data as Record<string, { consumed: number; goal: number; remaining: number }>;
        macros = {
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
        };
      }

      return {
        missingPrices,
        placeholders,
        belowMinStock: belowCount,
        cartValue,
        macros,
        mealPrep: (prepRes.data ?? []) as MealPrepEntry[],
        todaysMeals: (mealsRes.data ?? []) as MealEntry[],
        foodLogs: (logRes.data ?? []) as FoodLogEntry[],
        tempItems: (tempRes.data ?? []) as TempItemEntry[],
        stockByProduct: stockMap,
      };
    },
    enabled: !!userId,
  });

  /* ---------------------------------------------------------------- */
  /*  Realtime invalidation                                            */
  /* ---------------------------------------------------------------- */

  useRealtimeInvalidation('chef-home', [
    { schema: 'chefbyte', table: 'food_logs', queryKeys: [homeQueryKey] },
    { schema: 'chefbyte', table: 'temp_items', queryKeys: [homeQueryKey] },
    { schema: 'chefbyte', table: 'stock_lots', queryKeys: [homeQueryKey] },
    { schema: 'chefbyte', table: 'meal_plan_entries', queryKeys: [homeQueryKey] },
    { schema: 'chefbyte', table: 'shopping_list', queryKeys: [homeQueryKey] },
  ]);

  const invalidateHome = () => queryClient.invalidateQueries({ queryKey: homeQueryKey });

  /* ---------------------------------------------------------------- */
  /*  Extract data from query result                                   */
  /* ---------------------------------------------------------------- */

  const missingPrices = data?.missingPrices ?? 0;
  const placeholders = data?.placeholders ?? 0;
  const belowMinStock = data?.belowMinStock ?? 0;
  const cartValue = data?.cartValue ?? 0;
  const macros = data?.macros ?? null;
  const mealPrep = data?.mealPrep ?? [];
  const todaysMeals = data?.todaysMeals ?? [];
  const foodLogs = data?.foodLogs ?? [];
  const tempItems = data?.tempItems ?? [];
  const stockByProduct = data?.stockByProduct ?? new Map<string, number>();

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

  const saveTargetsMutation = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const calories = calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat);
      const keys = [
        { key: 'goal_calories', value: String(calories) },
        { key: 'goal_protein', value: String(targetProtein) },
        { key: 'goal_carbs', value: String(targetCarbs) },
        { key: 'goal_fat', value: String(targetFat) },
      ];
      const results = await Promise.all(
        keys.map(({ key, value }) =>
          chefbyte().from('user_config').upsert({ user_id: user.id, key, value }, { onConflict: 'user_id,key' }),
        ),
      );
      const firstError = results.find((r) => r.error);
      if (firstError?.error) throw new Error(firstError.error.message);
    },
    onSuccess: () => {
      setShowTargetModal(false);
      invalidateHome();
    },
    onError: (err: Error) => setMutationError(err.message),
  });

  /* ---------------------------------------------------------------- */
  /*  Taste Profile modal actions                                      */
  /* ---------------------------------------------------------------- */

  const openTasteModal = async () => {
    if (!user) return;
    const { data: configData } = await chefbyte()
      .from('user_config')
      .select('value')
      .eq('user_id', user.id)
      .eq('key', 'taste_profile')
      .single();
    setTasteProfile((configData as any)?.value ?? '');
    setShowTasteModal(true);
  };

  const saveTasteMutation = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const { error } = await chefbyte()
        .from('user_config')
        .upsert({ user_id: user.id, key: 'taste_profile', value: tasteProfile }, { onConflict: 'user_id,key' });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => setShowTasteModal(false),
    onError: (err: Error) => setMutationError(err.message),
  });

  /* ---------------------------------------------------------------- */
  /*  Quick actions                                                    */
  /* ---------------------------------------------------------------- */

  const importShoppingMutation = useMutation({
    mutationFn: async () => {
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
    },
    onSettled: () => invalidateHome(),
  });

  /* ---------------------------------------------------------------- */
  /*  Meal Plan -> Cart                                                */
  /* ---------------------------------------------------------------- */

  const syncMealPlanToCart = async () => {
    if (!user) return;
    setSyncing(true);
    setMutationError(null);

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

      invalidateHome();
    } catch {
      setMutationError('Failed to sync meal plan to cart');
    } finally {
      setSyncing(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Mark meal done / execute prep                                    */
  /* ---------------------------------------------------------------- */

  const markMealDoneMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { error } = await (chefbyte() as any).rpc('mark_meal_done', { p_meal_id: mealId });
      if (error) throw new Error(error.message);
    },
    onError: (err: Error) => setMutationError(err.message),
    onSettled: () => invalidateHome(),
  });

  const unmarkMealDoneMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { error } = await (chefbyte() as any).rpc('unmark_meal_done', { p_meal_id: mealId });
      if (error) throw new Error(error.message);
    },
    onError: (err: Error) => setMutationError(err.message),
    onSettled: () => invalidateHome(),
  });

  const executePrepMeal = async (mealId: string) => {
    setConfirmPrepId(null);
    markMealDoneMutation.mutate(mealId);
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

  const deleteFoodLogMutation = useMutation({
    mutationFn: async (logId: string) => {
      const { error } = await chefbyte().from('food_logs').delete().eq('log_id', logId);
      if (error) throw new Error(error.message);
    },
    onError: (err: Error) => setMutationError(err.message),
    onSettled: () => invalidateHome(),
  });

  const deleteMealLogsMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { error } = await chefbyte().from('food_logs').delete().eq('meal_id', mealId);
      if (error) throw new Error(error.message);
      return mealId;
    },
    onSuccess: (mealId: string | undefined) => {
      if (mealId) {
        setExpandedMeals((prev) => {
          const next = new Set(prev);
          next.delete(mealId);
          return next;
        });
      }
    },
    onError: (err: Error) => setMutationError(err.message),
    onSettled: () => invalidateHome(),
  });

  const toggleMealExpand = (mealId: string) => {
    setExpandedMeals((prev) => {
      const next = new Set(prev);
      if (next.has(mealId)) next.delete(mealId);
      else next.add(mealId);
      return next;
    });
  };

  /* Group food_logs by meal_id */
  const { mealGroups, standaloneLogs } = (() => {
    const groups = new Map<string, MealGroup>();
    const standalone: FoodLogEntry[] = [];
    for (const log of foodLogs) {
      if (!log.meal_id) {
        standalone.push(log);
        continue;
      }
      let group = groups.get(log.meal_id);
      if (!group) {
        const mpe = log.meal_plan_entries;
        const mealName = mpe?.recipes?.name ?? mpe?.products?.name ?? 'Meal';
        group = {
          meal_id: log.meal_id,
          mealName,
          logs: [],
          totalCalories: 0,
          totalProtein: 0,
          totalCarbs: 0,
          totalFat: 0,
        };
        groups.set(log.meal_id, group);
      }
      group.logs.push(log);
      group.totalCalories += Number(log.calories);
      group.totalProtein += Number(log.protein);
      group.totalCarbs += Number(log.carbs);
      group.totalFat += Number(log.fat);
    }
    return { mealGroups: Array.from(groups.values()), standaloneLogs: standalone };
  })();

  const deleteTempItemMutation = useMutation({
    mutationFn: async (tempId: string) => {
      const { error } = await chefbyte().from('temp_items').delete().eq('temp_id', tempId);
      if (error) throw new Error(error.message);
    },
    onError: (err: Error) => setMutationError(err.message),
    onSettled: () => invalidateHome(),
  });

  const deleteMealEntryMutation = useMutation({
    mutationFn: async (mealId: string) => {
      const { error } = await chefbyte().from('meal_plan_entries').delete().eq('meal_id', mealId);
      if (error) throw new Error(error.message);
    },
    onError: (err: Error) => setMutationError(err.message),
    onSettled: () => invalidateHome(),
  });

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (isLoading) {
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
    calories: 'bg-success',
    protein: 'bg-success',
    carbs: 'bg-amber-500',
    fat: 'bg-danger',
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
      <div data-testid={testId} className="bg-surface/70 border border-border/60 rounded-lg p-3.5">
        <div className="flex justify-between items-center mb-1.5">
          <label className="font-semibold text-sm text-text-secondary">{label}</label>
          <span className="text-xs font-bold tabular-nums" style={{ color }}>
            {pct}%
          </span>
        </div>
        <div
          data-testid={`${testId}-bar`}
          className="w-full h-2.5 bg-border rounded-full overflow-hidden relative mb-1"
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
        <div className="text-xs text-text-secondary">
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
          ? 'bg-danger text-white border-none'
          : 'bg-transparent text-danger-text border border-danger hover:bg-danger-subtle',
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
        return `${base} bg-success`;
      case 'PARTIAL':
        return `${base} bg-amber-500`;
      case 'NO STOCK':
        return `${base} bg-danger`;
      case 'N/A':
        return `${base} bg-text-tertiary`;
    }
  };

  return (
    <ChefLayout title="Home">
      {(loadError || mutationError) && (
        <div data-testid="load-error" className="border border-danger bg-danger-subtle rounded-lg p-4 mb-4">
          <p className="m-0 mb-2 text-danger-text">Failed to load data: {loadError?.message ?? mutationError}</p>
          <button
            onClick={invalidateHome}
            className="px-4 py-2 bg-danger text-white rounded-md font-semibold text-sm hover:bg-danger-hover transition-colors"
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
          <div className="bg-gradient-to-br from-surface-sunken to-success-subtle border border-border rounded-xl p-4 shadow-sm hover:shadow transition-shadow">
            <div className="mb-3">
              <span className="font-bold text-base text-text">Today</span>{' '}
              <span className="text-sm text-text-secondary">(6:00 AM - 5:59 AM)</span>
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
      {/*  ACTION BAR — badges + action buttons in one row              */}
      {/* ============================================================ */}
      <div data-testid="quick-actions" className="mb-5 flex flex-wrap items-center gap-2">
        <Link
          to="/chef/inventory"
          data-testid="card-below-min"
          className={[
            'no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium transition-colors',
            belowMinStock > 0
              ? 'bg-warning-subtle text-amber-700 hover:bg-amber-200'
              : 'bg-surface-hover text-text-tertiary',
          ].join(' ')}
        >
          <AlertTriangle className="w-3 h-3" />
          Stock: {belowMinStock}
        </Link>
        <Link
          to="/chef/settings?tab=walmart"
          data-testid="card-missing-prices"
          className={[
            'no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium transition-colors',
            missingPrices > 0
              ? 'bg-danger-subtle text-danger-text hover:bg-danger'
              : 'bg-surface-hover text-text-tertiary',
          ].join(' ')}
        >
          <DollarSign className="w-3 h-3" />
          Missing Prices: {missingPrices}
        </Link>
        <Link
          to="/chef/settings?tab=products"
          data-testid="card-placeholders"
          className="no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-surface-hover text-text-tertiary hover:bg-border transition-colors"
        >
          <PackageSearch className="w-3 h-3" />
          Placeholders: {placeholders}
        </Link>
        <Link
          to="/chef/shopping"
          data-testid="card-cart-value"
          className="no-underline inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-surface-hover text-text-tertiary hover:bg-border transition-colors"
        >
          <ShoppingCart className="w-3 h-3" />
          Cart: ${cartValue.toFixed(2)}
        </Link>
        <button
          onClick={() => importShoppingMutation.mutate()}
          data-testid="import-shopping-btn"
          className="px-3 py-1.5 bg-success text-white rounded-md font-semibold text-xs hover:bg-success-hover transition-colors"
        >
          Import Shopping List
        </button>
        <button
          onClick={syncMealPlanToCart}
          disabled={syncing}
          data-testid="meal-plan-cart-btn"
          className="px-3 py-1.5 bg-success text-white rounded-md font-semibold text-xs hover:bg-success-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {syncing ? 'Syncing...' : 'Meal Plan \u2192 Cart'}
        </button>
        <button
          onClick={openTasteModal}
          data-testid="taste-profile-btn"
          className="px-3 py-1.5 bg-success text-white rounded-md font-semibold text-xs hover:bg-success-hover transition-colors"
        >
          Taste Profile
        </button>
        <button
          onClick={openTargetModal}
          data-testid="target-macros-btn"
          className="px-3 py-1.5 bg-success text-white rounded-md font-semibold text-xs hover:bg-success-hover transition-colors"
        >
          Target Macros
        </button>
      </div>

      {/* ============================================================ */}
      {/*  TODAY'S MEALS — green accent                                 */}
      {/* ============================================================ */}
      <div data-testid="todays-meals-section" className="mb-6 border-l-4 border-l-green-500 pl-3">
        <h3 className="text-lg font-semibold text-text mb-3 flex items-center gap-2">
          <UtensilsCrossed className="w-5 h-5 text-success-text" />
          Today&apos;s Meals
        </h3>
        {todaysMeals.length === 0 ? (
          <p data-testid="no-todays-meals" className="text-text-secondary italic">
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
                    'py-2.5 px-3 border border-border border-l-4 rounded-md',
                    isDone ? 'border-l-success bg-success-subtle opacity-80' : 'border-l-amber-400 bg-surface-sunken',
                  ].join(' ')}
                >
                  {/* Content + actions: stack on mobile, side-by-side on sm+ */}
                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2">
                    {/* Top: name, badge, meal type, macros */}
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-1.5 items-center">
                        <span className={['font-semibold text-text', isDone ? 'line-through' : ''].join(' ')}>
                          {name}
                        </span>
                        {!isDone && mealStockStatus !== 'N/A' && (
                          <span
                            data-testid={`meal-stock-${entry.meal_id}`}
                            className={stockBadgeClass(mealStockStatus)}
                          >
                            {mealStockStatus === 'CAN MAKE' ? '\u2713 IN STOCK' : mealStockStatus}
                          </span>
                        )}
                      </div>
                      {entry.meal_type && (
                        <span
                          data-testid={`meal-type-${entry.meal_id}`}
                          className="text-xs text-text-tertiary capitalize"
                        >
                          {entry.meal_type}
                        </span>
                      )}
                      {mealMacros && (
                        <div data-testid={`meal-macros-${entry.meal_id}`} className="text-xs text-text-secondary mt-1">
                          {mealMacros.calories} cal | {mealMacros.protein}g P | {mealMacros.carbs}g C | {mealMacros.fat}
                          g F
                        </div>
                      )}
                    </div>
                    {/* Bottom on mobile, right side on sm+: action buttons */}
                    <div className="flex gap-1.5 items-center sm:shrink-0 sm:ml-1">
                      {isDone ? (
                        <button
                          onClick={() => unmarkMealDoneMutation.mutate(entry.meal_id)}
                          data-testid={`meal-undo-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-surface text-amber-500 border border-amber-500 rounded text-xs font-semibold hover:bg-warning-subtle transition-colors"
                        >
                          Undo
                        </button>
                      ) : (
                        <button
                          onClick={() => markMealDoneMutation.mutate(entry.meal_id)}
                          data-testid={`meal-done-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-success text-white rounded text-xs font-semibold hover:bg-success-hover transition-colors"
                        >
                          Mark Done
                        </button>
                      )}
                      <DeleteBtn
                        id={`meal-${entry.meal_id}`}
                        onConfirm={async () => {
                          deleteMealEntryMutation.mutate(entry.meal_id);
                        }}
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
      {/*  TODAY'S MEAL PREP — amber accent                             */}
      {/* ============================================================ */}
      <div data-testid="meal-prep-section" className="mb-6 border-l-4 border-l-amber-400 pl-3">
        <h3 className="text-lg font-semibold text-text mb-3 flex items-center gap-2">
          <ChefHat className="w-5 h-5 text-amber-500" />
          Today&apos;s Meal Prep
        </h3>
        {mealPrep.length === 0 ? (
          <p data-testid="no-meal-prep" className="text-text-secondary italic">
            No meal prep scheduled for today
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {mealPrep.map((entry) => (
              <div
                key={entry.meal_id}
                data-testid={`prep-entry-${entry.meal_id}`}
                className="py-2.5 px-3 border border-border border-l-4 border-l-success rounded-md bg-surface-sunken"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-text">
                      {entry.recipes?.name ?? entry.products?.name ?? 'Unknown'}
                    </span>
                    <span className="text-text-secondary text-sm ml-2">
                      {entry.servings} serving{entry.servings !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="flex gap-1.5 items-center shrink-0">
                    {confirmPrepId === entry.meal_id ? (
                      <>
                        <span className="text-xs text-text-secondary">Execute?</span>
                        <button
                          onClick={() => executePrepMeal(entry.meal_id)}
                          data-testid={`prep-confirm-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-success text-white rounded text-xs font-semibold hover:bg-success-hover transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmPrepId(null)}
                          data-testid={`prep-cancel-${entry.meal_id}`}
                          className="px-2.5 py-1 bg-border text-text-secondary rounded text-xs font-semibold hover:bg-border-strong transition-colors"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmPrepId(entry.meal_id)}
                        data-testid={`prep-execute-${entry.meal_id}`}
                        className="px-3 py-1 bg-success text-white rounded text-xs font-semibold hover:bg-success-hover transition-colors"
                      >
                        Execute
                      </button>
                    )}
                    <DeleteBtn
                      id={`prep-${entry.meal_id}`}
                      onConfirm={async () => {
                        deleteMealEntryMutation.mutate(entry.meal_id);
                      }}
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
      {/*  CONSUMED TODAY                                               */}
      {/* ============================================================ */}
      {(foodLogs.length > 0 || tempItems.length > 0) && (
        <div data-testid="consumed-section" className="mb-6">
          <h3 className="text-lg font-semibold text-text mb-3">Consumed Today</h3>
          <div className="flex flex-col gap-1.5">
            {/* Grouped meal entries */}
            {mealGroups.map((group) => {
              const isExpanded = expandedMeals.has(group.meal_id);
              return (
                <div
                  key={`meal-${group.meal_id}`}
                  data-testid={`consumed-meal-${group.meal_id}`}
                  className="border border-border border-l-4 border-l-success rounded-md bg-success-subtle overflow-hidden"
                >
                  {/* Meal header — clickable to expand */}
                  <button
                    type="button"
                    onClick={() => toggleMealExpand(group.meal_id)}
                    className="w-full py-2 px-3 text-left hover:bg-success-subtle/50 transition-colors"
                    data-testid={`meal-toggle-${group.meal_id}`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <span className="font-semibold text-sm text-text min-w-0 flex items-center gap-1.5">
                        {group.mealName}
                        <span className="font-normal text-text-secondary text-xs">
                          ({group.logs.length} item{group.logs.length !== 1 ? 's' : ''})
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
                        )}
                      </span>
                      <span onClick={(e) => e.stopPropagation()} role="presentation">
                        <DeleteBtn
                          id={`meal-group-${group.meal_id}`}
                          onConfirm={async () => {
                            deleteMealLogsMutation.mutate(group.meal_id);
                          }}
                          testId={`delete-meal-${group.meal_id}`}
                        />
                      </span>
                    </div>
                    <div className="text-xs text-text-secondary mt-1">
                      {Math.round(group.totalCalories)} cal | {Math.round(group.totalProtein)}g P |{' '}
                      {Math.round(group.totalCarbs)}g C | {Math.round(group.totalFat)}g F
                    </div>
                  </button>
                  {/* Expanded ingredient list */}
                  {isExpanded && (
                    <div
                      className="border-t border-border bg-surface/60 px-3 py-1.5 flex flex-col gap-1"
                      data-testid={`meal-ingredients-${group.meal_id}`}
                    >
                      {group.logs.map((log) => (
                        <div
                          key={log.log_id}
                          className="flex justify-between items-center py-1 text-xs"
                          data-testid={`consumed-log-${log.log_id}`}
                        >
                          <span className="text-text-secondary">
                            {log.products?.name ?? 'Unknown'}
                            <span className="text-text-tertiary ml-1.5">
                              {Number(log.qty_consumed)} {log.unit}
                              {Number(log.qty_consumed) !== 1 ? 's' : ''}
                            </span>
                          </span>
                          <span className="text-text-secondary whitespace-nowrap ml-2">
                            {Math.round(Number(log.calories))} cal
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Standalone food logs (not part of a meal) */}
            {standaloneLogs.map((log) => (
              <div
                key={log.log_id}
                data-testid={`consumed-log-${log.log_id}`}
                className="py-2 px-3 border border-border border-l-4 border-l-success rounded-md bg-success-subtle"
              >
                <div className="flex justify-between items-start gap-2">
                  <span className="font-semibold text-sm text-text min-w-0">
                    {log.products?.name ?? 'Unknown'}
                    <span className="font-normal text-text-secondary text-xs ml-2">
                      {Number(log.qty_consumed)} {log.unit}
                      {Number(log.qty_consumed) !== 1 ? 's' : ''}
                    </span>
                  </span>
                  <DeleteBtn
                    id={`log-${log.log_id}`}
                    onConfirm={async () => {
                      deleteFoodLogMutation.mutate(log.log_id);
                    }}
                    testId={`delete-log-${log.log_id}`}
                  />
                </div>
                <div className="text-xs text-text-secondary mt-1">
                  {Math.round(Number(log.calories))} cal | {Math.round(Number(log.protein))}g P |{' '}
                  {Math.round(Number(log.carbs))}g C | {Math.round(Number(log.fat))}g F
                </div>
              </div>
            ))}
            {/* Quick-add temp items */}
            {tempItems.map((item) => (
              <div
                key={item.temp_id}
                data-testid={`consumed-temp-${item.temp_id}`}
                className="py-2 px-3 border border-border border-l-4 border-l-amber-500 rounded-md bg-warning-subtle"
              >
                <div className="flex justify-between items-start gap-2">
                  <span className="font-semibold text-sm text-text min-w-0">
                    {item.name}
                    <span className="font-normal text-text-tertiary text-xs ml-1.5">quick-add</span>
                  </span>
                  <DeleteBtn
                    id={`temp-${item.temp_id}`}
                    onConfirm={async () => {
                      deleteTempItemMutation.mutate(item.temp_id);
                    }}
                    testId={`delete-temp-${item.temp_id}`}
                  />
                </div>
                <div className="text-xs text-text-secondary mt-1">
                  {Math.round(Number(item.calories))} cal | {Math.round(Number(item.protein))}g P |{' '}
                  {Math.round(Number(item.carbs))}g C | {Math.round(Number(item.fat))}g F
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
            <label className="block text-xs font-semibold text-text-secondary mb-1">Protein (g)</label>
            <input
              type="number"
              min={0}
              value={targetProtein}
              onChange={(e) => setTargetProtein(Number(e.target.value) || 0)}
              data-testid="target-protein"
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary mb-1">Carbs (g)</label>
            <input
              type="number"
              min={0}
              value={targetCarbs}
              onChange={(e) => setTargetCarbs(Number(e.target.value) || 0)}
              data-testid="target-carbs"
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-text-secondary mb-1">Fats (g)</label>
            <input
              type="number"
              min={0}
              value={targetFat}
              onChange={(e) => setTargetFat(Number(e.target.value) || 0)}
              data-testid="target-fats"
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
            />
          </div>
          <div data-testid="target-calories" className="p-2 bg-surface-sunken rounded text-sm">
            <strong>Calories (auto): </strong>
            {calcCaloriesFromMacros(targetProtein, targetCarbs, targetFat)}
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            onClick={() => setShowTargetModal(false)}
            className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors"
            data-testid="target-cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={() => saveTargetsMutation.mutate()}
            className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
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
          className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm resize-y font-[inherit] focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
        />
        <div className="flex gap-2 justify-end mt-4">
          <button
            onClick={() => setShowTasteModal(false)}
            className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors"
            data-testid="taste-cancel-btn"
          >
            Cancel
          </button>
          <button
            onClick={() => saveTasteMutation.mutate()}
            className="px-4 py-2 bg-success text-white rounded-md font-semibold text-sm hover:bg-success-hover transition-colors"
            data-testid="taste-save-btn"
          >
            Save
          </button>
        </div>
      </ModalOverlay>
    </ChefLayout>
  );
}
