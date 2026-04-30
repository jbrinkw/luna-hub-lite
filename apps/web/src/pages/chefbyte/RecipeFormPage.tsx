import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, escapeIlike } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { computeRecipeMacros } from './RecipesPage';
import { formatIngredientDisplay } from '@/shared/recipes/formatIngredientDisplay';
import { Trash2, Pencil } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ProductSearchResult {
  product_id: string;
  name: string;
  calories_per_serving: number;
  carbs_per_serving: number;
  protein_per_serving: number;
  fat_per_serving: number;
  servings_per_container: number;
  net_weight_g: number | null;
  default_recipe_unit: 'gram' | 'serving' | 'container' | null;
  visual_unit_label: string | null;
  visual_units_per_serving: number | null;
}

interface LocalIngredient {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  note: string;
  // Macro info for display
  calories_per_serving: number;
  carbs_per_serving: number;
  protein_per_serving: number;
  fat_per_serving: number;
  servings_per_container: number;
  net_weight_g: number | null;
  // Visual unit fields are display-only and live on the product. They
  // are denormalized onto each ingredient row so the form-render preview
  // does not need a second product lookup. Server-side they are pulled
  // from chefbyte.products on every read of recipe_ingredients.
  visual_unit_label: string | null;
  visual_units_per_serving: number | null;
}

/* ================================================================== */
/*  RecipeFormPage                                                      */
/* ================================================================== */

