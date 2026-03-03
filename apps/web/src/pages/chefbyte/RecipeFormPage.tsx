import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonButton,
  IonInput,
  IonTextarea,
  IonSelect,
  IonSelectOption,
  IonAlert,
} from '@ionic/react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';
import { computeRecipeMacros } from './RecipesPage';

// Cast needed: chefbyte schema types not yet generated
const chefbyte = () => supabase.schema('chefbyte') as any;

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
      loadRecipe();
    }
  }, [isEdit, loadRecipe]);

  /* ---------------------------------------------------------------- */
  /*  Product search                                                   */
  /* ---------------------------------------------------------------- */

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
        .order('name');

      const filtered = ((data ?? []) as ProductSearchResult[]).filter(p =>
        p.name.toLowerCase().includes(text.toLowerCase()),
      );
      setSearchResults(filtered);
      setShowDropdown(filtered.length > 0);
    },
    [user],
  );

  const handleSearchInput = (value: string) => {
    setSearchText(value);
    setSelectedProduct(null);
    searchProducts(value);
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

    setIngredients(prev => [...prev, newIng]);
    setSearchText('');
    setSelectedProduct(null);
    setIngQuantity(1);
    setIngUnit('serving');
    setIngNote('');
  };

  const removeIngredient = (index: number) => {
    setIngredients(prev => prev.filter((_, i) => i !== index));
  };

  /* ---------------------------------------------------------------- */
  /*  Macro display                                                    */
  /* ---------------------------------------------------------------- */

  const macros = useMemo(() => {
    const mapped = ingredients.map(ing => ({
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
    const mapped = ingredients.map(ing => ({
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

    if (isEdit && id) {
      // Update recipe
      await chefbyte()
        .from('recipes')
        .update({
          name: name.trim(),
          description: description || null,
          base_servings: baseServings,
          active_time: activeTime,
          total_time: totalTime,
          instructions: instructions || null,
        })
        .eq('recipe_id', id);

      // Delete old ingredients, insert new
      await chefbyte().from('recipe_ingredients').delete().eq('recipe_id', id);

      for (const ing of ingredients) {
        await chefbyte().from('recipe_ingredients').insert({
          user_id: user.id,
          recipe_id: id,
          product_id: ing.product_id,
          quantity: ing.quantity,
          unit: ing.unit,
          note: ing.note || null,
        });
      }
    } else {
      // Create recipe
      const { data: newRecipe } = await chefbyte()
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

      if (newRecipe) {
        for (const ing of ingredients) {
          await chefbyte().from('recipe_ingredients').insert({
            user_id: user.id,
            recipe_id: newRecipe.recipe_id,
            product_id: ing.product_id,
            quantity: ing.quantity,
            unit: ing.unit,
            note: ing.note || null,
          });
        }
      }
    }

    navigate('/chef/recipes');
  };

  /* ---------------------------------------------------------------- */
  /*  Delete (edit mode only)                                          */
  /* ---------------------------------------------------------------- */

  const handleDelete = async () => {
    if (!id) return;
    await chefbyte().from('recipe_ingredients').delete().eq('recipe_id', id);
    await chefbyte().from('recipes').delete().eq('recipe_id', id);
    navigate('/chef/recipes');
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
        <IonSpinner data-testid="recipe-form-loading" />
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title={isEdit ? 'Edit Recipe' : 'New Recipe'}>
      <h2>{isEdit ? 'EDIT RECIPE' : 'NEW RECIPE'}</h2>

      {/* ============================================================ */}
      {/*  RECIPE FIELDS                                                */}
      {/* ============================================================ */}
      <IonCard data-testid="recipe-fields">
        <IonCardContent>
          <div style={{ display: 'grid', gap: '8px' }}>
            <IonInput
              label="Name"
              value={name}
              onIonInput={e => setName(e.detail.value ?? '')}
              data-testid="recipe-name"
              required
            />
            <IonTextarea
              label="Description"
              value={description}
              onIonInput={e => setDescription(e.detail.value ?? '')}
              data-testid="recipe-description"
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              <IonInput
                label="Base Servings"
                type="number"
                value={baseServings}
                onIonInput={e => setBaseServings(Number(e.detail.value) || 1)}
                data-testid="recipe-base-servings"
              />
              <IonInput
                label="Active Time (min)"
                type="number"
                value={activeTime ?? ''}
                onIonInput={e =>
                  setActiveTime(e.detail.value ? Number(e.detail.value) : null)
                }
                data-testid="recipe-active-time"
              />
              <IonInput
                label="Total Time (min)"
                type="number"
                value={totalTime ?? ''}
                onIonInput={e =>
                  setTotalTime(e.detail.value ? Number(e.detail.value) : null)
                }
                data-testid="recipe-total-time"
              />
            </div>
            <IonTextarea
              label="Instructions"
              value={instructions}
              onIonInput={e => setInstructions(e.detail.value ?? '')}
              data-testid="recipe-instructions"
            />
          </div>
        </IonCardContent>
      </IonCard>

      {/* ============================================================ */}
      {/*  INGREDIENTS SECTION                                          */}
      {/* ============================================================ */}
      <IonCard data-testid="ingredients-section">
        <IonCardHeader>
          <IonCardTitle>Ingredients</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          {/* Add ingredient form */}
          <div
            data-testid="add-ingredient-form"
            style={{
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              marginBottom: '12px',
            }}
          >
            <div style={{ flex: 1, minWidth: '150px', position: 'relative' }}>
              <IonInput
                label="Product"
                value={searchText}
                onIonInput={e => handleSearchInput(e.detail.value ?? '')}
                data-testid="ingredient-product-search"
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
                  }}
                >
                  {searchResults.map(p => (
                    <div
                      key={p.product_id}
                      onClick={() => selectProduct(p)}
                      data-testid={`ing-dropdown-item-${p.product_id}`}
                      style={{ padding: '8px 12px', cursor: 'pointer' }}
                    >
                      {p.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ width: '80px' }}>
              <IonInput
                label="Qty"
                type="number"
                value={ingQuantity}
                onIonInput={e => setIngQuantity(Number(e.detail.value) || 1)}
                data-testid="ingredient-qty"
              />
            </div>
            <div style={{ width: '120px' }}>
              <IonSelect
                label="Unit"
                value={ingUnit}
                onIonChange={e => setIngUnit(e.detail.value ?? 'serving')}
                data-testid="ingredient-unit"
              >
                <IonSelectOption value="serving">Serving</IonSelectOption>
                <IonSelectOption value="container">Container</IonSelectOption>
              </IonSelect>
            </div>
            <div style={{ width: '120px' }}>
              <IonInput
                label="Note"
                value={ingNote}
                onIonInput={e => setIngNote(e.detail.value ?? '')}
                data-testid="ingredient-note"
              />
            </div>
            <IonButton
              size="small"
              onClick={addIngredient}
              disabled={!selectedProduct}
              data-testid="add-ingredient-btn"
            >
              Add
            </IonButton>
          </div>

          {/* Ingredients table */}
          {ingredients.length > 0 && (
            <table
              style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px' }}
              data-testid="ingredients-table"
            >
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Product</th>
                  <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>Qty</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Unit</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Note</th>
                  <th style={{ padding: '8px', borderBottom: '1px solid #ddd' }}></th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map((ing, idx) => (
                  <tr key={`${ing.product_id}-${idx}`} data-testid={`ingredient-row-${idx}`}>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{ing.product_name}</td>
                    <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>{ing.quantity}</td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{ing.unit}</td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{ing.note || '\u2014'}</td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                      <IonButton
                        size="small"
                        color="danger"
                        fill="clear"
                        onClick={() => removeIngredient(idx)}
                        data-testid={`remove-ingredient-${idx}`}
                      >
                        Remove
                      </IonButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {ingredients.length === 0 && (
            <p data-testid="no-ingredients" style={{ color: '#888' }}>
              No ingredients added yet.
            </p>
          )}

          {/* Dynamic macro display */}
          <div data-testid="macro-display" style={{ marginTop: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.9em' }}>
              <div data-testid="total-macros">
                <strong>Total:</strong>{' '}
                {totalMacros.calories} cal | {totalMacros.protein}g P | {totalMacros.carbs}g C | {totalMacros.fat}g F
              </div>
              <div data-testid="per-serving-macros">
                <strong>Per Serving ({baseServings}):</strong>{' '}
                {macros.calories} cal | {macros.protein}g P | {macros.carbs}g C | {macros.fat}g F
              </div>
            </div>
          </div>
        </IonCardContent>
      </IonCard>

      {/* ============================================================ */}
      {/*  ACTION BUTTONS                                               */}
      {/* ============================================================ */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
        <IonButton
          expand="block"
          onClick={handleSave}
          disabled={!name.trim()}
          data-testid="save-recipe-btn"
          style={{ flex: 1 }}
        >
          {isEdit ? 'Update Recipe' : 'Create Recipe'}
        </IonButton>

        {isEdit && (
          <IonButton
            color="danger"
            fill="outline"
            onClick={() => setShowDeleteAlert(true)}
            data-testid="delete-recipe-btn"
          >
            Delete
          </IonButton>
        )}
      </div>

      {/* Delete confirmation */}
      <IonAlert
        isOpen={showDeleteAlert}
        header="Delete Recipe"
        message="Are you sure you want to delete this recipe? This cannot be undone."
        buttons={[
          { text: 'Cancel', role: 'cancel', handler: () => setShowDeleteAlert(false) },
          { text: 'Delete', handler: handleDelete },
        ]}
        onDidDismiss={() => setShowDeleteAlert(false)}
      />
    </ChefLayout>
  );
}
