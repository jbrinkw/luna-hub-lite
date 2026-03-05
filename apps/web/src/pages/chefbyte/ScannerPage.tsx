import { useState, useRef, useCallback } from 'react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { useScannerDetection } from '@/hooks/useScannerDetection';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ScanMode = 'purchase' | 'consume_macros' | 'consume_no_macros' | 'shopping';

interface UndoInfo {
  type: 'purchase' | 'consume' | 'log' | 'shopping';
  /** stock_lot_id, food_log log_id, or cart_item_id */
  recordId?: string;
  /** For consume reversal: re-add stock with this product/location */
  productId?: string;
  locationId?: string;
  qtyContainers?: number;
  /** For consume+macros reversal: also delete the food_log */
  logId?: string;
}

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
  undoInfo?: UndoInfo;
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
  /*  Hardware barcode scanner detection                               */
  /* ---------------------------------------------------------------- */

  // handleBarcodeSubmit is defined below but referenced here via ref
  const barcodeSubmitRef = useRef<(barcode: string) => void>(() => {});

  useScannerDetection({
    onBarcodeScanned: (barcode) => barcodeSubmitRef.current(barcode),
    protectedInputIds: ['nut-servingsPerContainer', 'nut-calories', 'nut-carbs', 'nut-fat', 'nut-protein'],
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

      // Reset input and re-focus for next scan
      if (barcodeRef.current) {
        barcodeRef.current.value = '';
        barcodeRef.current.focus();
      }
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
          const undoInfo = await executeAction(mode, product, qty, unit, freshNutrition);

          setQueue((prev) =>
            prev.map((item) =>
              item.id === tempId
                ? {
                    ...item,
                    name: product.name,
                    productId: product.product_id,
                    status: 'success',
                    isNew: product.is_placeholder,
                    undoInfo,
                  }
                : item,
            ),
          );
        } else {
          // Product not found — try analyze-product edge function first,
          // fall back to placeholder if it fails or returns no data
          let analyzedProduct: any = null;
          try {
            const { data: efData, error: efError } = await supabase.functions.invoke('analyze-product', {
              body: { barcode },
            });
            if (!efError && efData?.suggestion) {
              // Edge function returned normalized product data from OpenFoodFacts + AI
              const s = efData.suggestion;
              const { data: created } = await chefbyte()
                .from('products')
                .insert({
                  user_id: user.id,
                  barcode,
                  name: s.name || `Product (${barcode})`,
                  description: s.description || null,
                  is_placeholder: false,
                  calories_per_serving: s.calories_per_serving ?? null,
                  protein_per_serving: s.protein_per_serving ?? null,
                  carbs_per_serving: s.carbs_per_serving ?? null,
                  fat_per_serving: s.fat_per_serving ?? null,
                  servings_per_container: s.servings_per_container ?? 1,
                })
                .select(
                  'product_id, name, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container',
                )
                .single();
              if (created) {
                analyzedProduct = created;
              }
            }
          } catch {
            // Edge function call failed — fall through to placeholder
          }

          if (analyzedProduct) {
            // AI-analyzed product created successfully
            const freshNut: NutritionData = {
              servingsPerContainer: String(analyzedProduct.servings_per_container ?? 1),
              calories: String(analyzedProduct.calories_per_serving ?? ''),
              carbs: String(analyzedProduct.carbs_per_serving ?? ''),
              fat: String(analyzedProduct.fat_per_serving ?? ''),
              protein: String(analyzedProduct.protein_per_serving ?? ''),
            };
            setNutrition(freshNut);
            setOriginalNutrition(freshNut);

            const undoInfo = await executeAction(mode, analyzedProduct, qty, unit, freshNut);

            setQueue((prev) =>
              prev.map((item) =>
                item.id === tempId
                  ? {
                      ...item,
                      name: analyzedProduct.name,
                      productId: analyzedProduct.product_id,
                      status: 'success',
                      isNew: false,
                      undoInfo,
                    }
                  : item,
              ),
            );
          } else {
            // Fallback: create placeholder product
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

  // Keep ref in sync so hardware scanner detection can call the latest version
  barcodeSubmitRef.current = handleBarcodeSubmit;

  /* ---------------------------------------------------------------- */
  /*  Execute action based on mode                                     */
  /* ---------------------------------------------------------------- */

  const executeAction = async (
    actionMode: ScanMode,
    product: any,
    qty: number,
    unitType: 'serving' | 'container',
    nutData: NutritionData,
  ): Promise<UndoInfo | undefined> => {
    if (!user) return undefined;

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
        const { data: newLot } = await chefbyte()
          .from('stock_lots')
          .insert({
            user_id: user.id,
            product_id: product.product_id,
            qty_containers: qty,
            location_id: locId,
          })
          .select('lot_id')
          .single();
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
        return newLot ? { type: 'purchase', recordId: (newLot as any).lot_id } : undefined;
      }
      case 'consume_macros': {
        const logicalDate = todayStr();
        await (chefbyte() as any).rpc('consume_product', {
          p_product_id: product.product_id,
          p_qty: qty,
          p_unit: unitType,
          p_log_macros: true,
          p_logical_date: logicalDate,
        });

        // Get the default location so undo can re-add stock
        const { data: purchLocs } = await chefbyte()
          .from('locations')
          .select('location_id')
          .eq('user_id', user.id)
          .order('created_at')
          .limit(1);
        const defaultLocId = (purchLocs?.[0] as any)?.location_id;

        // Compute qty_containers for undo re-add
        const spc = product.servings_per_container ?? 1;
        const qtyContainers = unitType === 'serving' ? qty / Math.max(spc, 0.001) : qty;

        // Find the food_log that was just created (most recent for this product+date)
        const { data: recentLog } = await chefbyte()
          .from('food_logs')
          .select('log_id')
          .eq('user_id', user.id)
          .eq('product_id', product.product_id)
          .eq('logical_date', logicalDate)
          .is('meal_id', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        return {
          type: 'consume',
          productId: product.product_id,
          locationId: defaultLocId ?? undefined,
          qtyContainers,
          logId: (recentLog as any)?.log_id ?? undefined,
        };
      }
      case 'consume_no_macros': {
        await (chefbyte() as any).rpc('consume_product', {
          p_product_id: product.product_id,
          p_qty: qty,
          p_unit: unitType,
          p_log_macros: false,
          p_logical_date: todayStr(),
        });

        // Get the default location so undo can re-add stock
        const { data: cLocs } = await chefbyte()
          .from('locations')
          .select('location_id')
          .eq('user_id', user.id)
          .order('created_at')
          .limit(1);
        const cLocId = (cLocs?.[0] as any)?.location_id;

        const cSpc = product.servings_per_container ?? 1;
        const cQtyContainers = unitType === 'serving' ? qty / Math.max(cSpc, 0.001) : qty;

        return {
          type: 'consume',
          productId: product.product_id,
          locationId: cLocId ?? undefined,
          qtyContainers: cQtyContainers,
        };
      }
      case 'shopping': {
        const { data: newCartItem } = await chefbyte()
          .from('shopping_list')
          .insert({
            user_id: user.id,
            product_id: product.product_id,
            qty_containers: qty,
            purchased: false,
          })
          .select('cart_item_id')
          .single();
        return newCartItem ? { type: 'shopping', recordId: (newCartItem as any).cart_item_id } : undefined;
      }
    }
    return undefined;
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

  const undoScan = async (target: QueueItem) => {
    if (target.undoInfo) {
      try {
        const info = target.undoInfo;
        switch (info.type) {
          case 'purchase':
            // Delete the stock lot that was created
            if (info.recordId) {
              await chefbyte().from('stock_lots').delete().eq('lot_id', info.recordId);
            }
            break;
          case 'consume':
            // Re-add the consumed stock as a new lot
            if (info.productId && info.locationId && info.qtyContainers && user) {
              await chefbyte().from('stock_lots').insert({
                user_id: user.id,
                product_id: info.productId,
                location_id: info.locationId,
                qty_containers: info.qtyContainers,
              });
            }
            // Delete the food_log if one was created
            if (info.logId) {
              await chefbyte().from('food_logs').delete().eq('log_id', info.logId);
            }
            break;
          case 'shopping':
            // Delete the shopping list item
            if (info.recordId) {
              await chefbyte().from('shopping_list').delete().eq('cart_item_id', info.recordId);
            }
            break;
        }
      } catch {
        // Undo failed — still remove from queue UI so user isn't stuck
      }
    }
    setQueue((prev) => prev.filter((item) => item.id !== target.id));
    if (activeItemId === target.id) setActiveItemId(null);
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
      <h1 style={{ margin: 0 }}>Scanner</h1>

      <div data-testid="scanner-container" className="scanner-container">
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
            aria-label="Barcode"
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
            <button
              onClick={() => setFilter('all')}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                fontWeight: 500,
                fontSize: '14px',
                cursor: 'pointer',
                border: filter === 'all' ? '1px solid #dbeafe' : '1px solid #ddd',
                background: filter === 'all' ? '#eff6ff' : '#fff',
                color: filter === 'all' ? '#1e66f5' : '#4b5563',
              }}
              data-testid="filter-all"
            >
              All
            </button>
            <button
              onClick={() => setFilter('new')}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                fontWeight: 500,
                fontSize: '14px',
                cursor: 'pointer',
                border: filter === 'new' ? '1px solid #dbeafe' : '1px solid #ddd',
                background: filter === 'new' ? '#eff6ff' : '#fff',
                color: filter === 'new' ? '#1e66f5' : '#4b5563',
              }}
              data-testid="filter-new"
            >
              New
            </button>
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
                      ? '#d33'
                      : item.status === 'pending'
                        ? '#ff9800'
                        : item.isNew
                          ? '#d33'
                          : '#2f9e44'
                  }`,
                  borderRadius: '6px',
                  background: activeItemId === item.id ? '#e8f0fe' : item.isNew ? '#ffe9e9' : '#fff',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9em' }}>
                    {item.isNew && (
                      <span data-testid={`new-badge-${item.id}`} style={{ color: '#d33', marginRight: '4px' }}>
                        [!NEW]
                      </span>
                    )}
                    {item.name}
                  </span>
                  <button
                    data-testid={`delete-item-${item.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      undoScan(item);
                    }}
                    aria-label={`Undo and remove ${item.name}`}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#d33',
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
              <button
                key={m.key}
                className={`scanner-mode-btn ${mode === m.key ? 'active' : ''}`}
                onClick={() => setMode(m.key)}
                data-testid={`mode-${m.key}`}
              >
                {m.label}
              </button>
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
                    aria-label={f.label}
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
          <div data-testid="keypad-grid" className="scanner-keys-grid">
            {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '←'].map((key) => (
              <button
                key={key}
                className={`scanner-key ${key === '←' ? 'op' : ''}`}
                data-testid={`key-${key === '←' ? 'backspace' : key}`}
                onClick={() => handleKeypadClick(key)}
                aria-label={key === '←' ? 'Backspace' : key === '.' ? 'Decimal point' : key}
              >
                {key}
              </button>
            ))}
          </div>

          {/* Unit toggle (consume modes only) */}
          {(mode === 'consume_macros' || mode === 'consume_no_macros') && (
            <button
              className="scanner-key unit-toggle"
              data-testid="unit-toggle"
              onClick={() => {
                const spc = parseFloat(nutrition.servingsPerContainer) || 1;
                const currentQty = parseFloat(screenValue) || 0;
                setUnit((prev) => {
                  if (prev === 'serving') {
                    // switching to container: divide by servings_per_container
                    const converted = currentQty / Math.max(spc, 0.001);
                    setScreenValue(parseFloat(converted.toFixed(3)).toString());
                    return 'container';
                  } else {
                    // switching to serving: multiply by servings_per_container
                    const converted = currentQty * spc;
                    setScreenValue(parseFloat(converted.toFixed(3)).toString());
                    return 'serving';
                  }
                });
                setOverwriteNext(true);
              }}
            >
              {unit === 'serving' ? 'Serving' : 'Container'}
            </button>
          )}
        </div>
      </div>
    </ChefLayout>
  );
}