export function RecipeFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const isEdit = !!id;

  /* ---- Form fields ---- */
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseServings, setBaseServings] = useState(1);
  const [activeTime, setActiveTime] = useState<number | null>(null);
  const [totalTime, setTotalTime] = useState<number | null>(null);
  const [instructions, setInstructions] = useState('');

  /* ---- Ingredient state ---- */
  const [ingredients, setIngredients] = useState<LocalIngredient[]>([]);

  /* ---- Product search state ---- */
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<ProductSearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductSearchResult | null>(null);
  const [ingQuantity, setIngQuantity] = useState(1);
  const [ingUnit, setIngUnit] = useState<string>('serving');
  const [ingNote, setIngNote] = useState('');

  /* ---- Page mode (view vs. edit). New recipes land in `edit` (nothing to view).
         Existing recipes land in `view` and switch to `edit` via the header
         action button. Cancel / save in edit mode return to `view`. ---- */
  const [pageMode, setPageMode] = useState<'view' | 'edit'>(isEdit ? 'view' : 'edit');

  /* ---- Snapshot of the originally-loaded data so Cancel can revert local form
         state without re-fetching. Captured after the first server-data
         population, and re-captured every time we re-enter `edit` from `view`
         (so a saved-then-cancel cycle works correctly). ---- */
  type Snapshot = {
    name: string;
    description: string;
    baseServings: number;
    activeTime: number | null;
    totalTime: number | null;
    instructions: string;
    ingredients: LocalIngredient[];
  };
  const snapshotRef = useRef<Snapshot | null>(null);

  /* ---- Delete confirmation ---- */
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /* ---- Form populated flag (prevent re-populating on refetch) ---- */
  const [formPopulated, setFormPopulated] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Load existing recipe (edit mode) via TanStack Query              */
  /* ---------------------------------------------------------------- */

  const { isLoading } = useQuery({
    queryKey: queryKeys.recipe(id!),
    queryFn: async () => {
      const { data: recipe, error } = await chefbyte()
        .from('recipes')
        .select(
          '*, recipe_ingredients(ingredient_id, product_id, quantity, unit, note, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container, net_weight_g, visual_unit_label, visual_units_per_serving))',
        )
        .eq('recipe_id', id!)
        .eq('user_id', user!.id)
        .single();

      if (error) throw error;
      return recipe;
    },
    enabled: isEdit && !!user,
    // Populate form state from fetched data
    // Use a ref-like pattern: only populate once
  });

  // Populate form fields from fetched recipe data (once)
  const cachedRecipe = isEdit ? queryClient.getQueryData(queryKeys.recipe(id!)) : null;

  /* eslint-disable react-hooks/set-state-in-effect -- syncing server data to form fields */
  useEffect(() => {
    if (!isEdit || formPopulated || !cachedRecipe) return;
    const recipe = cachedRecipe as any;

    const loadedName = recipe.name ?? '';
    const loadedDesc = recipe.description ?? '';
    const loadedBase = Number(recipe.base_servings) || 1;
    const loadedActive = recipe.active_time != null ? Number(recipe.active_time) : null;
    const loadedTotal = recipe.total_time != null ? Number(recipe.total_time) : null;
    const loadedInstr = recipe.instructions ?? '';

    setName(loadedName);
    setDescription(loadedDesc);
    setBaseServings(loadedBase);
    setActiveTime(loadedActive);
    setTotalTime(loadedTotal);
    setInstructions(loadedInstr);

    const ings: LocalIngredient[] = (recipe.recipe_ingredients ?? []).map((ri: any) => ({
      product_id: ri.product_id,
      product_name: ri.products?.name ?? 'Unknown',
      quantity: Number(ri.quantity),
      unit: ri.unit,
      note: ri.note ?? '',
      calories_per_serving: Number(ri.products?.calories_per_serving ?? 0),
      carbs_per_serving: Number(ri.products?.carbs_per_serving ?? 0),
      protein_per_serving: Number(ri.products?.protein_per_serving ?? 0),
      fat_per_serving: Number(ri.products?.fat_per_serving ?? 0),
      servings_per_container: Number(ri.products?.servings_per_container ?? 1),
      net_weight_g: ri.products?.net_weight_g != null ? Number(ri.products.net_weight_g) : null,
      visual_unit_label: ri.products?.visual_unit_label ?? null,
      visual_units_per_serving:
        ri.products?.visual_units_per_serving != null ? Number(ri.products.visual_units_per_serving) : null,
    }));
    setIngredients(ings);
    snapshotRef.current = {
      name: loadedName,
      description: loadedDesc,
      baseServings: loadedBase,
      activeTime: loadedActive,
      totalTime: loadedTotal,
      instructions: loadedInstr,
      ingredients: ings,
    };
    setFormPopulated(true);
  }, [isEdit, cachedRecipe, formPopulated]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loading = isEdit && isLoading;

  /* ---------------------------------------------------------------- */
  /*  Product search (server-side ilike + 300ms debounce)              */
  /* ---------------------------------------------------------------- */

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const searchProducts = useCallback(
    async (text: string) => {
      if (!user || text.trim().length < 1) {
        setSearchResults([]);
        setShowDropdown(false);
        return;
      }
      // Exclude `[MEAL]` carve-outs — these are meal-prep allocation
      // products that mirror real ingredients only for inventory
      // bookkeeping. Selecting one as a recipe ingredient pollutes
      // recipes with placeholder rows that disappear when the meal is
      // cleared. SettingsPage applies the same exclusion when listing
      // products (`SettingsPage.tsx:124`).
      const { data } = await chefbyte()
        .from('products')
        .select(
          'product_id, name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container, net_weight_g, default_recipe_unit, visual_unit_label, visual_units_per_serving',
        )
        .eq('user_id', user.id)
        .ilike('name', `%${escapeIlike(text)}%`)
        .not('name', 'ilike', '[MEAL]%')
        .order('name');

      const results = (data ?? []) as ProductSearchResult[];
      setSearchResults(results);
      setShowDropdown(results.length > 0);
    },
    [user],
  );

  const handleSearchInput = (value: string) => {
    setSearchText(value);
    setSelectedProduct(null);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => searchProducts(value), 300);
  };

  const selectProduct = (product: ProductSearchResult) => {
    setSearchText(product.name);
    setSelectedProduct(product);
    setShowDropdown(false);
    setSearchResults([]);

    // Smart default unit for new ingredient adds only (existing recipe loads
    // populate ingUnit from the saved ingredient row via the useEffect above).
    // Priority:
    //   1. product.default_recipe_unit if non-null AND viable (gram requires net_weight_g > 0)
    //   2. 'gram' if net_weight_g > 0
    //   3. 'serving' (final fallback)
    const hasWeight = (product.net_weight_g ?? 0) > 0;
    if (product.default_recipe_unit && product.default_recipe_unit !== null) {
      if (product.default_recipe_unit === 'gram' && !hasWeight) {
        setIngUnit(hasWeight ? 'gram' : 'serving');
      } else {
        setIngUnit(product.default_recipe_unit);
      }
    } else if (hasWeight) {
      setIngUnit('gram');
    } else {
      setIngUnit('serving');
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Add ingredient                                                   */
  /* ---------------------------------------------------------------- */

  const addIngredient = () => {
    if (!selectedProduct || ingQuantity <= 0) return;

    const newIng: LocalIngredient = {
      product_id: selectedProduct.product_id,
      product_name: selectedProduct.name,
      quantity: ingQuantity,
      unit: ingUnit,
      note: ingNote,
      calories_per_serving: Number(selectedProduct.calories_per_serving),
      carbs_per_serving: Number(selectedProduct.carbs_per_serving),
      protein_per_serving: Number(selectedProduct.protein_per_serving),
      fat_per_serving: Number(selectedProduct.fat_per_serving),
      servings_per_container: Number(selectedProduct.servings_per_container),
      net_weight_g: selectedProduct.net_weight_g != null ? Number(selectedProduct.net_weight_g) : null,
      visual_unit_label: selectedProduct.visual_unit_label ?? null,
      visual_units_per_serving:
        selectedProduct.visual_units_per_serving != null ? Number(selectedProduct.visual_units_per_serving) : null,
    };

    setIngredients((prev) => [...prev, newIng]);
    setSearchText('');
    setSelectedProduct(null);
    setIngQuantity(1);
    setIngUnit('serving');
    setIngNote('');
  };

  const removeIngredient = (index: number) => {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  };

  const updateIngredient = (index: number, field: keyof LocalIngredient, value: string | number) => {
    setIngredients((prev) => prev.map((ing, i) => (i === index ? { ...ing, [field]: value } : ing)));
  };

  /* ---------------------------------------------------------------- */
  /*  Macro display                                                    */
  /* ---------------------------------------------------------------- */

  const macros = useMemo(() => {
    const mapped = ingredients.map((ing) => ({
      quantity: ing.quantity,
      unit: ing.unit,
      products: {
        calories_per_serving: ing.calories_per_serving,
        carbs_per_serving: ing.carbs_per_serving,
        protein_per_serving: ing.protein_per_serving,
        fat_per_serving: ing.fat_per_serving,
        servings_per_container: ing.servings_per_container,
        net_weight_g: ing.net_weight_g,
      },
    }));
    return computeRecipeMacros(mapped, baseServings);
  }, [ingredients, baseServings]);

  const totalMacros = useMemo(() => {
    const mapped = ingredients.map((ing) => ({
      quantity: ing.quantity,
      unit: ing.unit,
      products: {
        calories_per_serving: ing.calories_per_serving,
        carbs_per_serving: ing.carbs_per_serving,
        protein_per_serving: ing.protein_per_serving,
        fat_per_serving: ing.fat_per_serving,
        servings_per_container: ing.servings_per_container,
        net_weight_g: ing.net_weight_g,
      },
    }));
    return computeRecipeMacros(mapped, 1);
  }, [ingredients]);

  /* ---------------------------------------------------------------- */
  /*  Save mutation                                                    */
  /* ---------------------------------------------------------------- */

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!user || !name.trim()) throw new Error('Name is required');
      if (ingredients.length === 0) throw new Error('At least one ingredient is required.');

      if (isEdit && id) {
        // Update recipe
        const { error: updateErr } = await chefbyte()
          .from('recipes')
          .update({
            name: name.trim(),
            description: description || null,
            base_servings: baseServings,
            active_time: activeTime,
            total_time: totalTime,
            instructions: instructions || null,
          })
          .eq('recipe_id', id)
          .eq('user_id', user.id);

        if (updateErr) throw updateErr;

        // Atomic ingredient save via RPC (delete old + insert new in one transaction)
        if (ingredients.length === 0) {
          // Zero ingredients: just delete existing
          const { error: delErr } = await chefbyte()
            .from('recipe_ingredients')
            .delete()
            .eq('recipe_id', id)
            .eq('user_id', user.id);
          if (delErr) throw delErr;
        } else {
          const { error: ingErr } = await chefbyte().rpc('save_recipe_ingredients', {
            p_recipe_id: id,
            p_ingredients: ingredients.map((ing) => ({
              product_id: ing.product_id,
              quantity: ing.quantity,
              unit: ing.unit,
              note: ing.note || null,
            })),
          });
          if (ingErr) throw ingErr;
        }
      } else {
        // Create recipe
        const { data: newRecipe, error: createErr } = await chefbyte()
          .from('recipes')
          .insert({
            user_id: user.id,
            name: name.trim(),
            description: description || null,
            base_servings: baseServings,
            active_time: activeTime,
            total_time: totalTime,
            instructions: instructions || null,
          })
          .select('recipe_id')
          .single();

        if (createErr || !newRecipe) throw createErr ?? new Error('Failed to create recipe');

        if (ingredients.length > 0) {
          const { error: ingErr } = await chefbyte().rpc('save_recipe_ingredients', {
            p_recipe_id: newRecipe.recipe_id,
            p_ingredients: ingredients.map((ing) => ({
              product_id: ing.product_id,
              quantity: ing.quantity,
              unit: ing.unit,
              note: ing.note || null,
            })),
          });
          if (ingErr) throw ingErr;
        }
      }
    },
    onError: (err: any) => {
      setSaveError(err.message ?? String(err));
    },
    onSuccess: () => {
      // Invalidate recipe-related queries
      queryClient.invalidateQueries({ queryKey: queryKeys.recipes(user!.id) });
      if (id) queryClient.invalidateQueries({ queryKey: queryKeys.recipe(id) });
      if (isEdit) {
        // Re-snapshot saved state and drop back to view mode so the user can
        // see their work without bouncing back to the recipe list.
        snapshotRef.current = {
          name,
          description,
          baseServings,
          activeTime,
          totalTime,
          instructions,
          ingredients,
        };
        setPageMode('view');
      } else {
        // New recipe: navigate to the recipe list as before.
        navigate('/chef/recipes');
      }
    },
  });

  const handleSave = () => {
    if (!user || !name.trim()) return;
    if (ingredients.length === 0) {
      setSaveError('At least one ingredient is required.');
      return;
    }
    setSaveError(null);
    saveMutation.mutate();
  };

  /* ---------------------------------------------------------------- */
  /*  View / Edit toggle helpers                                       */
  /* ---------------------------------------------------------------- */

  const enterEditMode = () => {
    // Re-capture the snapshot from current state so a Cancel later reverts
    // exactly to what the user is seeing now (covers the post-save case
    // where the snapshot needs to align with the freshly persisted data).
    snapshotRef.current = {
      name,
      description,
      baseServings,
      activeTime,
      totalTime,
      instructions,
      ingredients,
    };
    setSaveError(null);
    setPageMode('edit');
  };

  const cancelEdit = () => {
    if (!isEdit) {
      // Cancel on the new-recipe page acts as "discard and go back".
      navigate('/chef/recipes');
      return;
    }
    const snap = snapshotRef.current;
    if (snap) {
      setName(snap.name);
      setDescription(snap.description);
      setBaseServings(snap.baseServings);
      setActiveTime(snap.activeTime);
      setTotalTime(snap.totalTime);
      setInstructions(snap.instructions);
      setIngredients(snap.ingredients);
    }
    // Reset add-ingredient inline form so a half-typed entry doesn't survive
    // the cancel.
    setSearchText('');
    setSelectedProduct(null);
    setSearchResults([]);
    setShowDropdown(false);
    setIngQuantity(1);
    setIngUnit('serving');
    setIngNote('');
    setSaveError(null);
    setPageMode('view');
  };

  /* ---------------------------------------------------------------- */
  /*  Delete mutation (edit mode only)                                 */
  /* ---------------------------------------------------------------- */

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!id || !user) throw new Error('Missing recipe or user');
      const { error: ingErr } = await chefbyte()
        .from('recipe_ingredients')
        .delete()
        .eq('recipe_id', id)
        .eq('user_id', user.id);
      if (ingErr) throw ingErr;
      const { error: recErr } = await chefbyte().from('recipes').delete().eq('recipe_id', id).eq('user_id', user.id);
      if (recErr) throw recErr;
    },
    onError: (err: any) => {
      setSaveError(err.message ?? String(err));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.recipes(user!.id) });
      navigate('/chef/recipes');
    },
  });

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  const inputCls =
    'w-full px-3 py-2.5 border border-border-strong rounded-md text-sm bg-surface text-text focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary';
  const labelCls = 'block mb-1 font-semibold text-sm text-text-secondary';

  if (loading) {
    return (
      <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
        <div data-testid="recipe-form-loading" className="p-5">
          <CardSkeleton />
        </div>
      </ChefLayout>
    );
  }

  // Helper: is gram unit available for a product?
  const gramAvailable = (netWeightG: number | null) => netWeightG != null && netWeightG > 0;

  const isViewMode = pageMode === 'view';

  return (
    <ChefLayout title={isEdit ? (isViewMode ? 'Recipe' : 'Edit Recipe') : 'New Recipe'}>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <Link to="/chef/recipes" className="text-sm font-medium text-emerald-600 hover:text-emerald-700 no-underline">
            &larr; Recipes
          </Link>
          <h1 className="mt-2 mb-0 text-2xl font-bold text-text" data-testid="recipe-page-heading">
            {isEdit ? (isViewMode ? name || 'Recipe' : 'Edit Recipe') : 'New Recipe'}
          </h1>
        </div>
        {/* Top-right action: Edit button when viewing an existing recipe.
            New recipes have no view mode, so no toggle is rendered there. */}
        {isEdit && isViewMode && (
          <button
            type="button"
            onClick={enterEditMode}
            data-testid="enter-edit-mode-btn"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors"
          >
            <Pencil className="h-4 w-4" /> Edit
          </button>
        )}
      </div>

      {saveError && (
        <p className="text-danger-text bg-danger-subtle px-3.5 py-2.5 rounded-md border border-danger">{saveError}</p>
      )}

      {/* ============================================================ */}
      {/*  RECIPE FIELDS                                                */}
      {/* ============================================================ */}
      <div data-testid="recipe-fields" className="bg-surface border border-border rounded-lg p-5 mb-4">
        {isViewMode ? (
          /* ---- VIEW: read-only field rendering ---- */
          <div data-testid="recipe-fields-view" className="space-y-3">
            {description && (
              <p className="m-0 text-sm text-text-secondary" data-testid="recipe-description-view">
                {description}
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-tertiary">
              <span data-testid="recipe-base-servings-view">
                <span className="font-semibold text-text">{baseServings}</span> serving
                {baseServings === 1 ? '' : 's'}
              </span>
              {activeTime != null && (
                <span data-testid="recipe-active-time-view">
                  Active: <span className="font-semibold text-text">{activeTime}</span> min
                </span>
              )}
              {totalTime != null && (
                <span data-testid="recipe-total-time-view">
                  Total: <span className="font-semibold text-text">{totalTime}</span> min
                </span>
              )}
            </div>
            {instructions && (
              <div data-testid="recipe-instructions-view">
                <h4 className="m-0 mb-1 text-sm font-semibold text-text-secondary">Instructions</h4>
                <p className="m-0 whitespace-pre-wrap text-sm text-text">{instructions}</p>
              </div>
            )}
          </div>
        ) : (
          /* ---- EDIT: full input form ---- */
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-3">
              <label className={labelCls}>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="recipe-name"
                required
                placeholder="Recipe name"
                className={inputCls}
              />
            </div>
            <div className="md:col-span-3">
              <label className={labelCls}>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="recipe-description"
                placeholder="Brief description"
                className={`${inputCls} resize-y min-h-[60px]`}
              />
            </div>
            <div>
              <label className={labelCls}>Base Servings</label>
              <input
                type="number"
                min="0"
                value={baseServings}
                onChange={(e) => setBaseServings(Number(e.target.value) || 1)}
                data-testid="recipe-base-servings"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Active Time (min)</label>
              <input
                type="number"
                min="0"
                value={activeTime ?? ''}
                onChange={(e) => setActiveTime(e.target.value ? Number(e.target.value) : null)}
                data-testid="recipe-active-time"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Total Time (min)</label>
              <input
                type="number"
                min="0"
                value={totalTime ?? ''}
                onChange={(e) => setTotalTime(e.target.value ? Number(e.target.value) : null)}
                data-testid="recipe-total-time"
                className={inputCls}
              />
            </div>
            <div className="md:col-span-3">
              <label className={labelCls}>Instructions</label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                data-testid="recipe-instructions"
                placeholder="Step-by-step instructions"
                className={`${inputCls} resize-y min-h-[100px]`}
              />
            </div>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/*  INGREDIENTS SECTION                                          */}
      {/* ============================================================ */}
      <div data-testid="ingredients-section" className="bg-surface border border-border rounded-lg p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="m-0 text-lg font-bold text-text">Ingredients</h3>
        </div>

        {/* Add ingredient form (edit mode only) — single horizontal row.
            Layout per spec: [product picker (flex-1)] [qty (w-20)] [unit (w-24)]
            [add btn]. Note becomes a per-row inline field on already-added
            ingredients, not a separate column on the add form. */}
        {!isViewMode && (
          <div data-testid="add-ingredient-form" className="flex items-end gap-2 mb-4">
            <div className="flex-1 min-w-[150px] relative">
              <label className={labelCls}>Product</label>
              <input
                value={searchText}
                onChange={(e) => handleSearchInput(e.target.value)}
                data-testid="ingredient-product-search"
                placeholder="Search products..."
                className={inputCls}
              />
              {showDropdown && (
                <div
                  data-testid="ingredient-product-dropdown"
                  className="absolute top-full left-0 right-0 bg-surface border border-border-strong rounded shadow-lg z-10 max-h-[200px] overflow-auto"
                >
                  {searchResults.map((p) => (
                    <div
                      key={p.product_id}
                      onClick={() => selectProduct(p)}
                      data-testid={`ing-dropdown-item-${p.product_id}`}
                      className="px-3 py-2 cursor-pointer border-b border-border-light hover:bg-surface-hover text-sm"
                    >
                      {p.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="w-20 shrink-0">
              <label className={labelCls}>Qty</label>
              <input
                type="number"
                min="0"
                value={ingQuantity}
                onChange={(e) => setIngQuantity(Number(e.target.value) || 1)}
                data-testid="ingredient-qty"
                className={inputCls}
              />
            </div>
            <div className="w-24 shrink-0">
              <label className={labelCls}>Unit</label>
              <select
                value={ingUnit}
                onChange={(e) => setIngUnit(e.target.value)}
                data-testid="ingredient-unit"
                className={inputCls}
              >
                <option value="serving">Serving</option>
                <option value="container">Container</option>
                <option
                  value="gram"
                  disabled={!gramAvailable(selectedProduct?.net_weight_g ?? null)}
                  title={
                    !gramAvailable(selectedProduct?.net_weight_g ?? null)
                      ? 'Set net weight on the product first'
                      : undefined
                  }
                >
                  g (gram)
                </option>
              </select>
            </div>
            <button
              onClick={addIngredient}
              disabled={!selectedProduct}
              data-testid="add-ingredient-btn"
              className="shrink-0 px-4 py-2.5 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
        {/* Gram-unit missing weight error sits below the row so it doesn't
            disturb the single-line layout. */}
        {!isViewMode && ingUnit === 'gram' && selectedProduct && !gramAvailable(selectedProduct.net_weight_g) && (
          <p className="mb-3 text-xs text-danger-text" data-testid="gram-unit-missing-weight-error">
            This product has no net weight. Set net_weight_g on the product to use gram unit.
          </p>
        )}

        {/* Ingredient list */}
        {ingredients.length > 0 && (
          <div className="mb-3" data-testid="ingredients-table">
            {isViewMode ? (
              /* ---- VIEW MODE: plain bulleted read-only list ---- */
              <ul data-testid="ingredients-list-view" className="m-0 pl-5 list-disc space-y-1 text-sm text-text">
                {ingredients.map((ing, idx) => (
                  <li key={`${ing.product_id}-${idx}`} data-testid={`ingredient-row-${idx}`}>
                    <span className="tabular-nums">
                      {formatIngredientDisplay({
                        quantity: ing.quantity,
                        unit: ing.unit as 'container' | 'serving' | 'gram',
                        productName: ing.product_name,
                        visualUnitLabel: ing.visual_unit_label,
                        visualUnitsPerServing: ing.visual_units_per_serving,
                        servingsPerContainer: ing.servings_per_container,
                      })}
                    </span>
                    {ing.note && <span className="ml-2 text-xs text-text-tertiary italic">&bull; {ing.note}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              /* ---- EDIT MODE: 1-row per ingredient (product, qty, unit, note, remove) ---- */
              <div className="space-y-1.5">
                {ingredients.map((ing, idx) => (
                  <div
                    key={`${ing.product_id}-${idx}`}
                    data-testid={`ingredient-row-${idx}`}
                    className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-2"
                  >
                    {/* Product name */}
                    <span className="font-medium text-sm text-text flex-1 truncate">{ing.product_name}</span>

                    {/* Qty */}
                    <input
                      type="number"
                      min="0"
                      value={ing.quantity}
                      onChange={(e) => updateIngredient(idx, 'quantity', Number(e.target.value) || 0)}
                      className="w-20 px-2 py-1.5 border border-border-strong rounded text-sm text-right focus:outline-none focus:ring-2 focus:ring-focus-ring shrink-0"
                      data-testid={`edit-qty-${idx}`}
                      aria-label={`Quantity for ${ing.product_name}`}
                    />

                    {/* Unit */}
                    <select
                      value={ing.unit}
                      onChange={(e) => updateIngredient(idx, 'unit', e.target.value)}
                      data-testid={`edit-unit-${idx}`}
                      aria-label={`Unit for ${ing.product_name}`}
                      className="w-24 px-2 py-1.5 border border-border-strong rounded text-sm bg-surface text-text focus:outline-none focus:ring-2 focus:ring-focus-ring shrink-0"
                    >
                      <option value="serving">Serving</option>
                      <option value="container">Container</option>
                      <option
                        value="gram"
                        disabled={!gramAvailable(ing.net_weight_g)}
                        title={!gramAvailable(ing.net_weight_g) ? 'Set net weight on the product first' : undefined}
                      >
                        g (gram)
                      </option>
                    </select>

                    {/* Note (optional, hidden on narrow viewports) */}
                    <input
                      value={ing.note}
                      placeholder="Note"
                      onChange={(e) => updateIngredient(idx, 'note', e.target.value)}
                      className="w-28 px-2 py-1.5 border border-border-strong rounded text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring shrink-0 hidden sm:block"
                      data-testid={`edit-note-${idx}`}
                      aria-label={`Note for ${ing.product_name}`}
                    />

                    {/* Remove */}
                    <button
                      type="button"
                      onClick={() => removeIngredient(idx)}
                      data-testid={`remove-ingredient-${idx}`}
                      aria-label={`Remove ${ing.product_name}`}
                      className="shrink-0 p-1.5 text-danger-text hover:text-red-700 hover:bg-danger-subtle rounded transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {ingredients.length === 0 && (
          <p data-testid="no-ingredients" className="text-text-tertiary italic">
            No ingredients added yet.
          </p>
        )}

        {/* Dynamic macro display — visual badges */}
        <div data-testid="macro-display" className="mt-4 p-4 bg-surface-sunken rounded-lg">
          {/* Per Serving (prominent) */}
          <div data-testid="per-serving-macros" className="mb-3">
            <div className="text-xs font-semibold text-text-tertiary uppercase tracking-wide mb-2">
              Per Serving ({baseServings})
            </div>
            <div className="flex gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-semibold bg-emerald-100 text-emerald-800">
                <span className="w-2 h-2 rounded-full bg-emerald-600" />
                {macros.calories} Cal
              </span>
              <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-semibold bg-green-100 text-green-800">
                <span className="w-2 h-2 rounded-full bg-green-600" />
                {macros.protein}g P
              </span>
              <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-semibold bg-amber-100 text-amber-800">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                {macros.carbs}g C
              </span>
              <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-semibold bg-red-100 text-red-800">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                {macros.fat}g F
              </span>
            </div>
          </div>

          {/* Total (smaller) */}
          <div data-testid="total-macros">
            <div className="text-xs font-semibold text-text-tertiary uppercase tracking-wide mb-1.5">Total Recipe</div>
            <div className="flex gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-border text-text-secondary">
                {totalMacros.calories} Cal
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-border text-text-secondary">
                {totalMacros.protein}g P
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-border text-text-secondary">
                {totalMacros.carbs}g C
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-border text-text-secondary">
                {totalMacros.fat}g F
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  ACTION BUTTONS                                               */}
      {/* ============================================================ */}
      {isViewMode ? (
        /* View mode (existing recipe): only Delete is available — Edit lives
            in the page header. Hide Save/Cancel since there is nothing to save. */
        <div className="flex gap-2 mt-4">
          <Link
            to="/chef/recipes"
            className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors no-underline"
          >
            Back to recipes
          </Link>
          {isEdit && (
            <button
              onClick={() => setShowDeleteAlert(true)}
              data-testid="delete-recipe-btn"
              className="px-4 py-2 bg-red-600 text-white rounded-md font-semibold text-sm hover:bg-red-700 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      ) : (
        <div className="flex gap-2 mt-4">
          <button
            onClick={handleSave}
            disabled={!name.trim() || ingredients.length === 0}
            data-testid="save-recipe-btn"
            className="px-6 py-3 bg-emerald-600 text-white rounded-md font-semibold text-[15px] hover:bg-emerald-700 transition-colors disabled:opacity-50"
          >
            {isEdit ? 'Save Changes' : 'Create Recipe'}
          </button>

          <button
            onClick={cancelEdit}
            data-testid="cancel-edit-btn"
            className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>

          {isEdit && (
            <button
              onClick={() => setShowDeleteAlert(true)}
              data-testid="delete-recipe-btn"
              className="px-4 py-2 bg-red-600 text-white rounded-md font-semibold text-sm hover:bg-red-700 transition-colors"
            >
              Delete
            </button>
          )}
        </div>
      )}

      {/* Delete confirmation */}
      {showDeleteAlert && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowDeleteAlert(false)}
        >
          <div
            className="bg-surface rounded-xl shadow-xl p-5 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="m-0 mb-3 text-lg font-bold text-text">Delete Recipe</h3>
            <p className="text-text-tertiary m-0 mb-5">
              Are you sure you want to delete this recipe? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeleteAlert(false)}
                className="px-4 py-2 bg-surface border border-border-strong text-text-secondary rounded-md text-sm hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate()}
                className="px-4 py-2 bg-red-600 text-white rounded-md font-semibold text-sm hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </ChefLayout>
  );
}
