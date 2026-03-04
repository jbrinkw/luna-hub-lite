import { useState, useRef, useCallback } from 'react';
import { IonButton } from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ScanMode = 'purchase' | 'consume_macros' | 'consume_no_macros' | 'shopping';

interface QueueItem {
  id: string;
  barcode: string;
  name: string;
  productId: string | null;
  status: 'success' | 'pending' | 'error';
  mode: ScanMode;
  quantity: number;
  unit: 'serving' | 'container';
  isNew: boolean; // placeholder products flagged [!NEW]
  stockLevel: number | null;
  errorMsg?: string;
}

interface NutritionData {
  servingsPerContainer: string;
  calories: string;
  carbs: string;
  fat: string;
  protein: string;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for testing)                                 */
/* ------------------------------------------------------------------ */

export function autoScaleNutrition(
  field: keyof NutritionData,
  value: string,
  current: NutritionData,
  original: NutritionData,
): NutritionData {
  const updated = { ...current, [field]: value };

  if (field === 'calories') {
    // Scale macros proportionally based on original ratios
    const newCals = parseFloat(value) || 0;
    const origCals = parseFloat(original.calories) || 1;
    if (origCals > 0 && newCals > 0) {
      const ratio = newCals / origCals;
      updated.carbs = (Math.round(parseFloat(original.carbs || '0') * ratio * 10) / 10).toString();
      updated.fat = (Math.round(parseFloat(original.fat || '0') * ratio * 10) / 10).toString();
      updated.protein = (Math.round(parseFloat(original.protein || '0') * ratio * 10) / 10).toString();
    }
  } else if (field === 'carbs' || field === 'fat' || field === 'protein') {
    // Recalculate calories with 4-4-9 rule
    const c = parseFloat(updated.carbs) || 0;
    const f = parseFloat(updated.fat) || 0;
    const p = parseFloat(updated.protein) || 0;
    updated.calories = Math.round(c * 4 + p * 4 + f * 9).toString();
  }

  return updated;
}

/* ================================================================== */
/*  ScannerPage                                                        */
/* ================================================================== */

