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

export function computeStockStatus(ingredients: RecipeIngredient[], stockByProduct: Map<string, number>): StockStatus {
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

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [stockByProduct, setStockByProduct] = useState<Map<string, number>>(new Map());

  /* ---- Filter state ---- */
  const [searchText, setSearchText] = useState('');
  const [maxActiveTime, setMaxActiveTime] = useState<number | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadData = useCallback(async () => {
    if (!user) return;

    const { data: recipeData } = await chefbyte()
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('user_id', user.id)
      .order('name');

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

    // Can be made filter -- disabled until stock check is fully wired

    return result;
  }, [recipes, searchText, maxActiveTime]);

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
      {/* ============================================================ */}
      {/*  HEADER                                                       */}
      {/* ============================================================ */}
      <div className="cb-recipes-header">
        <h1 style={{ margin: 0 }}>Recipes</h1>
        <div className="cb-header-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Link
            to="/chef/recipes/finder"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '12px 16px',
              textDecoration: 'none',
              borderRadius: '6px',
              fontWeight: 600,
              fontSize: '14px',
              background: '#fff',
              border: '1px solid #ddd',
              color: '#4b5563',
            }}
          >
            Recipe Finder
          </Link>
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
            disabled
            title="Coming soon"
            data-testid="can-be-made-filter"
            style={{
              padding: '6px 14px',
              borderRadius: '16px',
              border: '1px solid #ddd',
              background: '#f3f4f6',
              color: '#9ca3af',
              cursor: 'not-allowed',
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
        </div>
      </div>

      {/* ============================================================ */}
      {/*  RECIPE CARDS                                                 */}
      {/* ============================================================ */}
      <div data-testid="recipe-list" className="cb-recipes-list">
        {filteredRecipes.length === 0 && <p data-testid="no-recipes">No recipes found.</p>}

        {filteredRecipes.map((recipe) => {
          const macros = computeRecipeMacros(recipe.recipe_ingredients, Number(recipe.base_servings));
          const status = computeStockStatus(recipe.recipe_ingredients, stockByProduct);

          return (
            <Link
              key={recipe.recipe_id}
              to={`/chef/recipes/${recipe.recipe_id}`}
              className="cb-recipe-item"
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
                className="cb-recipe-macros"
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
