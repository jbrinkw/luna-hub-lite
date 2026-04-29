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
}

interface LocalIngredient {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  note: string;
  visual_unit_label: string | null;
  visual_quantity: number | null;
  // Macro info for display
  calories_per_serving: number;
  carbs_per_serving: number;
  protein_per_serving: number;
  fat_per_serving: number;
  servings_per_container: number;
  net_weight_g: number | null;
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
  const [ingVisualLabel, setIngVisualLabel] = useState('');
  const [ingVisualQty, setIngVisualQty] = useState<string>('');

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
          '*, recipe_ingredients(ingredient_id, product_id, quantity, unit, note, visual_unit_label, visual_quantity, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container, net_weight_g))',
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

    setName(recipe.name ?? '');
    setDescription(recipe.description ?? '');
    setBaseServings(Number(recipe.base_servings) || 1);
    setActiveTime(recipe.active_time != null ? Number(recipe.active_time) : null);
    setTotalTime(recipe.total_time != null ? Number(recipe.total_time) : null);
    setInstructions(recipe.instructions ?? '');

    const ings: LocalIngredient[] = (recipe.recipe_ingredients ?? []).map((ri: any) => ({
      product_id: ri.product_id,
      product_name: ri.products?.name ?? 'Unknown',
      quantity: Number(ri.quantity),
      unit: ri.unit,
      note: ri.note ?? '',
      visual_unit_label: ri.visual_unit_label ?? null,
      visual_quantity: ri.visual_quantity != null ? Number(ri.visual_quantity) : null,
      calories_per_serving: Number(ri.products?.calories_per_serving ?? 0),
      carbs_per_serving: Number(ri.products?.carbs_per_serving ?? 0),
      protein_per_serving: Number(ri.products?.protein_per_serving ?? 0),
      fat_per_serving: Number(ri.products?.fat_per_serving ?? 0),
      servings_per_container: Number(ri.products?.servings_per_container ?? 1),
      net_weight_g: ri.products?.net_weight_g != null ? Number(ri.products.net_weight_g) : null,
    }));
    setIngredients(ings);
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
          'product_id, name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container, net_weight_g',
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
  };

  /* ---------------------------------------------------------------- */
  /*  Add ingredient                                                   */
  /* ---------------------------------------------------------------- */

  const addIngredient = () => {
    if (!selectedProduct || ingQuantity <= 0) return;

    // Resolve visual pair: both must be set, or both cleared
    const parsedVisualQty = ingVisualQty.trim() !== '' ? parseFloat(ingVisualQty) : null;
    const parsedVisualLabel = ingVisualLabel.trim() !== '' ? ingVisualLabel.trim() : null;
    const visualPairValid =
      (parsedVisualQty == null && parsedVisualLabel == null) ||
      (parsedVisualQty != null && !isNaN(parsedVisualQty) && parsedVisualQty > 0 && parsedVisualLabel != null);

    if (!visualPairValid) return; // guard: UI already shows inline error

    const newIng: LocalIngredient = {
      product_id: selectedProduct.product_id,
      product_name: selectedProduct.name,
      quantity: ingQuantity,
      unit: ingUnit,
      note: ingNote,
      visual_unit_label: parsedVisualLabel,
      visual_quantity: parsedVisualQty,
      calories_per_serving: Number(selectedProduct.calories_per_serving),
      carbs_per_serving: Number(selectedProduct.carbs_per_serving),
      protein_per_serving: Number(selectedProduct.protein_per_serving),
      fat_per_serving: Number(selectedProduct.fat_per_serving),
      servings_per_container: Number(selectedProduct.servings_per_container),
      net_weight_g: selectedProduct.net_weight_g != null ? Number(selectedProduct.net_weight_g) : null,
    };

    setIngredients((prev) => [...prev, newIng]);
    setSearchText('');
    setSelectedProduct(null);
    setIngQuantity(1);
    setIngUnit('serving');
    setIngNote('');
    setIngVisualLabel('');
    setIngVisualQty('');
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
              visual_unit_label: ing.visual_unit_label || null,
              visual_quantity: ing.visual_quantity ?? null,
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
              visual_unit_label: ing.visual_unit_label || null,
              visual_quantity: ing.visual_quantity ?? null,
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
      navigate('/chef/recipes');
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
    'w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary';
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

  return (
    <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
      <div className="mb-6">
        <Link to="/chef/recipes" className="text-sm font-medium text-emerald-600 hover:text-emerald-700 no-underline">
          &larr; Recipes
        </Link>
        <h1 className="mt-2 mb-0 text-2xl font-bold text-text">{isEdit ? 'Edit Recipe' : 'New Recipe'}</h1>
      </div>

      {saveError && (
        <p className="text-danger-text bg-danger-subtle px-3.5 py-2.5 rounded-md border border-danger">{saveError}</p>
      )}

      {/* ============================================================ */}
      {/*  RECIPE FIELDS                                                */}
      {/* ============================================================ */}
      <div data-testid="recipe-fields" className="bg-surface border border-border rounded-lg p-5 mb-4">
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
      </div>

      {/* ============================================================ */}
      {/*  INGREDIENTS SECTION                                          */}
      {/* ============================================================ */}
      <div data-testid="ingredients-section" className="bg-surface border border-border rounded-lg p-5 mb-4">
        <h3 className="m-0 mb-4 text-lg font-bold text-text">Ingredients</h3>

        {/* Add ingredient form — stacks vertically on mobile */}
        <div
          data-testid="add-ingredient-form"
          className="flex flex-col md:flex-row gap-2 md:flex-wrap md:items-end mb-4"
        >
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
          <div className="flex gap-2">
            <div className="flex-1 md:w-20 md:flex-none">
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
            <div className="flex-1 md:w-[120px] md:flex-none">
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
              {ingUnit === 'gram' && selectedProduct && !gramAvailable(selectedProduct.net_weight_g) && (
                <p className="mt-1 text-xs text-danger-text" data-testid="gram-unit-missing-weight-error">
                  This product has no net weight. Set net_weight_g on the product to use gram unit.
                </p>
              )}
            </div>
          </div>
          <div className="md:w-[120px]">
            <label className={labelCls}>Note</label>
            <input
              value={ingNote}
              onChange={(e) => setIngNote(e.target.value)}
              data-testid="ingredient-note"
              placeholder="Optional"
              className={inputCls}
            />
          </div>
          <button
            onClick={addIngredient}
            disabled={!selectedProduct}
            data-testid="add-ingredient-btn"
            className="px-4 py-2.5 bg-emerald-600 text-white rounded-md font-semibold text-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 md:self-end"
          >
            Add
          </button>
        </div>

        {/* Visual unit override (new-ingredient, optional) */}
        {selectedProduct && (
          <div
            data-testid="visual-override-section"
            className="mb-4 p-3 bg-surface-sunken rounded-lg border border-border-light"
          >
            <p className="m-0 mb-2 text-xs font-semibold text-text-secondary uppercase tracking-wide">
              Display override (optional)
            </p>
            <p className="m-0 mb-2 text-xs text-text-tertiary">
              Optional — shows as &ldquo;1 slice&rdquo; instead of &ldquo;30g&rdquo;. Math always uses the canonical
              amount.
            </p>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="w-24">
                <label className="block text-[11px] text-text-tertiary mb-0.5">Display qty</label>
                <input
                  type="number"
                  min="0.001"
                  step="any"
                  value={ingVisualQty}
                  onChange={(e) => setIngVisualQty(e.target.value)}
                  data-testid="ing-visual-qty"
                  placeholder="e.g. 1"
                  className="w-full px-2 py-1.5 border border-border-strong rounded text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
                />
              </div>
              <div className="flex-1 min-w-[100px]">
                <label className="block text-[11px] text-text-tertiary mb-0.5">Display label</label>
                <input
                  type="text"
                  value={ingVisualLabel}
                  onChange={(e) => setIngVisualLabel(e.target.value)}
                  data-testid="ing-visual-label"
                  placeholder="e.g. slice, scoop, tbsp"
                  className="w-full px-2 py-1.5 border border-border-strong rounded text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
                />
              </div>
            </div>
            {/* Pair validation */}
            {(() => {
              const hasLabel = ingVisualLabel.trim() !== '';
              const hasQty = ingVisualQty.trim() !== '' && parseFloat(ingVisualQty) > 0;
              const partialSet = hasLabel !== hasQty;
              return partialSet ? (
                <p className="mt-1.5 text-xs text-amber-600" data-testid="visual-pair-error">
                  Set both or neither — display qty and label must be paired.
                </p>
              ) : null;
            })()}
            {/* Live preview */}
            {selectedProduct &&
              (ingVisualLabel.trim() || ingVisualQty.trim()) &&
              (() => {
                const vQty = parseFloat(ingVisualQty) || null;
                const vLabel = ingVisualLabel.trim() || null;
                const preview = formatIngredientDisplay({
                  quantity: ingQuantity,
                  unit: ingUnit as 'container' | 'serving' | 'gram',
                  visual_quantity: vQty,
                  visual_unit_label: vLabel,
                  productName: selectedProduct.name,
                });
                return (
                  <p className="mt-1.5 text-xs text-text-secondary italic" data-testid="visual-preview">
                    Preview: {preview}
                  </p>
                );
              })()}
          </div>
        )}

        {/* Ingredient cards */}
        {ingredients.length > 0 && (
          <div className="space-y-2 mb-3" data-testid="ingredients-table">
            {ingredients.map((ing, idx) => (
              <div
                key={`${ing.product_id}-${idx}`}
                data-testid={`ingredient-row-${idx}`}
                className="bg-surface border border-border rounded-lg p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm text-text">{ing.product_name}</span>
                  <button
                    onClick={() => removeIngredient(idx)}
                    data-testid={`remove-ingredient-${idx}`}
                    className="bg-transparent border-none text-danger-text cursor-pointer font-semibold text-xs px-2 py-1 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="w-20">
                    <label className="block text-[11px] text-text-tertiary mb-0.5">Qty</label>
                    <input
                      type="number"
                      min="0"
                      value={ing.quantity}
                      onChange={(e) => updateIngredient(idx, 'quantity', Number(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 border border-border-strong rounded text-sm text-right focus:outline-none focus:ring-2 focus:ring-focus-ring"
                      data-testid={`edit-qty-${idx}`}
                    />
                  </div>
                  <div className="w-[110px]">
                    <label className="block text-[11px] text-text-tertiary mb-0.5">Unit</label>
                    <select
                      value={ing.unit}
                      onChange={(e) => updateIngredient(idx, 'unit', e.target.value)}
                      data-testid={`edit-unit-${idx}`}
                      className="w-full px-2 py-1.5 border border-border-strong rounded text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
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
                    {ing.unit === 'gram' && !gramAvailable(ing.net_weight_g) && (
                      <p
                        className="mt-0.5 text-[10px] text-danger-text leading-tight"
                        data-testid={`gram-unit-missing-weight-error-${idx}`}
                      >
                        Set net weight on product first
                      </p>
                    )}
                  </div>
                  <div className="flex-1 min-w-[100px]">
                    <label className="block text-[11px] text-text-tertiary mb-0.5">Note</label>
                    <input
                      value={ing.note}
                      placeholder={'—'}
                      onChange={(e) => updateIngredient(idx, 'note', e.target.value)}
                      className="w-full px-2 py-1.5 border border-border-strong rounded text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
                      data-testid={`edit-note-${idx}`}
                    />
                  </div>
                </div>
                {/* Visual display override — per existing ingredient */}
                <div className="mt-2 pt-2 border-t border-border-light">
                  <p className="mb-1 text-[10px] text-text-tertiary font-semibold uppercase tracking-wide">
                    Display override (optional)
                  </p>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div className="w-20">
                      <label className="block text-[11px] text-text-tertiary mb-0.5">Display qty</label>
                      <input
                        type="number"
                        min="0.001"
                        step="any"
                        value={ing.visual_quantity ?? ''}
                        onChange={(e) => {
                          const val = e.target.value === '' ? null : parseFloat(e.target.value);
                          updateIngredient(idx, 'visual_quantity', val as any);
                        }}
                        placeholder="—"
                        className="w-full px-2 py-1.5 border border-border-strong rounded text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
                        data-testid={`edit-visual-qty-${idx}`}
                      />
                    </div>
                    <div className="flex-1 min-w-[100px]">
                      <label className="block text-[11px] text-text-tertiary mb-0.5">Display label</label>
                      <input
                        type="text"
                        value={ing.visual_unit_label ?? ''}
                        onChange={(e) => updateIngredient(idx, 'visual_unit_label', e.target.value || (null as any))}
                        placeholder="slice, scoop, tbsp…"
                        className="w-full px-2 py-1.5 border border-border-strong rounded text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring"
                        data-testid={`edit-visual-label-${idx}`}
                      />
                    </div>
                  </div>
                  {/* Pair validation */}
                  {(() => {
                    const hasLabel = !!ing.visual_unit_label;
                    const hasQty = ing.visual_quantity != null && ing.visual_quantity > 0;
                    return hasLabel !== hasQty ? (
                      <p className="mt-1 text-[10px] text-amber-600" data-testid={`visual-pair-error-${idx}`}>
                        Set both or neither.
                      </p>
                    ) : null;
                  })()}
                  {/* Live preview */}
                  <p className="mt-1 text-[10px] text-text-tertiary italic" data-testid={`visual-preview-${idx}`}>
                    {formatIngredientDisplay({
                      quantity: ing.quantity,
                      unit: ing.unit as 'container' | 'serving' | 'gram',
                      visual_quantity: ing.visual_quantity,
                      visual_unit_label: ing.visual_unit_label,
                      productName: ing.product_name,
                    })}
                  </p>
                </div>
              </div>
            ))}
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
      <div className="flex gap-2 mt-4">
        <button
          onClick={handleSave}
          disabled={!name.trim() || ingredients.length === 0}
          data-testid="save-recipe-btn"
          className="px-6 py-3 bg-emerald-600 text-white rounded-md font-semibold text-[15px] hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          {isEdit ? 'Update Recipe' : 'Create Recipe'}
        </button>

        <button
          onClick={() => navigate('/chef/recipes')}
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
