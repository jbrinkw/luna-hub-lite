import { useEffect, useState, useCallback, useMemo } from 'react';
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

function stockStatusStyle(status: StockStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 600,
    color: '#fff',
  };
  switch (status) {
    case 'CAN MAKE':
      return { ...base, background: '#2f9e44' };
    case 'PARTIAL':
      return { ...base, background: '#ff9800' };
    case 'NO STOCK':
      return { ...base, background: '#d33' };
    case 'N/A':
      return { ...base, background: '#9ca3af', color: '#fff' };
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

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Recipes">
        <div style={{ padding: '20px' }} data-testid="recipes-loading">
          Loading recipes...
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Recipes">
      {loadError && (
        <div
          style={{
            background: '#fff3cd',
            border: '1px solid #ffc107',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 16,
          }}
          data-testid="load-error"
        >
          <strong>Error:</strong> {loadError}
        </div>
      )}

      {/* ============================================================ */}
      {/*  HEADER                                                       */}
      {/* ============================================================ */}
      <div className="recipesHeader">
        <h1 style={{ margin: 0 }}>Recipes</h1>
        <div className="headerActions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Link
            to="/chef/recipes/new"
            data-testid="new-recipe-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '12px 16px',
              textDecoration: 'none',
              borderRadius: '6px',
              fontWeight: 600,
              fontSize: '14px',
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
            }}
          >
            + New Recipe
          </Link>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  FILTERS                                                      */}
      {/* ============================================================ */}
      <div data-testid="recipes-filters" style={{ margin: '16px 0' }}>
        <input
          type="text"
          placeholder="Search recipes..."
          aria-label="Search recipes"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          data-testid="recipe-search"
          style={{
            width: '100%',
            padding: '10px 12px',
            border: '1px solid #ccc',
            borderRadius: '6px',
            fontSize: '14px',
            marginBottom: '8px',
          }}
        />
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={() => setCanBeMadeOnly(!canBeMadeOnly)}
            data-testid="can-be-made-filter"
            style={{
              padding: '6px 14px',
              borderRadius: '16px',
              border: canBeMadeOnly ? '1px solid #2f9e44' : '1px solid #ddd',
              background: canBeMadeOnly ? '#ecfdf5' : '#fff',
              color: canBeMadeOnly ? '#2f9e44' : '#4b5563',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Can Be Made
          </button>
          <button
            onClick={() => setMaxActiveTime(maxActiveTime === 30 ? null : 30)}
            data-testid="active-time-filter"
            style={{
              padding: '6px 14px',
              borderRadius: '16px',
              border: maxActiveTime === 30 ? '1px solid #1e66f5' : '1px solid #ddd',
              background: maxActiveTime === 30 ? '#eff6ff' : '#fff',
              color: maxActiveTime === 30 ? '#1e66f5' : '#4b5563',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            &lt; 30 min
          </button>

          {/* High Protein filter + edit threshold */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
            <button
              onClick={() => setHighProteinOnly(!highProteinOnly)}
              data-testid="high-protein-filter"
              style={{
                padding: '6px 14px',
                borderRadius: editingThreshold === 'protein' ? '16px 0 0 16px' : '16px',
                border: highProteinOnly ? '1px solid #7c3aed' : '1px solid #ddd',
                borderRight: editingThreshold === 'protein' ? 'none' : undefined,
                background: highProteinOnly ? '#f5f3ff' : '#fff',
                color: highProteinOnly ? '#7c3aed' : '#4b5563',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              High Protein ({proteinThreshold}g/100cal)
            </button>
            {editingThreshold !== 'protein' ? (
              <button
                onClick={() => {
                  setEditingThreshold('protein');
                  setThresholdInput(String(proteinThreshold));
                }}
                data-testid="edit-protein-threshold"
                title="Edit threshold"
                style={{
                  padding: '4px 6px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  background: '#f9fafb',
                  cursor: 'pointer',
                  fontSize: '11px',
                  color: '#666',
                  lineHeight: 1,
                }}
              >
                ✎
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
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
                }}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                <input
                  type="number"
                  value={thresholdInput}
                  onChange={(e) => setThresholdInput(e.target.value)}
                  autoFocus
                  step="0.5"
                  min="0"
                  data-testid="protein-threshold-input"
                  style={{
                    width: '55px',
                    padding: '5px 4px',
                    border: '1px solid #7c3aed',
                    borderRadius: '0',
                    fontSize: '13px',
                    textAlign: 'center',
                  }}
                  onBlur={() => {
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
                  }}
                />
                <button
                  type="submit"
                  data-testid="save-protein-threshold"
                  style={{
                    padding: '5px 8px',
                    border: '1px solid #7c3aed',
                    borderLeft: 'none',
                    borderRadius: '0 16px 16px 0',
                    background: '#7c3aed',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  OK
                </button>
              </form>
            )}
          </div>

          {/* High Carbs filter + edit threshold */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
            <button
              onClick={() => setHighCarbsOnly(!highCarbsOnly)}
              data-testid="high-carbs-filter"
              style={{
                padding: '6px 14px',
                borderRadius: editingThreshold === 'carbs' ? '16px 0 0 16px' : '16px',
                border: highCarbsOnly ? '1px solid #d97706' : '1px solid #ddd',
                borderRight: editingThreshold === 'carbs' ? 'none' : undefined,
                background: highCarbsOnly ? '#fffbeb' : '#fff',
                color: highCarbsOnly ? '#d97706' : '#4b5563',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              High Carbs ({carbsThreshold}g/100cal)
            </button>
            {editingThreshold !== 'carbs' ? (
              <button
                onClick={() => {
                  setEditingThreshold('carbs');
                  setThresholdInput(String(carbsThreshold));
                }}
                data-testid="edit-carbs-threshold"
                title="Edit threshold"
                style={{
                  padding: '4px 6px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  background: '#f9fafb',
                  cursor: 'pointer',
                  fontSize: '11px',
                  color: '#666',
                  lineHeight: 1,
                }}
              >
                ✎
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
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
                }}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                <input
                  type="number"
                  value={thresholdInput}
                  onChange={(e) => setThresholdInput(e.target.value)}
                  autoFocus
                  step="0.5"
                  min="0"
                  data-testid="carbs-threshold-input"
                  style={{
                    width: '55px',
                    padding: '5px 4px',
                    border: '1px solid #d97706',
                    borderRadius: '0',
                    fontSize: '13px',
                    textAlign: 'center',
                  }}
                  onBlur={() => {
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
                  }}
                />
                <button
                  type="submit"
                  data-testid="save-carbs-threshold"
                  style={{
                    padding: '5px 8px',
                    border: '1px solid #d97706',
                    borderLeft: 'none',
                    borderRadius: '0 16px 16px 0',
                    background: '#d97706',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  OK
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  RECIPE CARDS                                                 */}
      {/* ============================================================ */}
      <div data-testid="recipe-list" className="recipesList">
        {filteredRecipes.length === 0 && <p data-testid="no-recipes">No recipes found.</p>}

        {filteredRecipes.map((recipe) => {
          const macros = computeRecipeMacros(recipe.recipe_ingredients, Number(recipe.base_servings));
          const status = computeStockStatus(recipe.recipe_ingredients, stockByProduct);

          return (
            <Link
              key={recipe.recipe_id}
              to={`/chef/recipes/${recipe.recipe_id}`}
              className="recipeListItem"
              data-testid={`recipe-card-${recipe.recipe_id}`}
              style={{
                background: '#fff',
                border: '1px solid #eee',
                borderRadius: '10px',
                padding: '16px',
                display: 'block',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <h3
                style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 600 }}
                data-testid={`recipe-name-${recipe.recipe_id}`}
              >
                {recipe.name}
              </h3>
              {recipe.description && (
                <p
                  style={{ fontSize: '0.85em', color: '#666', margin: '4px 0 0' }}
                  data-testid={`recipe-desc-${recipe.recipe_id}`}
                >
                  {recipe.description.length > 60 ? recipe.description.slice(0, 60) + '...' : recipe.description}
                </p>
              )}
              <div style={{ display: 'flex', gap: '12px', fontSize: '13px', color: '#888', margin: '6px 0 10px' }}>
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
              <div
                data-testid={`recipe-macros-${recipe.recipe_id}`}
                className="recipeMacros"
                style={{ marginBottom: '10px' }}
              >
                <div className="macroItem">
                  <span className="value">{macros.calories}</span>
                  <span className="label" style={{ fontSize: '12px', color: '#888', marginLeft: '2px' }}>
                    Cal
                  </span>
                </div>
                <div className="macroItem">
                  <span className="value">{macros.protein}g</span>
                  <span className="label" style={{ fontSize: '12px', color: '#888', marginLeft: '2px' }}>
                    P
                  </span>
                </div>
                <div className="macroItem">
                  <span className="value">{macros.carbs}g</span>
                  <span className="label" style={{ fontSize: '12px', color: '#888', marginLeft: '2px' }}>
                    C
                  </span>
                </div>
                <div className="macroItem">
                  <span className="value">{macros.fat}g</span>
                  <span className="label" style={{ fontSize: '12px', color: '#888', marginLeft: '2px' }}>
                    F
                  </span>
                </div>
              </div>

              {/* Stock status */}
              <div style={{ marginBottom: '8px' }}>
                <span style={stockStatusStyle(status)} data-testid={`stock-status-${recipe.recipe_id}`}>
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
