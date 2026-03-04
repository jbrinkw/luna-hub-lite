import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonButton,
  IonInput,
  IonChip,
  IonBadge,
} from '@ionic/react';
import { useNavigate } from 'react-router-dom';
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
    // Ingredient quantity is in containers or servings — compare against container stock
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

function stockStatusColor(status: StockStatus): string {
  switch (status) {
    case 'CAN MAKE':
      return 'success';
    case 'PARTIAL':
      return 'warning';
    case 'NO STOCK':
      return 'danger';
    case 'N/A':
      return 'medium';
  }
}

/* ================================================================== */
/*  RecipesPage                                                        */
/* ================================================================== */

export function RecipesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
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

    // Can be made filter — disabled until stock check is fully wired

    return result;
  }, [recipes, searchText, maxActiveTime]);

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Recipes">
        <IonSpinner data-testid="recipes-loading" />
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Recipes">
      <h2>RECIPES</h2>

      {/* ============================================================ */}
      {/*  FILTERS                                                      */}
      {/* ============================================================ */}
      <div data-testid="recipes-filters" style={{ marginBottom: '16px' }}>
        <IonInput
          placeholder="Search recipes..."
          aria-label="Search recipes"
          value={searchText}
          onIonInput={(e) => setSearchText(e.detail.value ?? '')}
          data-testid="recipe-search"
          style={{ marginBottom: '8px' }}
        />
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <IonChip disabled title="Coming soon" data-testid="can-be-made-filter">
            Can Be Made
          </IonChip>
          <IonChip
            color={maxActiveTime === 30 ? 'primary' : undefined}
            onClick={() => setMaxActiveTime(maxActiveTime === 30 ? null : 30)}
            data-testid="active-time-filter"
          >
            &lt; 30 min
          </IonChip>
          <IonButton size="small" onClick={() => navigate('/chef/recipes/new')} data-testid="new-recipe-btn">
            + New Recipe
          </IonButton>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  RECIPE CARDS                                                 */}
      {/* ============================================================ */}
      <div data-testid="recipe-list">
        {filteredRecipes.length === 0 && <p data-testid="no-recipes">No recipes found.</p>}

        {filteredRecipes.map((recipe) => {
          const macros = computeRecipeMacros(recipe.recipe_ingredients, Number(recipe.base_servings));

          return (
            <IonCard key={recipe.recipe_id} data-testid={`recipe-card-${recipe.recipe_id}`}>
              <IonCardHeader>
                <IonCardTitle
                  onClick={() => navigate(`/chef/recipes/${recipe.recipe_id}`)}
                  style={{ cursor: 'pointer' }}
                  data-testid={`recipe-name-${recipe.recipe_id}`}
                >
                  {recipe.name}
                </IonCardTitle>
                {recipe.description && (
                  <p
                    style={{ fontSize: '0.85em', color: '#666', margin: '4px 0 0' }}
                    data-testid={`recipe-desc-${recipe.recipe_id}`}
                  >
                    {recipe.description.length > 60 ? recipe.description.slice(0, 60) + '...' : recipe.description}
                  </p>
                )}
                <span style={{ fontSize: '0.8em', color: '#888' }} data-testid={`recipe-servings-${recipe.recipe_id}`}>
                  Base servings: {Number(recipe.base_servings)}
                </span>
              </IonCardHeader>
              <IonCardContent>
                {/* Time info */}
                <div style={{ fontSize: '0.85em', color: '#666', marginBottom: '8px' }}>
                  {recipe.active_time != null && (
                    <span data-testid={`active-time-${recipe.recipe_id}`}>Active: {recipe.active_time} min</span>
                  )}
                  {recipe.active_time != null && recipe.total_time != null && ' / '}
                  {recipe.total_time != null && (
                    <span data-testid={`total-time-${recipe.recipe_id}`}>Total: {recipe.total_time} min</span>
                  )}
                </div>

                {/* Per-serving macros */}
                <div
                  data-testid={`recipe-macros-${recipe.recipe_id}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr 1fr',
                    gap: '4px',
                    marginBottom: '8px',
                    fontSize: '0.9em',
                  }}
                >
                  <span>{macros.calories} cal</span>
                  <span>{macros.protein}g P</span>
                  <span>{macros.carbs}g C</span>
                  <span>{macros.fat}g F</span>
                </div>

                {/* Stock status */}
                <div style={{ marginBottom: '8px' }}>
                  {(() => {
                    const status = computeStockStatus(recipe.recipe_ingredients, stockByProduct);
                    return (
                      <IonBadge color={stockStatusColor(status)} data-testid={`stock-status-${recipe.recipe_id}`}>
                        {status}
                      </IonBadge>
                    );
                  })()}
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <IonButton
                    size="small"
                    fill="outline"
                    onClick={() => navigate('/chef/meal-plan')}
                    data-testid={`meal-plan-btn-${recipe.recipe_id}`}
                  >
                    + Meal Plan
                  </IonButton>
                </div>
              </IonCardContent>
            </IonCard>
          );
        })}
      </div>
    </ChefLayout>
  );
}
