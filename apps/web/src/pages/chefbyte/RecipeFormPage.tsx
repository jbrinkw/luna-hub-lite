import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { CardSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, escapeIlike } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { computeRecipeMacros } from './RecipesPage';

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
          '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
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
      calories_per_serving: Number(ri.products?.calories_per_serving ?? 0),
      carbs_per_serving: Number(ri.products?.carbs_per_serving ?? 0),
      protein_per_serving: Number(ri.products?.protein_per_serving ?? 0),
      fat_per_serving: Number(ri.products?.fat_per_serving ?? 0),
      servings_per_container: Number(ri.products?.servings_per_container ?? 1),
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
      const { data } = await chefbyte()
        .from('products')
        .select(
          'product_id, name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container',
        )
        .eq('user_id', user.id)
        .ilike('name', `%${escapeIlike(text)}%`)
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
    'w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500';
  const labelCls = 'block mb-1 font-semibold text-sm text-slate-700';

  if (loading) {
    return (
      <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
        <div data-testid="recipe-form-loading" className="p-5">
          <CardSkeleton />
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
      <div className="mb-6">
        <Link to="/chef/recipes" className="text-sm font-medium text-emerald-600 hover:text-emerald-700 no-underline">
          &larr; Recipes
        </Link>
        <h1 className="mt-2 mb-0 text-2xl font-bold text-slate-900">{isEdit ? 'Edit Recipe' : 'New Recipe'}</h1>
      </div>

      {saveError && (
        <p className="text-red-600 bg-red-50 px-3.5 py-2.5 rounded-md border border-red-200">{saveError}</p>
      )}

      {/* ============================================================ */}
      {/*  RECIPE FIELDS                                                */}
      {/* ============================================================ */}
      <div data-testid="recipe-fields" className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
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
      <div data-testid="ingredients-section" className="bg-white border border-slate-200 rounded-lg p-5 mb-4">
        <h3 className="m-0 mb-4 text-lg font-bold text-slate-900">Ingredients</h3>

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
                className="absolute top-full left-0 right-0 bg-white border border-slate-300 rounded shadow-lg z-10 max-h-[200px] overflow-auto"
              >
                {searchResults.map((p) => (
                  <div
                    key={p.product_id}
                    onClick={() => selectProduct(p)}
                    data-testid={`ing-dropdown-item-${p.product_id}`}
                    className="px-3 py-2 cursor-pointer border-b border-slate-100 hover:bg-slate-50 text-sm"
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
              </select>
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

        {/* Ingredient cards */}
        {ingredients.length > 0 && (
          <div className="space-y-2 mb-3" data-testid="ingredients-table">
            {ingredients.map((ing, idx) => (
              <div
                key={`${ing.product_id}-${idx}`}
                data-testid={`ingredient-row-${idx}`}
                className="bg-white border border-slate-200 rounded-lg p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm text-slate-900">{ing.product_name}</span>
                  <button
                    onClick={() => removeIngredient(idx)}
                    data-testid={`remove-ingredient-${idx}`}
                    className="bg-transparent border-none text-red-600 cursor-pointer font-semibold text-xs px-2 py-1 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="w-20">
                    <label className="block text-[11px] text-slate-500 mb-0.5">Qty</label>
                    <input
                      type="number"
                      min="0"
                      value={ing.quantity}
                      onChange={(e) => updateIngredient(idx, 'quantity', Number(e.target.value) || 0)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm text-right focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                      data-testid={`edit-qty-${idx}`}
                    />
                  </div>
                  <div className="w-[110px]">
                    <label className="block text-[11px] text-slate-500 mb-0.5">Unit</label>
                    <select
                      value={ing.unit}
                      onChange={(e) => updateIngredient(idx, 'unit', e.target.value)}
                      data-testid={`edit-unit-${idx}`}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    >
                      <option value="serving">Serving</option>
                      <option value="container">Container</option>
                    </select>
                  </div>
                  <div className="flex-1 min-w-[100px]">
                    <label className="block text-[11px] text-slate-500 mb-0.5">Note</label>
                    <input
                      value={ing.note}
                      placeholder={'\u2014'}
                      onChange={(e) => updateIngredient(idx, 'note', e.target.value)}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                      data-testid={`edit-note-${idx}`}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {ingredients.length === 0 && (
          <p data-testid="no-ingredients" className="text-slate-400 italic">
            No ingredients added yet.
          </p>
        )}

        {/* Dynamic macro display — visual badges */}
        <div data-testid="macro-display" className="mt-4 p-4 bg-slate-50 rounded-lg">
          {/* Per Serving (prominent) */}
          <div data-testid="per-serving-macros" className="mb-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
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
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Total Recipe</div>
            <div className="flex gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-200 text-slate-700">
                {totalMacros.calories} Cal
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-200 text-slate-700">
                {totalMacros.protein}g P
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-200 text-slate-700">
                {totalMacros.carbs}g C
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-200 text-slate-700">
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
          className="px-4 py-2 bg-white border border-slate-300 text-slate-600 rounded-md text-sm hover:bg-slate-50 transition-colors"
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
          <div className="bg-white rounded-xl shadow-xl p-5 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="m-0 mb-3 text-lg font-bold text-slate-900">Delete Recipe</h3>
            <p className="text-slate-500 m-0 mb-5">
              Are you sure you want to delete this recipe? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeleteAlert(false)}
                className="px-4 py-2 bg-white border border-slate-300 text-slate-600 rounded-md text-sm hover:bg-slate-50 transition-colors"
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
