import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, escapeIlike } from '@/shared/supabase';
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

/* ------------------------------------------------------------------ */
/*  Shared input styling                                               */
/* ------------------------------------------------------------------ */

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '14px',
  boxSizing: 'border-box',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: '60px',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '4px',
  fontWeight: 600,
  fontSize: '14px',
  color: '#374151',
};

/* ================================================================== */
/*  RecipeFormPage                                                      */
/* ================================================================== */

export function RecipeFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const isEdit = !!id;

  const [loading, setLoading] = useState(isEdit);

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

  /* ---------------------------------------------------------------- */
  /*  Load existing recipe (edit mode)                                 */
  /* ---------------------------------------------------------------- */

  const userId = user?.id;

  const loadRecipe = useCallback(async () => {
    if (!userId || !id) return;

    const { data: recipe } = await chefbyte()
      .from('recipes')
      .select(
        '*, recipe_ingredients(*, products:product_id(name, calories_per_serving, carbs_per_serving, protein_per_serving, fat_per_serving, servings_per_container))',
      )
      .eq('recipe_id', id)
      .eq('user_id', userId)
      .single();

    if (recipe) {
      setName(recipe.name ?? '');
      setDescription(recipe.description ?? '');
      setBaseServings(Number(recipe.base_servings) || 1);
      setActiveTime(recipe.active_time != null ? Number(recipe.active_time) : null);
      setTotalTime(recipe.total_time != null ? Number(recipe.total_time) : null);
      setInstructions(recipe.instructions ?? '');

      // Map ingredients
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
    }

    setLoading(false);
  }, [userId, id]);

  useEffect(() => {
    if (isEdit) {
      // Async data fetching with setState is the standard pattern for this use case
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadRecipe();
    }
  }, [isEdit, loadRecipe]);

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
  /*  Save                                                             */
  /* ---------------------------------------------------------------- */

  const handleSave = async () => {
    if (!user || !name.trim()) return;
    if (ingredients.length === 0) {
      setSaveError('At least one ingredient is required.');
      return;
    }
    setSaveError(null);

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

      if (updateErr) {
        setSaveError(updateErr.message);
        return;
      }

      // Atomic ingredient save via RPC (delete old + insert new in one transaction)
      if (ingredients.length === 0) {
        // Zero ingredients: just delete existing
        const { error: delErr } = await chefbyte()
          .from('recipe_ingredients')
          .delete()
          .eq('recipe_id', id)
          .eq('user_id', user.id);
        if (delErr) {
          setSaveError(delErr.message);
          return;
        }
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
        if (ingErr) {
          setSaveError(ingErr.message);
          return;
        }
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

      if (createErr || !newRecipe) {
        setSaveError(createErr?.message ?? 'Failed to create recipe');
        return;
      }

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
        if (ingErr) {
          setSaveError(ingErr.message);
          return;
        }
      }
    }

    navigate('/chef/recipes');
  };

  /* ---------------------------------------------------------------- */
  /*  Delete (edit mode only)                                          */
  /* ---------------------------------------------------------------- */

  const handleDelete = async () => {
    if (!id || !user) return;
    setSaveError(null);
    const { error: ingErr } = await chefbyte()
      .from('recipe_ingredients')
      .delete()
      .eq('recipe_id', id)
      .eq('user_id', user.id);
    if (ingErr) {
      setSaveError(ingErr.message);
      return;
    }
    const { error: recErr } = await chefbyte().from('recipes').delete().eq('recipe_id', id).eq('user_id', user.id);
    if (recErr) {
      setSaveError(recErr.message);
      return;
    }
    navigate('/chef/recipes');
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
        <div data-testid="recipe-form-loading" style={{ padding: '20px', color: '#666' }}>
          Loading...
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 700, color: '#1a1a2e' }}>
          {isEdit ? 'Edit Recipe' : 'New Recipe'}
        </h1>
      </div>

      {saveError && (
        <p
          style={{
            color: '#d33',
            background: '#fef2f2',
            padding: '10px 14px',
            borderRadius: '6px',
            border: '1px solid #fecaca',
          }}
        >
          {saveError}
        </p>
      )}

      {/* ============================================================ */}
      {/*  RECIPE FIELDS                                                */}
      {/* ============================================================ */}
      <div data-testid="recipe-fields" className="card" style={{ padding: '20px', marginBottom: '16px' }}>
        <div className="formGrid">
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="recipe-name"
              required
              placeholder="Recipe name"
              style={inputStyle}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="recipe-description"
              placeholder="Brief description"
              style={textareaStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Base Servings</label>
            <input
              type="number"
              min="0"
              value={baseServings}
              onChange={(e) => setBaseServings(Number(e.target.value) || 1)}
              data-testid="recipe-base-servings"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Active Time (min)</label>
            <input
              type="number"
              min="0"
              value={activeTime ?? ''}
              onChange={(e) => setActiveTime(e.target.value ? Number(e.target.value) : null)}
              data-testid="recipe-active-time"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Total Time (min)</label>
            <input
              type="number"
              min="0"
              value={totalTime ?? ''}
              onChange={(e) => setTotalTime(e.target.value ? Number(e.target.value) : null)}
              data-testid="recipe-total-time"
              style={inputStyle}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Instructions</label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              data-testid="recipe-instructions"
              placeholder="Step-by-step instructions"
              style={{ ...textareaStyle, minHeight: '100px' }}
            />
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  INGREDIENTS SECTION                                          */}
      {/* ============================================================ */}
      <div data-testid="ingredients-section" className="card" style={{ padding: '20px', marginBottom: '16px' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 700, color: '#1a1a2e' }}>Ingredients</h3>

        {/* Add ingredient form */}
        <div
          data-testid="add-ingredient-form"
          style={{
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            marginBottom: '16px',
          }}
        >
          <div style={{ flex: 1, minWidth: '150px', position: 'relative' }}>
            <label style={labelStyle}>Product</label>
            <input
              value={searchText}
              onChange={(e) => handleSearchInput(e.target.value)}
              data-testid="ingredient-product-search"
              placeholder="Search products..."
              style={inputStyle}
            />
            {showDropdown && (
              <div
                data-testid="ingredient-product-dropdown"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  background: '#fff',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  zIndex: 10,
                  maxHeight: '200px',
                  overflow: 'auto',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                }}
              >
                {searchResults.map((p) => (
                  <div
                    key={p.product_id}
                    onClick={() => selectProduct(p)}
                    data-testid={`ing-dropdown-item-${p.product_id}`}
                    style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f0f0f0' }}
                    onMouseOver={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = '#f5f5f5';
                    }}
                    onMouseOut={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = '#fff';
                    }}
                  >
                    {p.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ width: '80px' }}>
            <label style={labelStyle}>Qty</label>
            <input
              type="number"
              min="0"
              value={ingQuantity}
              onChange={(e) => setIngQuantity(Number(e.target.value) || 1)}
              data-testid="ingredient-qty"
              style={inputStyle}
            />
          </div>
          <div style={{ width: '120px' }}>
            <label style={labelStyle}>Unit</label>
            <select
              value={ingUnit}
              onChange={(e) => setIngUnit(e.target.value)}
              data-testid="ingredient-unit"
              style={inputStyle}
            >
              <option value="serving">Serving</option>
              <option value="container">Container</option>
            </select>
          </div>
          <div style={{ width: '120px' }}>
            <label style={labelStyle}>Note</label>
            <input
              value={ingNote}
              onChange={(e) => setIngNote(e.target.value)}
              data-testid="ingredient-note"
              placeholder="Optional"
              style={inputStyle}
            />
          </div>
          <button
            className="primary-btn"
            onClick={addIngredient}
            disabled={!selectedProduct}
            data-testid="add-ingredient-btn"
            style={{ background: '#1e66f5', alignSelf: 'flex-end' }}
          >
            Add
          </button>
        </div>

        {/* Ingredients table */}
        {ingredients.length > 0 && (
          <div className="table-responsive">
            <table
              style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px' }}
              data-testid="ingredients-table"
            >
              <thead>
                <tr style={{ background: '#f7f7f9', borderBottom: '2px solid #ddd' }}>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#555',
                    }}
                  >
                    Product
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '10px 12px',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#555',
                    }}
                  >
                    Qty
                  </th>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#555',
                    }}
                  >
                    Unit
                  </th>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#555',
                    }}
                  >
                    Note
                  </th>
                  <th style={{ padding: '10px 12px', width: '80px' }}></th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map((ing, idx) => (
                  <tr
                    key={`${ing.product_id}-${idx}`}
                    data-testid={`ingredient-row-${idx}`}
                    style={{ borderBottom: '1px solid #eee' }}
                  >
                    <td style={{ padding: '8px 12px', fontWeight: 500 }}>{ing.product_name}</td>
                    <td style={{ textAlign: 'right', padding: '4px 8px' }}>
                      <input
                        type="number"
                        min="0"
                        value={ing.quantity}
                        onChange={(e) => updateIngredient(idx, 'quantity', Number(e.target.value) || 0)}
                        style={{ ...inputStyle, width: '70px', textAlign: 'right', padding: '6px 8px' }}
                        data-testid={`edit-qty-${idx}`}
                      />
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <select
                        value={ing.unit}
                        onChange={(e) => updateIngredient(idx, 'unit', e.target.value)}
                        data-testid={`edit-unit-${idx}`}
                        style={{ ...inputStyle, width: '110px', padding: '6px 8px' }}
                      >
                        <option value="serving">Serving</option>
                        <option value="container">Container</option>
                      </select>
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      <input
                        value={ing.note}
                        placeholder={'\u2014'}
                        onChange={(e) => updateIngredient(idx, 'note', e.target.value)}
                        style={{ ...inputStyle, padding: '6px 8px' }}
                        data-testid={`edit-note-${idx}`}
                      />
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <button
                        onClick={() => removeIngredient(idx)}
                        data-testid={`remove-ingredient-${idx}`}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#d33',
                          cursor: 'pointer',
                          fontWeight: 600,
                          fontSize: '13px',
                          padding: '4px 8px',
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {ingredients.length === 0 && (
          <p data-testid="no-ingredients" style={{ color: '#888', fontStyle: 'italic' }}>
            No ingredients added yet.
          </p>
        )}

        {/* Dynamic macro display */}
        <div
          data-testid="macro-display"
          style={{ marginTop: '16px', padding: '12px', background: '#f7f7f9', borderRadius: '8px' }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.9em' }}>
            <div data-testid="total-macros">
              <strong>Total:</strong> {totalMacros.calories} cal | {totalMacros.protein}g P | {totalMacros.carbs}g C |{' '}
              {totalMacros.fat}g F
            </div>
            <div data-testid="per-serving-macros">
              <strong>Per Serving ({baseServings}):</strong> {macros.calories} cal | {macros.protein}g P |{' '}
              {macros.carbs}g C | {macros.fat}g F
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  ACTION BUTTONS                                               */}
      {/* ============================================================ */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <button
          className="primary-btn"
          onClick={handleSave}
          disabled={!name.trim() || ingredients.length === 0}
          data-testid="save-recipe-btn"
          style={{ flex: 1, background: '#2f9e44', padding: '12px 16px', fontSize: '15px' }}
        >
          {isEdit ? 'Update Recipe' : 'Create Recipe'}
        </button>

        <button
          className="primary-btn"
          onClick={() => navigate('/chef/recipes')}
          style={{ background: '#fff', border: '1px solid #ddd', color: '#4b5563' }}
        >
          Cancel
        </button>

        {isEdit && (
          <button
            className="primary-btn"
            onClick={() => setShowDeleteAlert(true)}
            data-testid="delete-recipe-btn"
            style={{ background: '#d33' }}
          >
            Delete
          </button>
        )}
      </div>

      {/* Delete confirmation */}
      {showDeleteAlert && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowDeleteAlert(false)}
        >
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px', fontSize: '18px', fontWeight: 700 }}>Delete Recipe</h3>
            <p style={{ color: '#666', margin: '0 0 20px' }}>
              Are you sure you want to delete this recipe? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                className="primary-btn"
                onClick={() => setShowDeleteAlert(false)}
                style={{ background: '#fff', border: '1px solid #ddd', color: '#4b5563' }}
              >
                Cancel
              </button>
              <button className="primary-btn" onClick={handleDelete} style={{ background: '#d33' }}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </ChefLayout>
  );
}
