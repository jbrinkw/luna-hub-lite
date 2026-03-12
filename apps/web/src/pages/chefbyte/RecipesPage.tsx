import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';

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
      return `${base} bg-slate-400`;
  }
}

/* ================================================================== */
/*  RecipesPage                                                        */
/* ================================================================== */

export function RecipesPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [stockByProduct, setStockByProduct] = useState<Map<string, number>>(new Map());

  /* ---- Filter state ---- */
  const [searchText, setSearchText] = useState('');
  const [maxActiveTime, setMaxActiveTime] = useState<number | null>(null);
  const [canBeMadeOnly, setCanBeMadeOnly] = useState(false);
  const [highProteinOnly, setHighProteinOnly] = useState(false);
  const [highCarbsOnly, setHighCarbsOnly] = useState(false);

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
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadData = useCallback(async () => {
    if (!user) return;

    setLoadError(null);
    const { data: recipeData, error: recipeErr } = await chefbyte()
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('user_id', user.id)
      .order('name');
    if (recipeErr) {
      setLoadError(recipeErr.message);
      setLoading(false);
      return;
    }

    // Load all stock lots to compute stock-per-product
    const { data: stockLots } = await chefbyte()
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', user.id);

    const stockMap = new Map<string, number>();
    for (const lot of (stockLots ?? []) as Array<{ product_id: string; qty_containers: number }>) {
      const current = stockMap.get(lot.product_id) ?? 0;
      stockMap.set(lot.product_id, current + Number(lot.qty_containers));
    }
    setStockByProduct(stockMap);

    setRecipes((recipeData ?? []) as Recipe[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

  /* ---------------------------------------------------------------- */
  /*  Filtering                                                        */
  /* ---------------------------------------------------------------- */

  const filteredRecipes = useMemo(() => {
    let result = recipes;

    // Search filter
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((r) => r.name.toLowerCase().includes(lower));
    }

    // Active time filter
    if (maxActiveTime !== null) {
      result = result.filter((r) => r.active_time !== null && r.active_time <= maxActiveTime);
    }

    // Can be made filter
    if (canBeMadeOnly) {
      result = result.filter((r) => computeStockStatus(r.recipe_ingredients, stockByProduct) === 'CAN MAKE');
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
    stockByProduct,
    highProteinOnly,
    highCarbsOnly,
    proteinThreshold,
    carbsThreshold,
  ]);

  /* ---- Active filter count ---- */
  const activeFilterCount = [canBeMadeOnly, maxActiveTime === 30, highProteinOnly, highCarbsOnly].filter(
    Boolean,
  ).length;

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

  if (loading) {
    return (
      <ChefLayout title="Recipes">
        <div className="p-5" data-testid="recipes-loading">
          Loading recipes...
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Recipes">
      {loadError && (
        <div className="bg-amber-50 border border-amber-400 rounded-lg px-4 py-3 mb-4" data-testid="load-error">
          <strong>Error:</strong> {loadError}
        </div>
      )}

      {/* ============================================================ */}
      {/*  HEADER                                                       */}
      {/* ============================================================ */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="m-0 text-2xl font-bold text-slate-900">Recipes</h1>
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
            className="flex-1 px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
          />
          <div className="relative" ref={filterRef}>
            <button
              onClick={() => setShowFilters(!showFilters)}
              data-testid="filters-btn"
              className={[
                'px-4 py-2.5 rounded-md text-sm font-semibold transition-colors whitespace-nowrap',
                activeFilterCount > 0
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50',
              ].join(' ')}
            >
              Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>

            {showFilters && (
              <div
                data-testid="filters-popover"
                className="absolute right-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-lg z-20 p-4"
              >
                <h4 className="m-0 mb-3 text-sm font-bold text-slate-900">Filter Recipes</h4>
                <div className="space-y-3">
                  {/* Can Be Made toggle */}
                  <label className="flex items-center justify-between cursor-pointer" data-testid="can-be-made-filter">
                    <span className="text-sm text-slate-700">Can Be Made</span>
                    <div
                      role="switch"
                      aria-checked={canBeMadeOnly}
                      onClick={() => setCanBeMadeOnly(!canBeMadeOnly)}
                      className={[
                        'w-10 h-5 rounded-full relative transition-colors cursor-pointer',
                        canBeMadeOnly ? 'bg-green-600' : 'bg-slate-300',
                      ].join(' ')}
                    >
                      <div
                        className={[
                          'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform',
                          canBeMadeOnly ? 'translate-x-5' : 'translate-x-0.5',
                        ].join(' ')}
                      />
                    </div>
                  </label>

                  {/* Quick (< 30 min) toggle */}
                  <label className="flex items-center justify-between cursor-pointer" data-testid="active-time-filter">
                    <span className="text-sm text-slate-700">Quick (&lt; 30 min)</span>
                    <div
                      role="switch"
                      aria-checked={maxActiveTime === 30}
                      onClick={() => setMaxActiveTime(maxActiveTime === 30 ? null : 30)}
                      className={[
                        'w-10 h-5 rounded-full relative transition-colors cursor-pointer',
                        maxActiveTime === 30 ? 'bg-emerald-600' : 'bg-slate-300',
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
                  <div className="border-t border-slate-100 pt-3">
                    <label
                      className="flex items-center justify-between cursor-pointer"
                      data-testid="high-protein-filter"
                    >
                      <span className="text-sm text-slate-700">High Protein</span>
                      <div
                        role="switch"
                        aria-checked={highProteinOnly}
                        onClick={() => setHighProteinOnly(!highProteinOnly)}
                        className={[
                          'w-10 h-5 rounded-full relative transition-colors cursor-pointer',
                          highProteinOnly ? 'bg-violet-600' : 'bg-slate-300',
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
                      <span className="text-xs text-slate-500">Threshold:</span>
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
                        className="w-16 px-2 py-1 border border-slate-300 rounded text-xs text-center focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                      />
                      <span className="text-xs text-slate-500">g/100cal</span>
                    </div>
                  </div>

                  {/* High Carbs toggle + threshold */}
                  <div className="border-t border-slate-100 pt-3">
                    <label className="flex items-center justify-between cursor-pointer" data-testid="high-carbs-filter">
                      <span className="text-sm text-slate-700">High Carbs</span>
                      <div
                        role="switch"
                        aria-checked={highCarbsOnly}
                        onClick={() => setHighCarbsOnly(!highCarbsOnly)}
                        className={[
                          'w-10 h-5 rounded-full relative transition-colors cursor-pointer',
                          highCarbsOnly ? 'bg-amber-600' : 'bg-slate-300',
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
                      <span className="text-xs text-slate-500">Threshold:</span>
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
                        className="w-16 px-2 py-1 border border-slate-300 rounded text-xs text-center focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
                      />
                      <span className="text-xs text-slate-500">g/100cal</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  RECIPE CARDS                                                 */}
      {/* ============================================================ */}
      <div data-testid="recipe-list" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredRecipes.length === 0 && (
          <div data-testid="no-recipes" className="text-slate-500">
            {searchText || maxActiveTime !== null || canBeMadeOnly || highProteinOnly || highCarbsOnly ? (
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
          const status = computeStockStatus(recipe.recipe_ingredients, stockByProduct);

          return (
            <Link
              key={recipe.recipe_id}
              to={`/chef/recipes/${recipe.recipe_id}`}
              data-testid={`recipe-card-${recipe.recipe_id}`}
              className="bg-white border border-slate-200 rounded-xl p-4 block no-underline text-inherit hover:border-emerald-300 hover:shadow-sm transition-all"
            >
              <h3
                className="m-0 mb-1 text-base font-semibold text-slate-900"
                data-testid={`recipe-name-${recipe.recipe_id}`}
              >
                {recipe.name}
              </h3>
              {recipe.description && (
                <p
                  className="text-sm text-slate-500 mt-1 mb-0 line-clamp-2"
                  data-testid={`recipe-desc-${recipe.recipe_id}`}
                >
                  {recipe.description}
                </p>
              )}
              <div className="flex gap-3 text-xs text-slate-400 my-1.5">
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
                  <span className="font-semibold text-slate-900">{macros.calories}</span>
                  <span className="text-xs text-slate-400 ml-0.5">Cal</span>
                </div>
                <div>
                  <span className="font-semibold text-slate-900">{macros.protein}g</span>
                  <span className="text-xs text-slate-400 ml-0.5">P</span>
                </div>
                <div>
                  <span className="font-semibold text-slate-900">{macros.carbs}g</span>
                  <span className="text-xs text-slate-400 ml-0.5">C</span>
                </div>
                <div>
                  <span className="font-semibold text-slate-900">{macros.fat}g</span>
                  <span className="text-xs text-slate-400 ml-0.5">F</span>
                </div>
              </div>

              {/* Stock status */}
              <div className="mb-2">
                <span className={stockBadgeClass(status)} data-testid={`stock-status-${recipe.recipe_id}`}>
                  {status}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </ChefLayout>
  );
}
