import { useState, useRef, useCallback } from 'react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
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
  /** For purchase: qty added in this scan (used to decrement on undo for merged lots) */
  purchaseQty?: number;
  /** For purchase: true if a new lot was created (delete on undo), false if merged (decrement on undo) */
  wasNewLot?: boolean;
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
  const { dayStartHour } = useAppContext();
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
            if (!efError && efData) {
              // Use AI suggestion if available, otherwise fall back to raw OFF data
              const s = efData.suggestion;
              const off = efData.off;
              const productName = s?.name || off?.product_name || `Product (${barcode})`;
              const hasNutrition = !!(s?.calories_per_serving != null || off?.nutriments);

              // Build nutrition from AI suggestion or raw OFF nutriments
              let cals: number | null = null;
              let prot: number | null = null;
              let carb: number | null = null;
              let fatVal: number | null = null;
              let spc = 1;

              if (s) {
                cals = s.calories_per_serving ?? null;
                prot = s.protein_per_serving ?? null;
                carb = s.carbs_per_serving ?? null;
                fatVal = s.fat_per_serving ?? null;
                spc = s.servings_per_container ?? 1;
              } else if (off?.nutriments) {
                // Fall back to per-serving OFF data, or per-100g if no serving data
                const n = off.nutriments;
                cals = n['energy-kcal_serving'] ?? n['energy-kcal_100g'] ?? null;
                prot = n['proteins_serving'] ?? n['proteins_100g'] ?? null;
                carb = n['carbohydrates_serving'] ?? n['carbohydrates_100g'] ?? null;
                fatVal = n['fat_serving'] ?? n['fat_100g'] ?? null;
              }

              if (productName !== `Product (${barcode})` || hasNutrition) {
                const { data: created } = await chefbyte()
                  .from('products')
                  .insert({
                    user_id: user.id,
                    barcode,
                    name: productName,
                    description: s?.description || null,
                    is_placeholder: false,
                    calories_per_serving: cals,
                    protein_per_serving: prot,
                    carbs_per_serving: carb,
                    fat_per_serving: fatVal,
                    servings_per_container: spc,
                  })
                  .select(
                    'product_id, name, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container',
                  )
                  .single();
                if (created) {
                  analyzedProduct = created;
                }
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

        // Check for existing lot with same merge key (product + location + no expiry)
        // If found, increment qty; otherwise insert new lot
        const { data: existingLot } = await chefbyte()
          .from('stock_lots')
          .select('lot_id, qty_containers')
          .eq('user_id', user.id)
          .eq('product_id', product.product_id)
          .eq('location_id', locId)
          .is('expires_on', null)
          .single();

        let newLot: { lot_id: string } | null = null;
        if (existingLot) {
          const { data: updated } = await chefbyte()
            .from('stock_lots')
            .update({ qty_containers: (existingLot as any).qty_containers + qty })
            .eq('lot_id', (existingLot as any).lot_id)
            .select('lot_id')
            .single();
          newLot = updated as any;
        } else {
          const { data: inserted } = await chefbyte()
            .from('stock_lots')
            .insert({
              user_id: user.id,
              product_id: product.product_id,
              qty_containers: qty,
              location_id: locId,
            })
            .select('lot_id')
            .single();
          newLot = inserted as any;
        }
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
        return newLot
          ? { type: 'purchase', recordId: (newLot as any).lot_id, purchaseQty: qty, wasNewLot: !existingLot }
          : undefined;
      }
      case 'consume_macros': {
        const logicalDate = todayStr(dayStartHour);
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
          p_logical_date: todayStr(dayStartHour),
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
    if (key === '\u2190') {
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
            if (info.recordId) {
              if (info.wasNewLot) {
                // New lot — delete it entirely
                await chefbyte().from('stock_lots').delete().eq('lot_id', info.recordId);
              } else {
                // Merged lot — decrement qty by the amount added in this scan
                const { data: lot } = await chefbyte()
                  .from('stock_lots')
                  .select('qty_containers')
                  .eq('lot_id', info.recordId)
                  .single();
                if (lot) {
                  const newQty = Number((lot as any).qty_containers) - (info.purchaseQty ?? 1);
                  if (newQty <= 0) {
                    await chefbyte().from('stock_lots').delete().eq('lot_id', info.recordId);
                  } else {
                    await chefbyte().from('stock_lots').update({ qty_containers: newQty }).eq('lot_id', info.recordId);
                  }
                }
              }
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

  /* ---- Inline name editing ---- */
  const [editingName, setEditingName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);

  // Sync editing name when active item changes or its name updates (e.g. async lookup)
  const activeItemName = activeItem?.name ?? '';
  const prevActiveRef = useRef(activeItemId);
  const prevNameRef = useRef(activeItemName);
  if (prevActiveRef.current !== activeItemId || (!nameEdited && prevNameRef.current !== activeItemName)) {
    prevActiveRef.current = activeItemId;
    prevNameRef.current = activeItemName;
    setEditingName(activeItemName);
    setNameEdited(false);
  }

  const saveName = async () => {
    const trimmed = editingName.trim();
    if (!trimmed || !activeItem?.productId || !nameEdited || trimmed === activeItem.name) return;
    await chefbyte()
      .from('products')
      .update({ name: trimmed, is_placeholder: false })
      .eq('product_id', activeItem.productId);
    setQueue((prev) =>
      prev.map((item) => (item.id === activeItem.id ? { ...item, name: trimmed, isNew: false } : item)),
    );
    setNameEdited(false);
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  const queueItemBorderColor = (item: QueueItem) => {
    if (item.status === 'error') return 'border-red-600';
    if (item.status === 'pending') return 'border-amber-500';
    if (item.isNew) return 'border-red-600';
    return 'border-green-600';
  };

  return (
    <ChefLayout title="Scanner">
      <h1 className="text-2xl font-bold text-slate-900 mb-4">Scanner</h1>

      <div
        data-testid="scanner-container"
        className="grid grid-cols-[1.5fr_2.5fr] gap-4 items-stretch flex-1 min-h-0 max-md:flex max-md:flex-col max-md:gap-3"
      >
        {/* ========================================================== */}
        {/*  LEFT COLUMN — QUEUE                                        */}
        {/* ========================================================== */}
        <div data-testid="queue-panel" className="flex flex-col gap-2">
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
            className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
          />

          {/* Filter buttons */}
          <div data-testid="filter-buttons" className="flex gap-1">
            <button
              onClick={() => setFilter('all')}
              className={`px-3.5 py-1.5 rounded-md font-medium text-sm cursor-pointer border ${
                filter === 'all'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
              data-testid="filter-all"
            >
              All
            </button>
            <button
              onClick={() => setFilter('new')}
              className={`px-3.5 py-1.5 rounded-md font-medium text-sm cursor-pointer border ${
                filter === 'new'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
              data-testid="filter-new"
            >
              New
            </button>
          </div>

          {/* Queue list */}
          <div data-testid="queue-list" className="flex-1 overflow-y-auto flex flex-col gap-1.5">
            {filteredQueue.length === 0 && (
              <p data-testid="queue-empty" className="text-slate-500 italic text-center">
                Scan a barcode to start
              </p>
            )}
            {filteredQueue.map((item) => (
              <div
                key={item.id}
                data-testid={`queue-item-${item.id}`}
                onClick={() => setActiveItemId(item.id)}
                className={`px-2.5 py-2 border-2 rounded-md cursor-pointer ${queueItemBorderColor(item)} ${
                  activeItemId === item.id ? 'bg-emerald-50' : item.isNew ? 'bg-red-50' : 'bg-white'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-[0.9em]">
                    {item.isNew && (
                      <span data-testid={`new-badge-${item.id}`} className="text-red-600 mr-1">
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
                    className="bg-transparent border-none text-red-600 cursor-pointer font-bold text-base"
                  >
                    &times;
                  </button>
                </div>
                <div className="text-[0.8em] text-slate-500">
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
        <div data-testid="keypad-panel" className="flex flex-col gap-2.5">
          {/* Mode selector */}
          <div data-testid="mode-selector" className="grid grid-cols-2 gap-2">
            {(
              [
                { key: 'purchase', label: 'Buy' },
                { key: 'consume_macros', label: 'Eat (Track)' },
                { key: 'consume_no_macros', label: 'Eat (Skip)' },
                { key: 'shopping', label: 'Add to List' },
              ] as const
            ).map((m) => (
              <button
                key={m.key}
                className={`p-2.5 border-2 rounded-lg cursor-pointer w-full flex items-center justify-center text-center leading-tight transition-all ${
                  mode === m.key
                    ? 'bg-slate-800 text-white border-slate-800 font-extrabold text-base ring-2 ring-slate-800/30 ring-offset-1'
                    : 'bg-white text-slate-900 border-slate-300 font-semibold text-[15px]'
                }`}
                onClick={() => setMode(m.key)}
                data-testid={`mode-${m.key}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Active item display / name editor */}
          {activeItem?.productId ? (
            <input
              data-testid="active-item-display"
              type="text"
              value={editingName}
              onChange={(e) => {
                setEditingName(e.target.value);
                setNameEdited(true);
              }}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveName();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="px-2 py-2 bg-slate-100 rounded-md text-center font-semibold border border-slate-300 w-full text-inherit"
            />
          ) : (
            <div
              data-testid="active-item-display"
              className="px-2 py-2 bg-slate-100 rounded-md text-center font-semibold"
            >
              {activeItem ? activeItem.name : 'No item selected'}
            </div>
          )}

          {/* Screen value */}
          <div
            data-testid="screen-value"
            className="px-3 py-3 bg-white border-2 border-slate-200 rounded-md text-right text-2xl font-bold font-mono"
          >
            {screenValue}
          </div>

          {/* Nutrition editor (purchase mode only) */}
          {mode === 'purchase' && (
            <div data-testid="nutrition-editor" className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
              {[
                { key: 'servingsPerContainer' as const, label: 'Srv/Ctn' },
                { key: 'calories' as const, label: 'Cal' },
                { key: 'carbs' as const, label: 'Carbs' },
                { key: 'fat' as const, label: 'Fat' },
                { key: 'protein' as const, label: 'Protein' },
              ].map((f) => (
                <div key={f.key} className="text-center">
                  <label className="text-[0.7em] text-slate-500 block">{f.label}</label>
                  <input
                    data-testid={`nut-${f.key}`}
                    type="text"
                    inputMode="decimal"
                    aria-label={f.label}
                    value={nutrition[f.key]}
                    onChange={(e) => handleNutritionChange(f.key, e.target.value)}
                    className="w-full px-1.5 py-2 text-center border border-slate-200 rounded text-sm min-h-[36px]"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Numeric keypad */}
          <div
            data-testid="keypad-grid"
            className="grid grid-cols-4 auto-rows-[minmax(68px,1fr)] gap-2 max-md:auto-rows-[minmax(62px,1fr)] max-sm:grid-cols-3 max-sm:auto-rows-[minmax(64px,1fr)]"
          >
            {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '\u2190'].map((key) => (
              <button
                key={key}
                className={`border rounded-lg text-2xl font-bold cursor-pointer select-none flex items-center justify-center min-h-14 text-slate-900 hover:bg-slate-100 ${
                  key === '\u2190' ? 'bg-red-50 border-red-200 hover:bg-red-100' : 'bg-white border-slate-200'
                }`}
                data-testid={`key-${key === '\u2190' ? 'backspace' : key}`}
                onClick={() => handleKeypadClick(key)}
                aria-label={key === '\u2190' ? 'Backspace' : key === '.' ? 'Decimal point' : key}
              >
                {key}
              </button>
            ))}
          </div>

          {/* Unit toggle (consume modes only) */}
          {(mode === 'consume_macros' || mode === 'consume_no_macros') && (
            <button
              className="bg-blue-50 border border-blue-300 rounded-lg text-sm font-semibold p-2 leading-tight cursor-pointer hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-slate-100"
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