export function ScannerPage() {
  const { user } = useAuth();
  const barcodeRef = useRef<HTMLInputElement>(null);

  /* ---- Mode & queue ---- */
  const [mode, setMode] = useState<ScanMode>('purchase');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'new'>('all');
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  /* ---- Keypad screen ---- */
  const [screenValue, setScreenValue] = useState('1');
  const [overwriteNext, setOverwriteNext] = useState(true);

  /* ---- Unit toggle (consume modes) ---- */
  const [unit, setUnit] = useState<'serving' | 'container'>('serving');

  /* ---- Nutrition editor (purchase mode) ---- */
  const [nutrition, setNutrition] = useState<NutritionData>({
    servingsPerContainer: '1',
    calories: '',
    carbs: '',
    fat: '',
    protein: '',
  });
  const [originalNutrition, setOriginalNutrition] = useState<NutritionData>({
    servingsPerContainer: '1',
    calories: '',
    carbs: '',
    fat: '',
    protein: '',
  });

  /* ---------------------------------------------------------------- */
  /*  Barcode submit                                                   */
  /* ---------------------------------------------------------------- */

  const handleBarcodeSubmit = useCallback(
    async (barcode: string) => {
      if (!barcode.trim() || !user) return;

      const qty = parseFloat(screenValue) || 1;
      const tempId = Date.now().toString();

      // Add pending item to queue
      const newItem: QueueItem = {
        id: tempId,
        barcode,
        name: `Processing ${barcode}...`,
        productId: null,
        status: 'pending',
        mode,
        quantity: qty,
        unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
        isNew: false,
        stockLevel: null,
      };
      setQueue((prev) => [newItem, ...prev]);
      setActiveItemId(tempId);

      // Reset input
      if (barcodeRef.current) barcodeRef.current.value = '';
      setScreenValue('1');
      setOverwriteNext(true);

      try {
        // Look up product by barcode
        const { data: product } = await chefbyte()
          .from('products')
          .select(
            'product_id, name, barcode, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container',
          )
          .eq('user_id', user.id)
          .eq('barcode', barcode)
          .single();

        if (product) {
          // Product found
          setNutrition({
            servingsPerContainer: String(product.servings_per_container ?? 1),
            calories: String(product.calories_per_serving ?? ''),
            carbs: String(product.carbs_per_serving ?? ''),
            fat: String(product.fat_per_serving ?? ''),
            protein: String(product.protein_per_serving ?? ''),
          });
          setOriginalNutrition({
            servingsPerContainer: String(product.servings_per_container ?? 1),
            calories: String(product.calories_per_serving ?? ''),
            carbs: String(product.carbs_per_serving ?? ''),
            fat: String(product.fat_per_serving ?? ''),
            protein: String(product.protein_per_serving ?? ''),
          });

          // Execute the action based on mode — use freshly computed nutrition
          // (setNutrition is async/batched, so `nutrition` from closure is stale)
          const freshNutrition: NutritionData = {
            servingsPerContainer: String(product.servings_per_container ?? 1),
            calories: String(product.calories_per_serving ?? ''),
            carbs: String(product.carbs_per_serving ?? ''),
            fat: String(product.fat_per_serving ?? ''),
            protein: String(product.protein_per_serving ?? ''),
          };
          await executeAction(mode, product, qty, unit, freshNutrition);

          setQueue((prev) =>
            prev.map((item) =>
              item.id === tempId
                ? {
                    ...item,
                    name: product.name,
                    productId: product.product_id,
                    status: 'success',
                    isNew: product.is_placeholder,
                  }
                : item,
            ),
          );
        } else {
          // Product not found — create placeholder (Edge Function stubbed)
          // TODO: Call analyze-product Edge Function for automatic nutrition lookup
          const { data: newProduct } = await chefbyte()
            .from('products')
            .insert({
              user_id: user.id,
              barcode,
              name: `Unknown (${barcode})`,
              is_placeholder: true,
            })
            .select('product_id, name')
            .single();

          setQueue((prev) =>
            prev.map((item) =>
              item.id === tempId
                ? {
                    ...item,
                    name: newProduct?.name ?? `Unknown (${barcode})`,
                    productId: newProduct?.product_id ?? null,
                    status: 'success',
                    isNew: true,
                  }
                : item,
            ),
          );
        }
      } catch (err: any) {
        setQueue((prev) =>
          prev.map((item) =>
            item.id === tempId
              ? { ...item, status: 'error', name: `Error: ${err.message ?? 'Unknown'}`, errorMsg: err.message }
              : item,
          ),
        );
      }
    },
    [user, mode, screenValue, unit, nutrition],
  );

  /* ---------------------------------------------------------------- */
  /*  Execute action based on mode                                     */
  /* ---------------------------------------------------------------- */

  const executeAction = async (
    actionMode: ScanMode,
    product: any,
    qty: number,
    unitType: 'serving' | 'container',
    nutData: NutritionData,
  ) => {
    if (!user) return;

    switch (actionMode) {
      case 'purchase': {
        // Get default location for stock lot
        const { data: locs } = await chefbyte()
          .from('locations')
          .select('location_id')
          .eq('user_id', user.id)
          .order('created_at')
          .limit(1);
        const locId = (locs?.[0] as any)?.location_id;
        if (!locId) break; // No locations — can't add stock

        // Insert stock lot + optional nutrition update
        await chefbyte().from('stock_lots').insert({
          user_id: user.id,
          product_id: product.product_id,
          qty_containers: qty,
          location_id: locId,
        });
        // Update product nutrition if changed
        if (nutData.calories || nutData.protein || nutData.carbs || nutData.fat) {
          await chefbyte()
            .from('products')
            .update({
              calories_per_serving: parseFloat(nutData.calories) || null,
              protein_per_serving: parseFloat(nutData.protein) || null,
              carbs_per_serving: parseFloat(nutData.carbs) || null,
              fat_per_serving: parseFloat(nutData.fat) || null,
              servings_per_container: parseFloat(nutData.servingsPerContainer) || 1,
            })
            .eq('product_id', product.product_id);
        }
        break;
      }
      case 'consume_macros': {
        await (chefbyte() as any).rpc('consume_product', {
          p_product_id: product.product_id,
          p_qty: qty,
          p_unit: unitType,
          p_log_macros: true,
          p_logical_date: todayStr(),
        });
        break;
      }
      case 'consume_no_macros': {
        await (chefbyte() as any).rpc('consume_product', {
          p_product_id: product.product_id,
          p_qty: qty,
          p_unit: unitType,
          p_log_macros: false,
          p_logical_date: todayStr(),
        });
        break;
      }
      case 'shopping': {
        await chefbyte().from('shopping_list').insert({
          user_id: user.id,
          product_id: product.product_id,
          qty_containers: qty,
          purchased: false,
        });
        break;
      }
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Keypad handler                                                   */
  /* ---------------------------------------------------------------- */

  const handleKeypadClick = (key: string) => {
    if (key === '←') {
      setScreenValue((prev) => prev.slice(0, -1) || '0');
      setOverwriteNext(false);
    } else if (key === '.') {
      if (overwriteNext) {
        setScreenValue('0.');
        setOverwriteNext(false);
      } else if (!screenValue.includes('.')) {
        setScreenValue((prev) => prev + '.');
      }
    } else {
      if (overwriteNext) {
        setScreenValue(key);
        setOverwriteNext(false);
      } else {
        setScreenValue((prev) => (prev === '0' ? key : prev + key));
      }
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Nutrition change handler                                         */
  /* ---------------------------------------------------------------- */

  const handleNutritionChange = (field: keyof NutritionData, value: string) => {
    setNutrition((prev) => autoScaleNutrition(field, value, prev, originalNutrition));
  };

  /* ---------------------------------------------------------------- */
  /*  Queue actions                                                    */
  /* ---------------------------------------------------------------- */

  const deleteQueueItem = (id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
    if (activeItemId === id) setActiveItemId(null);
  };

  /* ---------------------------------------------------------------- */
  /*  Derived                                                          */
  /* ---------------------------------------------------------------- */

  const activeItem = queue.find((q) => q.id === activeItemId) ?? null;
  const filteredQueue = filter === 'new' ? queue.filter((q) => q.isNew) : queue;

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  return (
    <ChefLayout title="Scanner">
      <h2>SCANNER</h2>

      <div data-testid="scanner-container" style={{ display: 'grid', gridTemplateColumns: '1.5fr 2.5fr', gap: '16px' }}>
        {/* ========================================================== */}
        {/*  LEFT COLUMN — QUEUE                                        */}
        {/* ========================================================== */}
        <div data-testid="queue-panel" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Barcode input */}
          <input
            ref={barcodeRef}
            data-testid="barcode-input"
            type="text"
            placeholder="Scan or type barcode..."
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleBarcodeSubmit(e.currentTarget.value);
              }
            }}
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #ddd',
              borderRadius: '6px',
              fontSize: '14px',
            }}
          />

          {/* Filter buttons */}
          <div data-testid="filter-buttons" style={{ display: 'flex', gap: '4px' }}>
            <IonButton
              size="small"
              fill={filter === 'all' ? 'solid' : 'outline'}
              onClick={() => setFilter('all')}
              data-testid="filter-all"
            >
              All
            </IonButton>
            <IonButton
              size="small"
              fill={filter === 'new' ? 'solid' : 'outline'}
              onClick={() => setFilter('new')}
              data-testid="filter-new"
            >
              New
            </IonButton>
          </div>

          {/* Queue list */}
          <div
            data-testid="queue-list"
            style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}
          >
            {filteredQueue.length === 0 && (
              <p data-testid="queue-empty" style={{ color: '#666', fontStyle: 'italic', textAlign: 'center' }}>
                Scan a barcode to start
              </p>
            )}
            {filteredQueue.map((item) => (
              <div
                key={item.id}
                data-testid={`queue-item-${item.id}`}
                onClick={() => setActiveItemId(item.id)}
                style={{
                  padding: '8px 10px',
                  border: `2px solid ${
                    item.status === 'error'
                      ? '#eb445a'
                      : item.status === 'pending'
                        ? '#ffc409'
                        : item.isNew
                          ? '#eb445a'
                          : '#2dd36f'
                  }`,
                  borderRadius: '6px',
                  background: activeItemId === item.id ? '#e8f0fe' : item.isNew ? '#ffe9e9' : '#fff',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9em' }}>
                    {item.isNew && (
                      <span data-testid={`new-badge-${item.id}`} style={{ color: '#eb445a', marginRight: '4px' }}>
                        [!NEW]
                      </span>
                    )}
                    {item.name}
                  </span>
                  <button
                    data-testid={`delete-item-${item.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteQueueItem(item.id);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#eb445a',
                      cursor: 'pointer',
                      fontWeight: 700,
                      fontSize: '16px',
                    }}
                  >
                    ×
                  </button>
                </div>
                <div style={{ fontSize: '0.8em', color: '#666' }}>
                  {item.mode === 'purchase' ? 'Purchased' : item.mode === 'shopping' ? 'Added to cart' : 'Consumed'}{' '}
                  {item.quantity} {item.unit}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ========================================================== */}
        {/*  RIGHT COLUMN — KEYPAD                                      */}
        {/* ========================================================== */}
        <div data-testid="keypad-panel" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Mode selector */}
          <div
            data-testid="mode-selector"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}
          >
            {(
              [
                { key: 'purchase', label: 'Purchase' },
                { key: 'consume_macros', label: 'Consume+Macros' },
                { key: 'consume_no_macros', label: 'Consume-NoMacros' },
                { key: 'shopping', label: 'Add to Shopping' },
              ] as const
            ).map((m) => (
              <IonButton
                key={m.key}
                size="small"
                fill={mode === m.key ? 'solid' : 'outline'}
                onClick={() => setMode(m.key)}
                data-testid={`mode-${m.key}`}
              >
                {m.label}
              </IonButton>
            ))}
          </div>

          {/* Active item display */}
          <div
            data-testid="active-item-display"
            style={{ padding: '8px', background: '#f4f5f8', borderRadius: '6px', textAlign: 'center', fontWeight: 600 }}
          >
            {activeItem ? activeItem.name : 'No item selected'}
          </div>

          {/* Screen value */}
          <div
            data-testid="screen-value"
            style={{
              padding: '12px',
              background: '#fff',
              border: '2px solid #ddd',
              borderRadius: '6px',
              textAlign: 'right',
              fontSize: '24px',
              fontWeight: 700,
              fontFamily: 'monospace',
            }}
          >
            {screenValue}
          </div>

          {/* Nutrition editor (purchase mode only) */}
          {mode === 'purchase' && (
            <div
              data-testid="nutrition-editor"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px' }}
            >
              {[
                { key: 'servingsPerContainer' as const, label: 'Srv/Ctn' },
                { key: 'calories' as const, label: 'Cal' },
                { key: 'carbs' as const, label: 'Carbs' },
                { key: 'fat' as const, label: 'Fat' },
                { key: 'protein' as const, label: 'Protein' },
              ].map((f) => (
                <div key={f.key} style={{ textAlign: 'center' }}>
                  <label style={{ fontSize: '0.7em', color: '#666', display: 'block' }}>{f.label}</label>
                  <input
                    data-testid={`nut-${f.key}`}
                    type="text"
                    inputMode="decimal"
                    value={nutrition[f.key]}
                    onChange={(e) => handleNutritionChange(f.key, e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px',
                      textAlign: 'center',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      fontSize: '0.9em',
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Numeric keypad */}
          <div
            data-testid="keypad-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '6px',
            }}
          >
            {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '←'].map((key) => (
              <button
                key={key}
                data-testid={`key-${key === '←' ? 'backspace' : key}`}
                onClick={() => handleKeypadClick(key)}
                style={{
                  padding: '14px',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 700,
                  fontSize: '18px',
                  background: key === '←' ? '#eb445a' : '#fff',
                  color: key === '←' ? '#fff' : '#111',
                }}
              >
                {key}
              </button>
            ))}
          </div>

          {/* Unit toggle (consume modes only) */}
          {(mode === 'consume_macros' || mode === 'consume_no_macros') && (
            <IonButton
              data-testid="unit-toggle"
              size="small"
              fill="outline"
              onClick={() => setUnit((prev) => (prev === 'serving' ? 'container' : 'serving'))}
            >
              {unit === 'serving' ? 'Serving' : 'Container'}
            </IonButton>
          )}
        </div>
      </div>
    </ChefLayout>
  );
}
