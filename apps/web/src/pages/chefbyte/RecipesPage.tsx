import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { todayStr } from '@/shared/dates';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ProductInfo {
  name: string;
  calories_per_serving: number;
  carbs_per_serving: number;
  protein_per_serving: number;
  fat_per_serving: number;
  servings_per_container: number;
}

interface RecipeIngredient {
  ingredient_id: string;
  product_id: string;
  quantity: number;
  unit: string;
  note: string | null;
  products: ProductInfo | null;
}

interface MissingIngredient {
  product_id: string;
  product_name: string;
  required: number;
  haveContainers: number;
}

interface Recipe {
  recipe_id: string;
  user_id: string;
  name: string;
  description: string | null;
  base_servings: number;
  active_time: number | null;
  total_time: number | null;
  instructions: string | null;
  recipe_ingredients: RecipeIngredient[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Forward-looking window (in days, inclusive) for the "Uses expiring stock"
 * filter. Recipes that pull in any ingredient whose lot expires within this
 * many days from today's logical date are flagged. 7 days is a good
 * default — long enough to catch the weekend cook, short enough to be
 * actionable.
 */
export const EXPIRING_WINDOW_DAYS = 7;

/**
 * Backward-looking lookback (in days, inclusive) for the "Uses expiring
 * stock" filter. Already-expired lots that the user is staring at in the
 * "expired — discard" section need to count too — otherwise the chip lies
 * about which recipes can use the food the user is about to throw out.
 * R2 audit explicitly called this out: a user with 4 expired yogurts
 * toggling the chip currently sees zero matches because the prior
 * `today..today+7` window excluded everything ≤ today-1. Window is now
 * `today - EXPIRING_LOOKBACK_DAYS .. today + EXPIRING_WINDOW_DAYS`.
 */
export const EXPIRING_LOOKBACK_DAYS = 7;

/* ------------------------------------------------------------------ */
/*  Macro computation helper (exported for testing)                    */
/* ------------------------------------------------------------------ */

export function computeRecipeMacros(
  ingredients: Array<{
    quantity: number;
    unit: string;
    products: {
      calories_per_serving: number;
      carbs_per_serving: number;
      protein_per_serving: number;
      fat_per_serving: number;
      servings_per_container: number;
    } | null;
  }>,
  baseServings: number,
) {
  let totalCal = 0;
  let totalCarbs = 0;
  let totalProtein = 0;
  let totalFat = 0;

  for (const ing of ingredients) {
    const multiplier =
      ing.unit === 'serving' ? ing.quantity : ing.quantity * (ing.products?.servings_per_container ?? 1);
    totalCal += multiplier * (ing.products?.calories_per_serving ?? 0);
    totalCarbs += multiplier * (ing.products?.carbs_per_serving ?? 0);
    totalProtein += multiplier * (ing.products?.protein_per_serving ?? 0);
    totalFat += multiplier * (ing.products?.fat_per_serving ?? 0);
  }

  const divisor = Math.max(baseServings, 1);
  return {
    calories: Math.round(totalCal / divisor),
    carbs: Math.round(totalCarbs / divisor),
    protein: Math.round(totalProtein / divisor),
    fat: Math.round(totalFat / divisor),
  };
}

/* ------------------------------------------------------------------ */
/*  Stock status types & helper (exported for testing)                  */
/* ------------------------------------------------------------------ */

export type StockStatus = 'CAN MAKE' | 'PARTIAL' | 'NO STOCK' | 'N/A';

export function computeStockStatus(
  ingredients: Array<{
    product_id: string;
    quantity: number;
    unit: string;
    products: { servings_per_container: number } | null;
  }>,
  stockByProduct: Map<string, number>,
): StockStatus {
  if (ingredients.length === 0) return 'N/A';

  // Check if any ingredient has a linked product
  const linkedIngredients = ingredients.filter((ing) => ing.products !== null);
  if (linkedIngredients.length === 0) return 'N/A';

  let inStockCount = 0;
  for (const ing of linkedIngredients) {
    const currentStock = stockByProduct.get(ing.product_id) ?? 0;
    // Ingredient quantity is in containers or servings -- compare against container stock
    // For 'serving' unit, convert required qty to containers
    let requiredContainers = Number(ing.quantity);
    if (ing.unit === 'serving' && ing.products) {
      requiredContainers = Number(ing.quantity) / Number(ing.products.servings_per_container || 1);
    }
    if (currentStock >= requiredContainers) {
      inStockCount++;
    }
  }

  if (inStockCount === linkedIngredients.length) return 'CAN MAKE';
  if (inStockCount > 0) return 'PARTIAL';
  return 'NO STOCK';
}

/**
 * Compute the list of missing/insufficient ingredients for a recipe.
 * Surfaces "PARTIAL (N missing)" + tooltip listing on the recipe card so
 * the user knows what's blocking the recipe instead of just seeing an
 * amber badge. Mirrors the qty math in `computeStockStatus`.
 *
 * Exported for unit testing.
 */
export function computeMissingIngredients(
  ingredients: Array<{
    product_id: string;
    quantity: number;
    unit: string;
    products: { name: string; servings_per_container: number } | null;
  }>,
  stockByProduct: Map<string, number>,
): MissingIngredient[] {
  const missing: MissingIngredient[] = [];
  for (const ing of ingredients) {
    if (!ing.products) continue;
    const currentStock = stockByProduct.get(ing.product_id) ?? 0;
    let requiredContainers = Number(ing.quantity);
    if (ing.unit === 'serving') {
      requiredContainers = Number(ing.quantity) / Number(ing.products.servings_per_container || 1);
    }
    if (currentStock < requiredContainers) {
      missing.push({
        product_id: ing.product_id,
        product_name: ing.products.name,
        required: requiredContainers,
        haveContainers: currentStock,
      });
    }
  }
  return missing;
}

/**
 * Decide whether a recipe uses an ingredient with stock that is expiring
 * within `daysAhead` days from `today` (YYYY-MM-DD strings). Returns true
 * if AT LEAST ONE ingredient has a stock_lot whose expires_on is in the
 * window [today, today+daysAhead]. Recipes that pull in soon-to-expire
 * stock surface first when the "Uses expiring" chip is on so food gets
 * eaten before it goes bad — the highest-impact missing recipe filter.
 *
 * Exported for unit testing.
 */
export function recipeUsesExpiringStock(
  ingredients: Array<{ product_id: string }>,
  expiringProductIds: ReadonlySet<string>,
): boolean {
  for (const ing of ingredients) {
    if (expiringProductIds.has(ing.product_id)) return true;
  }
  return false;
}

function stockBadgeClass(status: StockStatus): string {
  const base = 'inline-block px-2 py-0.5 rounded text-xs font-semibold text-white';
  switch (status) {
    case 'CAN MAKE':
      return `${base} bg-green-600`;
    case 'PARTIAL':
      return `${base} bg-amber-500`;
    case 'NO STOCK':
      return `${base} bg-red-600`;
    case 'N/A':
      return `${base} bg-text-tertiary`;
  }
}

/* ================================================================== */
/*  RecipesPage                                                        */
/* ================================================================== */

export function RecipesPage() {
  const { user } = useAuth();
  const { dayStartHour } = useAppContext();

  /* ---- Filter state ---- */
  const [searchText, setSearchText] = useState('');
  const [maxActiveTime, setMaxActiveTime] = useState<number | null>(null);
  /* Cookable + Uses-expiring chips persist across reloads — they're the
     two highest-intent filters per the audit, and the asymmetric prior
     behaviour (macro thresholds persisted, chips reset) was exactly
     backwards. localStorage reads are wrapped in try/catch for Safari
     private mode, mirroring the existing `chefbyte_protein_threshold`
     pattern. */
  const [canBeMadeOnly, setCanBeMadeOnly] = useState(() => {
    try {
      return localStorage.getItem('chefbyte_recipes_cookable') === '1';
    } catch {
      return false;
    }
  });
  const [usesExpiringOnly, setUsesExpiringOnly] = useState(() => {
    try {
      return localStorage.getItem('chefbyte_recipes_expiring') === '1';
    } catch {
      return false;
    }
  });
  const [highProteinOnly, setHighProteinOnly] = useState(false);
  const [highCarbsOnly, setHighCarbsOnly] = useState(false);

  /* Persist Cookable / Uses-expiring chip toggles. Effect-based so a
     direct setState (e.g. from a "Reset filters" button later) still
     persists, and so React StrictMode's double-render in dev doesn't
     double-write (effects only run after commit). */
  useEffect(() => {
    try {
      localStorage.setItem('chefbyte_recipes_cookable', canBeMadeOnly ? '1' : '0');
    } catch {
      /* Safari private — fail-soft. */
    }
  }, [canBeMadeOnly]);
  useEffect(() => {
    try {
      localStorage.setItem('chefbyte_recipes_expiring', usesExpiringOnly ? '1' : '0');
    } catch {
      /* Safari private — fail-soft. */
    }
  }, [usesExpiringOnly]);

  /* ---- Macro density thresholds (g per 100 cal, persisted) ---- */
  const [proteinThreshold, setProteinThreshold] = useState(() => {
    try {
      const saved = localStorage.getItem('chefbyte_protein_threshold');
      return saved ? Number(saved) : 8;
    } catch {
      return 8;
    }
  });
  const [carbsThreshold, setCarbsThreshold] = useState(() => {
    try {
      const saved = localStorage.getItem('chefbyte_carbs_threshold');
      return saved ? Number(saved) : 10;
    } catch {
      return 10;
    }
  });
  const [editingThreshold, setEditingThreshold] = useState<'protein' | 'carbs' | null>(null);
  const [thresholdInput, setThresholdInput] = useState('');

  /* ---- Filter popover ---- */
  const [showFilters, setShowFilters] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading via TanStack Query                                  */
  /* ---------------------------------------------------------------- */

  const {
    data: queryData,
    isLoading,
    error: loadErrorObj,
  } = useQuery({
    queryKey: queryKeys.recipes(user!.id),
    queryFn: async () => {
      const [recipeRes, stockRes] = await Promise.all([
        chefbyte()
          .from('recipes')
          .select(
            '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
          )
          .eq('user_id', user!.id)
          .order('name'),
        chefbyte().from('stock_lots').select('product_id, qty_containers, expires_on').eq('user_id', user!.id),
      ]);

      if (recipeRes.error) throw recipeRes.error;

      const stockMap = new Map<string, number>();
      const stockLots = (stockRes.data ?? []) as Array<{
        product_id: string;
        qty_containers: number;
        expires_on: string | null;
      }>;
      for (const lot of stockLots) {
        const current = stockMap.get(lot.product_id) ?? 0;
        stockMap.set(lot.product_id, current + Number(lot.qty_containers));
      }

      // Build the "expiring within N days" product set used by the
      // "Uses expiring" chip. Window = today-EXPIRING_LOOKBACK_DAYS ..
      // today+EXPIRING_WINDOW_DAYS computed against the user's logical
      // date so day-boundary works correctly. A product is in the set
      // if at least one of its lots has qty>0 and an expires_on inside
      // the window.
      //
      // R2 fix: the lookback half (today - LOOKBACK) was added so that
      // already-expired lots in the user's "expired — discard" section
      // also count. Without it a user with 4 expired yogurts would
      // toggle the chip and see ZERO matches — the exact recipes the
      // chip is meant to surface.
      const today = todayStr(dayStartHour);
      const ymd = (offsetDays: number) => {
        const d = new Date(today + 'T00:00:00');
        d.setDate(d.getDate() + offsetDays);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      };
      const lowerBound = ymd(-EXPIRING_LOOKBACK_DAYS);
      const horizon = ymd(EXPIRING_WINDOW_DAYS);
      const expiring = new Set<string>();
      for (const lot of stockLots) {
        if (Number(lot.qty_containers) <= 0) continue;
        if (!lot.expires_on) continue;
        if (lot.expires_on >= lowerBound && lot.expires_on <= horizon) {
          expiring.add(lot.product_id);
        }
      }

      return {
        recipes: (recipeRes.data ?? []) as Recipe[],
        stockByProduct: stockMap,
        expiringProductIds: expiring,
      };
    },
    enabled: !!user,
  });

  const recipes = queryData?.recipes;
  const stockByProduct = queryData?.stockByProduct;
  const expiringProductIds = queryData?.expiringProductIds ?? new Set<string>();
  const loadError = loadErrorObj ? (loadErrorObj as Error).message : null;

  /* ---------------------------------------------------------------- */
  /*  Realtime subscriptions — stock_lots changes invalidate the      */
  /*  recipes query so live-shelf consume / inventory edits keep the  */
  /*  Can-Make / expiring badges fresh without polling. recipes +     */
  /*  recipe_ingredients are also subscribed so a new recipe inserted */
  /*  via MCP shows up without a manual refresh.                       */
  /* ---------------------------------------------------------------- */
  useRealtimeInvalidation('chef-recipes', [
    { schema: 'chefbyte', table: 'stock_lots', queryKeys: [queryKeys.recipes(user!.id)] },
    { schema: 'chefbyte', table: 'recipes', queryKeys: [queryKeys.recipes(user!.id)] },
    { schema: 'chefbyte', table: 'recipe_ingredients', queryKeys: [queryKeys.recipes(user!.id)] },
  ]);

  /* ---------------------------------------------------------------- */
  /*  Filtering                                                        */
  /* ---------------------------------------------------------------- */

  const filteredRecipes = useMemo(() => {
    let result = recipes ?? [];
    const stock = stockByProduct ?? new Map<string, number>();

    // Search filter
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((r) => r.name.toLowerCase().includes(lower));
    }

    // Active time filter
    if (maxActiveTime !== null) {
      result = result.filter((r) => r.active_time !== null && r.active_time <= maxActiveTime);
    }

    // Can be made filter (top-level chip + popover entry both bind to it)
    if (canBeMadeOnly) {
      result = result.filter((r) => computeStockStatus(r.recipe_ingredients, stock) === 'CAN MAKE');
    }

    // Uses expiring stock filter — promotes "I should cook this NOW or
    // it goes bad" recipes to the front. Cross-references each recipe's
    // ingredient list against the precomputed `expiringProductIds` set.
    if (usesExpiringOnly) {
      result = result.filter((r) => recipeUsesExpiringStock(r.recipe_ingredients, expiringProductIds));
    }

    // High protein filter (g protein per 100 cal >= threshold)
    if (highProteinOnly) {
      result = result.filter((r) => {
        const macros = computeRecipeMacros(r.recipe_ingredients, Number(r.base_servings));
        if (macros.calories === 0) return false;
        return (macros.protein / macros.calories) * 100 >= proteinThreshold;
      });
    }

    // High carbs filter (g carbs per 100 cal >= threshold)
    if (highCarbsOnly) {
      result = result.filter((r) => {
        const macros = computeRecipeMacros(r.recipe_ingredients, Number(r.base_servings));
        if (macros.calories === 0) return false;
        return (macros.carbs / macros.calories) * 100 >= carbsThreshold;
      });
    }

    return result;
  }, [
    recipes,
    searchText,
    maxActiveTime,
    canBeMadeOnly,
    usesExpiringOnly,
    expiringProductIds,
    stockByProduct,
    highProteinOnly,
    highCarbsOnly,
    proteinThreshold,
    carbsThreshold,
  ]);

  /* ---- Active filter count (popover-only filters; the top-level chips
     for Cookable + Uses expiring read directly off state and don't add
     to the badge count). ---- */
  const activeFilterCount = [maxActiveTime === 30, highProteinOnly, highCarbsOnly].filter(Boolean).length;

  /* ---- Close filter popover on outside click ---- */
  useEffect(() => {
    if (!showFilters) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowFilters(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFilters]);

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (isLoading) {
    return (
      <ChefLayout title="Recipes">
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="recipes-loading">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Recipes">
      {loadError && (
        <div className="bg-warning-subtle border border-amber-400 rounded-lg px-4 py-3 mb-4" data-testid="load-error">
          <strong>Error:</strong> {loadError}
        </div>
      )}

      {/* ============================================================ */}
      {/*  HEADER                                                       */}
      {/* ============================================================ */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-2xl font-bold text-text">Recipes</h1>
        <div className="flex gap-2 flex-wrap">
          <Link
            to="/chef/recipes/new"
            data-testid="new-recipe-btn"
            className="inline-flex items-center justify-center px-4 py-3 no-underline rounded-md font-semibold text-sm bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
          >
            + New Recipe
          </Link>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  FILTERS                                                      */}
      {/* ============================================================ */}
      <div data-testid="recipes-filters" className="mb-4">
        <div className="flex gap-2 items-center mb-2">
          <input
            type="text"
            placeholder="Search recipes..."
            aria-label="Search recipes"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            data-testid="recipe-search"
            className="flex-1 px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
          />
          <div className="relative" ref={filterRef}>
            <button
              onClick={() => setShowFilters(!showFilters)}
              data-testid="filters-btn"
              className={[
                'px-4 py-2.5 rounded-md text-sm font-semibold transition-colors whitespace-nowrap',
                activeFilterCount > 0
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-surface border border-border-strong text-text-secondary hover:bg-surface-hover',
              ].join(' ')}
            >
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>

            {showFilters && (
              <div
                data-testid="filters-popover"
                className="absolute right-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] bg-surface border border-border rounded-xl shadow-lg z-20 p-4"
              >
                <h4 className="m-0 mb-3 text-sm font-bold text-text">More Filters</h4>
                <p className="m-0 mb-3 text-xs text-text-tertiary">
                  Cookable now and Uses expiring are now top-level chips above.
                </p>
                <div className="space-y-3">
                  {/* Quick (< 30 min) toggle */}
                  <label className="flex items-center justify-between cursor-pointer" data-testid="active-time-filter">
                    <span className="text-sm text-text-secondary">Quick (&lt; 30 min)</span>
                    <div
                      role="switch"
                      aria-checked={maxActiveTime === 30}
                      onClick={() => setMaxActiveTime(maxActiveTime === 30 ? null : 30)}
                      className={[
                        'w-10 h-5 rounded-full relative transition-colors cursor-pointer',
                        maxActiveTime === 30 ? 'bg-emerald-600' : 'bg-border-strong',
                      ].join(' ')}
                    >
                      <div
                        className={[
                          'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                          maxActiveTime === 30 ? 'translate-x-5' : 'translate-x-0.5',
                        ].join(' ')}
                      />
                    </div>
                  </label>

                  {/* High Protein toggle + threshold */}
                  <div className="border-t border-border-light pt-3">
                    <label
                      className="flex items-center justify-between cursor-pointer"
                      data-testid="high-protein-filter"
                    >
                      <span className="text-sm text-text-secondary">High Protein</span>
                      <div
                        role="switch"
                        aria-checked={highProteinOnly}
                        onClick={() => setHighProteinOnly(!highProteinOnly)}
                        className={[
                          'w-10 h-5 rounded-full relative transition-colors cursor-pointer',
                          highProteinOnly ? 'bg-violet-600' : 'bg-border-strong',
                        ].join(' ')}
                      >
                        <div
                          className={[
                            'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                            highProteinOnly ? 'translate-x-5' : 'translate-x-0.5',
                          ].join(' ')}
                        />
                      </div>
                    </label>
                    <div className="flex items-center gap-2 mt-1.5 ml-1">
                      <span className="text-xs text-text-tertiary">Threshold:</span>
                      <input
                        type="number"
                        value={editingThreshold === 'protein' ? thresholdInput : proteinThreshold}
                        onChange={(e) => {
                          setEditingThreshold('protein');
                          setThresholdInput(e.target.value);
                        }}
                        onBlur={() => {
                          if (editingThreshold === 'protein') {
                            const val = parseFloat(thresholdInput);
                            if (!isNaN(val) && val > 0) {
                              setProteinThreshold(val);
                              try {
                                localStorage.setItem('chefbyte_protein_threshold', String(val));
                              } catch {
                                /* Safari private */
                              }
                            }
                            setEditingThreshold(null);
                          }
                        }}
                        onFocus={() => {
                          setEditingThreshold('protein');
                          setThresholdInput(String(proteinThreshold));
                        }}
                        step="0.5"
                        min="0"
                        data-testid="protein-threshold-input"
                        className="w-16 px-2 py-1 border border-border-strong rounded text-xs text-center focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                      />
                      <span className="text-xs text-text-tertiary">g/100cal</span>
                    </div>
                  </div>

                  {/* High Carbs toggle + threshold */}
                  <div className="border-t border-border-light pt-3">
                    <label className="flex items-center justify-between cursor-pointer" data-testid="high-carbs-filter">
                      <span className="text-sm text-text-secondary">High Carbs</span>
                      <div
                        role="switch"
                        aria-checked={highCarbsOnly}
                        onClick={() => setHighCarbsOnly(!highCarbsOnly)}
                        className={[
                          'w-10 h-5 rounded-full relative transition-colors cursor-pointer',
                          highCarbsOnly ? 'bg-amber-600' : 'bg-border-strong',
                        ].join(' ')}
                      >
                        <div
                          className={[
                            'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                            highCarbsOnly ? 'translate-x-5' : 'translate-x-0.5',
                          ].join(' ')}
                        />
                      </div>
                    </label>
                    <div className="flex items-center gap-2 mt-1.5 ml-1">
                      <span className="text-xs text-text-tertiary">Threshold:</span>
                      <input
                        type="number"
                        value={editingThreshold === 'carbs' ? thresholdInput : carbsThreshold}
                        onChange={(e) => {
                          setEditingThreshold('carbs');
                          setThresholdInput(e.target.value);
                        }}
                        onBlur={() => {
                          if (editingThreshold === 'carbs') {
                            const val = parseFloat(thresholdInput);
                            if (!isNaN(val) && val > 0) {
                              setCarbsThreshold(val);
                              try {
                                localStorage.setItem('chefbyte_carbs_threshold', String(val));
                              } catch {
                                /* Safari private */
                              }
                            }
                            setEditingThreshold(null);
                          }
                        }}
                        onFocus={() => {
                          setEditingThreshold('carbs');
                          setThresholdInput(String(carbsThreshold));
                        }}
                        step="0.5"
                        min="0"
                        data-testid="carbs-threshold-input"
                        className="w-16 px-2 py-1 border border-border-strong rounded text-xs text-center focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
                      />
                      <span className="text-xs text-text-tertiary">g/100cal</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Top-level chip row — Cookable now + Uses expiring promoted out
            of the popover. These are the two highest-intent filters per
            the UX audit: "what can I make?" and "what should I cook
            before it spoils?". The macro / time density filters stay
            inside the popover where they don't clutter the primary row. */}
        <div className="flex gap-2 flex-wrap" data-testid="recipes-chip-row">
          <button
            type="button"
            onClick={() => setCanBeMadeOnly((v) => !v)}
            data-testid="chip-cookable-now"
            aria-pressed={canBeMadeOnly}
            className={[
              'px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors',
              canBeMadeOnly
                ? 'bg-green-600 text-white border-green-600'
                : 'bg-surface text-text-secondary border-border-strong hover:bg-surface-hover',
            ].join(' ')}
          >
            Cookable now
          </button>
          <button
            type="button"
            onClick={() => setUsesExpiringOnly((v) => !v)}
            data-testid="chip-uses-expiring"
            aria-pressed={usesExpiringOnly}
            title={`Recipes using stock expiring in the next ${EXPIRING_WINDOW_DAYS} days`}
            className={[
              'px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors',
              usesExpiringOnly
                ? 'bg-amber-500 text-white border-amber-500'
                : 'bg-surface text-text-secondary border-border-strong hover:bg-surface-hover',
            ].join(' ')}
          >
            Uses expiring stock
          </button>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  RECIPE CARDS                                                 */}
      {/* ============================================================ */}
      <div data-testid="recipe-list" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredRecipes.length === 0 && (
          <div data-testid="no-recipes" className="text-text-secondary">
            {searchText ||
            maxActiveTime !== null ||
            canBeMadeOnly ||
            usesExpiringOnly ||
            highProteinOnly ||
            highCarbsOnly ? (
              <p>No recipes match the current filters.</p>
            ) : (
              <p>
                No recipes yet.{' '}
                <Link to="/chef/recipes/new" className="text-emerald-600 font-medium hover:underline">
                  Create your first recipe &rarr;
                </Link>
              </p>
            )}
          </div>
        )}

        {filteredRecipes.map((recipe) => {
          const macros = computeRecipeMacros(recipe.recipe_ingredients, Number(recipe.base_servings));
          const stock = stockByProduct ?? new Map();
          const status = computeStockStatus(recipe.recipe_ingredients, stock);
          // Surface concrete missing-ingredient counts for PARTIAL so the
          // user knows what's blocking the recipe instead of just seeing
          // an opaque amber badge. NO STOCK also lists every ingredient
          // (still useful for the tooltip), but the count is suppressed
          // since the badge label already conveys the worst case.
          const missing =
            status === 'PARTIAL' || status === 'NO STOCK'
              ? computeMissingIngredients(recipe.recipe_ingredients, stock)
              : [];
          // Tooltip carries qty detail (need / have) for desktop hover —
          // mobile users get the same info inline below the badge per the
          // R2 audit (tooltips don't render on touch). Truncate at 4
          // ingredients to keep the line short, with "+N more" overflow.
          const missingTooltip = missing.length
            ? 'Missing: ' +
              missing
                .map((m) => {
                  const need = m.required.toFixed(m.required >= 10 ? 0 : 1);
                  const have = m.haveContainers.toFixed(m.haveContainers >= 10 ? 0 : 1);
                  return `${m.product_name} (need ${need}, have ${have})`;
                })
                .join('; ')
            : undefined;
          const missingInlineNames = (() => {
            if (!missing.length) return null;
            const head = missing.slice(0, 4).map((m) => m.product_name);
            const overflow = missing.length - head.length;
            return overflow > 0 ? `${head.join(', ')} +${overflow} more` : head.join(', ');
          })();

          return (
            <Link
              key={recipe.recipe_id}
              to={`/chef/recipes/${recipe.recipe_id}`}
              data-testid={`recipe-card-${recipe.recipe_id}`}
              className="bg-surface border border-border rounded-xl p-4 block no-underline text-inherit hover:border-emerald-300 hover:shadow-sm transition-all"
            >
              <h3
                className="m-0 mb-1 text-base font-semibold text-text"
                data-testid={`recipe-name-${recipe.recipe_id}`}
              >
                {recipe.name}
              </h3>
              {recipe.description && (
                <p
                  className="text-sm text-text-secondary mt-1 mb-0 line-clamp-2"
                  data-testid={`recipe-desc-${recipe.recipe_id}`}
                >
                  {recipe.description}
                </p>
              )}
              <div className="flex gap-3 text-xs text-text-tertiary my-1.5">
                <span data-testid={`recipe-servings-${recipe.recipe_id}`}>
                  {Number(recipe.base_servings)} serving{Number(recipe.base_servings) !== 1 ? 's' : ''}
                </span>
                {recipe.active_time != null && (
                  <span data-testid={`active-time-${recipe.recipe_id}`}>Active: {recipe.active_time} min</span>
                )}
                {recipe.total_time != null && (
                  <span data-testid={`total-time-${recipe.recipe_id}`}>Total: {recipe.total_time} min</span>
                )}
              </div>

              {/* Per-serving macros */}
              <div data-testid={`recipe-macros-${recipe.recipe_id}`} className="flex gap-3 mb-2.5 text-sm">
                <div>
                  <span className="font-semibold text-text">{macros.calories}</span>
                  <span className="text-xs text-text-tertiary ml-0.5">Cal</span>
                </div>
                <div>
                  <span className="font-semibold text-text">{macros.protein}g</span>
                  <span className="text-xs text-text-tertiary ml-0.5">P</span>
                </div>
                <div>
                  <span className="font-semibold text-text">{macros.carbs}g</span>
                  <span className="text-xs text-text-tertiary ml-0.5">C</span>
                </div>
                <div>
                  <span className="font-semibold text-text">{macros.fat}g</span>
                  <span className="text-xs text-text-tertiary ml-0.5">F</span>
                </div>
              </div>

              {/* Stock status — PARTIAL shows the concrete missing count
                  with a tooltip listing names so the user knows exactly
                  what's blocking the recipe. R2 fix: a desktop-only
                  tooltip is invisible on mobile (touch can't trigger
                  `title`), so the missing names also render as a small
                  inline line below the badge. Tooltip still carries
                  the qty (need / have) detail for desktop. */}
              <div className="mb-2">
                <span
                  className={stockBadgeClass(status)}
                  data-testid={`stock-status-${recipe.recipe_id}`}
                  title={missingTooltip}
                >
                  {status === 'PARTIAL' && missing.length > 0 ? `PARTIAL (${missing.length} missing)` : status}
                </span>
                {missingInlineNames && (
                  <p
                    data-testid={`missing-names-${recipe.recipe_id}`}
                    className="m-0 mt-1 text-[11px] text-text-tertiary leading-snug"
                  >
                    Missing: {missingInlineNames}
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </ChefLayout>
  );
}
