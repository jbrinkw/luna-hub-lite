import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { queryKeys } from '@/shared/queryKeys';
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
  /**
   * True once the user has moved on from this item (clicked another queue
   * row OR scanned a new barcode). Drives the red → green row color:
   * red = still being edited / never touched, green = committed.
   */
  confirmed: boolean;
}

/**
 * Compute a stock lot's `expires_on` from a product's suggested shelf life.
 *
 * Rules:
 *   - `default_shelf_life_days` null / 0 / negative / non-finite / NaN → null
 *     (non-perishable or unknown; scanner leaves expires_on unset).
 *   - Otherwise: `purchaseDate + days`, emitted as an ISO date string
 *     (YYYY-MM-DD) in the local timezone so the date the user sees in the
 *     UI matches the day they scanned on, not UTC-shifted by a day.
 *
 * Exported because the lot-insert logic in `executeAction` calls this twice
 * (for the merge-key lookup AND the insert row) and we want one mutation-
 * tested implementation instead of two inline copies that can drift.
 */
export function computeExpiresOn(
  shelfLifeDays: number | null | undefined,
  purchaseDate: Date,
): string | null {
  if (shelfLifeDays == null) return null;
  const n = Number(shelfLifeDays);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(purchaseDate);
  d.setDate(d.getDate() + Math.floor(n));
  // Local-date ISO (YYYY-MM-DD), not UTC — matches how Postgres DATE is
  // stored/displayed and how the user thinks about the date.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  const queryClient = useQueryClient();
  const barcodeRef = useRef<HTMLInputElement>(null);

  // Cache default location to avoid re-fetching on every scan
  const { data: defaultLocationId } = useQuery({
    queryKey: queryKeys.locations(user?.id ?? ''),
    queryFn: async () => {
      const { data } = await chefbyte()
        .from('locations')
        .select('location_id')
        .eq('user_id', user!.id)
        .order('created_at')
        .limit(1);
      return (data?.[0] as any)?.location_id ?? null;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  /* ---- Mode & queue ---- */
  const [mode, setMode] = useState<ScanMode>('purchase');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'new'>('all');
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  /* ---- Keypad screen ---- */
  const [screenValue, setScreenValue] = useState('1');
  // `overwriteNext` lives in a ref, not state: the UI never reads it (no
  // re-render needed), and rapid-fire keypad presses queued within the same
  // React batch must each read the latest flag. If we stored it in state,
  // three synchronous presses of 5-0-0 would all see the stale render-time
  // `overwriteNext=true` closure and each press would overwrite — making
  // the first-digit-replaces-default behavior swallow every subsequent
  // digit instead of appending.
  const overwriteNextRef = useRef(true);
  // Which surface the numeric keypad routes into. `'screen'` = the big
  // quantity display (default, always valid). Any nutrition key targets
  // that field; typing the first digit replaces the existing value so
  // users can overwrite without backspacing.
  type ActiveField = 'screen' | keyof NutritionData;
  const [activeField, setActiveField] = useState<ActiveField>('screen');
  const focusField = (f: ActiveField) => {
    setActiveField(f);
    overwriteNextRef.current = true;
  };

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

  // Keep nutritionRef pointing at the latest state — declared below.
  // Sync happens via a direct assignment on every render right after the
  // ref is declared (see the line following its declaration).

  /* ---------------------------------------------------------------- */
  /*  Hardware barcode scanner detection                               */
  /* ---------------------------------------------------------------- */

  // Tracks which nutrition fields the user manually edited since the last
  // scan. analyze-product completes seconds after scan; without this set
  // the AI response blows away whatever the user keyed in during the wait.
  // Ref (not state) because the keypad-batch fix already uses refs for
  // rapid-fire safety, and the scan handler reads this synchronously.
  const userEditedFieldsRef = useRef<Set<keyof NutritionData>>(new Set());
  // Ref-mirror of `nutrition` so the long-running handleBarcodeSubmit can
  // read the LATEST keypad edits at the moment analyze-product resolves,
  // not the stale render-time closure.
  const nutritionRef = useRef<NutritionData>({
    servingsPerContainer: '1',
    calories: '',
    carbs: '',
    fat: '',
    protein: '',
  });
  // Sync on every render. Writing to a ref during render is allowed in
  // React and runs before any effects / event handlers fire.
  nutritionRef.current = nutrition;

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
        confirmed: false,
      };
      setQueue((prev) => [newItem, ...prev]);
      setActiveItemId(tempId);

      // Reset input and re-focus for next scan
      if (barcodeRef.current) {
        barcodeRef.current.value = '';
        barcodeRef.current.focus();
      }
      setScreenValue('1');
      overwriteNextRef.current = true;
      // New scan = new edit session. Clear the edited-fields set so AI
      // response for this barcode can populate all fields; only NEW
      // keypresses during the AI wait count as user edits for this item.
      userEditedFieldsRef.current = new Set();

      // Auto-focus the servings-per-container field on scan (purchase mode
      // only — the nutrition editor renders only then). OFF/LLM data for this
      // field is wrong far more often than the macros, so the keypad should
      // target it by default. Matches the queue-click auto-focus behavior.
      if (mode === 'purchase') {
        focusField('servingsPerContainer');
      }

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

        // A placeholder row (from a previously failed scan) MUST fall through
        // to analyze-product so we can upgrade it to a real product, not
        // short-circuit and leave the user stuck with `Unknown (barcode)`.
        if (product && !product.is_placeholder) {
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
          // No product OR stale-placeholder row — call analyze-product and
          // either INSERT a new row or UPDATE the placeholder in place.
          const existingPlaceholderId: string | undefined = product?.is_placeholder
            ? product.product_id
            : undefined;

          let analyzedProduct: any = null;
          let hardAiError: { message: string; reason: string } | null = null;
          try {
            const { data: efData, error: efError } = await supabase.functions.invoke('analyze-product', {
              body: { barcode },
            });

            // supabase-js returns 4xx/5xx as `efError` (FunctionsHttpError). If
            // the function body included `ai_reason`, treat HARD reasons
            // (bad_key/missing_key/billing) as user-actionable — do NOT silently
            // fall through to a placeholder.
            let errBody: any = null;
            if (efError) {
              try {
                errBody = await (efError as any)?.context?.json?.();
              } catch {
                errBody = null;
              }
            }
            const payload = (efData as any) ?? errBody ?? null;
            const HARD = new Set(['bad_key', 'missing_key', 'billing']);
            if (payload?.ai_reason && HARD.has(payload.ai_reason)) {
              hardAiError = {
                message: payload.error || `AI service unavailable (${payload.ai_reason})`,
                reason: payload.ai_reason,
              };
            } else if (!efError && efData) {
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
                // default_shelf_life_days is only present on AI-normalized
                // suggestions; the OFF fallback path doesn't suggest one.
                // null means "non-perishable / unknown" → scanner leaves
                // expires_on unset for lots of this product.
                const shelfLife =
                  s?.default_shelf_life_days != null
                    ? Number(s.default_shelf_life_days) || null
                    : null;
                const productFields = {
                  barcode,
                  name: productName,
                  description: s?.description || null,
                  is_placeholder: false,
                  calories_per_serving: cals,
                  protein_per_serving: prot,
                  carbs_per_serving: carb,
                  fat_per_serving: fatVal,
                  servings_per_container: spc,
                  default_shelf_life_days: shelfLife,
                };
                const returning =
                  'product_id, name, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container, default_shelf_life_days';

                let resultRow: any = null;
                if (existingPlaceholderId) {
                  // Upgrade the stale placeholder row instead of creating a
                  // duplicate — preserves stock lots / food logs referencing
                  // the placeholder id.
                  const { data: updated } = await chefbyte()
                    .from('products')
                    .update(productFields)
                    .eq('product_id', existingPlaceholderId)
                    .select(returning)
                    .single();
                  resultRow = updated;
                } else {
                  const { data: created } = await chefbyte()
                    .from('products')
                    .insert({ user_id: user.id, ...productFields })
                    .select(returning)
                    .single();
                  resultRow = created;
                }
                if (resultRow) {
                  analyzedProduct = resultRow;
                }
              }
            }
          } catch {
            // Edge function call failed — fall through to placeholder
          }

          if (hardAiError) {
            // Surface the actionable error in the queue — explicitly do NOT
            // write a placeholder row (that would pollute the catalog with
            // Unknown entries while the admin fixes the key).
            setQueue((prev) =>
              prev.map((item) =>
                item.id === tempId
                  ? {
                      ...item,
                      status: 'error',
                      name: hardAiError!.message,
                      errorMsg: hardAiError!.message,
                    }
                  : item,
              ),
            );
          } else if (analyzedProduct) {
            // AI-analyzed product created/updated successfully.
            // Merge with user edits: analyze-product takes 5–25s and during
            // that wait the user may have keyed in corrections. Preserving
            // those is the whole point of scanning-then-typing as a UX —
            // users know the OFF data is often wrong for servings_per_container
            // and start correcting it before the AI even responds.
            const aiNut: NutritionData = {
              servingsPerContainer: String(analyzedProduct.servings_per_container ?? 1),
              calories: String(analyzedProduct.calories_per_serving ?? ''),
              carbs: String(analyzedProduct.carbs_per_serving ?? ''),
              fat: String(analyzedProduct.fat_per_serving ?? ''),
              protein: String(analyzedProduct.protein_per_serving ?? ''),
            };
            const edited = userEditedFieldsRef.current;
            // Read from the ref, NOT the closure-captured `nutrition`. The
            // async call stack has a stale snapshot from when the scan
            // fired; the ref has whatever the user keyed in while we were
            // awaiting analyze-product.
            const currentNutrition = nutritionRef.current;
            const mergedNut: NutritionData = {
              servingsPerContainer: edited.has('servingsPerContainer')
                ? currentNutrition.servingsPerContainer
                : aiNut.servingsPerContainer,
              calories: edited.has('calories') ? currentNutrition.calories : aiNut.calories,
              carbs: edited.has('carbs') ? currentNutrition.carbs : aiNut.carbs,
              fat: edited.has('fat') ? currentNutrition.fat : aiNut.fat,
              protein: edited.has('protein') ? currentNutrition.protein : aiNut.protein,
            };
            setNutrition(mergedNut);
            setOriginalNutrition(aiNut); // AI values are the "reset" baseline for 4-4-9 scaling

            const undoInfo = await executeAction(mode, analyzedProduct, qty, unit, mergedNut);

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
          } else if (existingPlaceholderId) {
            // We already have a placeholder from a prior failed scan; don't
            // create another. Just surface the existing placeholder.
            setQueue((prev) =>
              prev.map((item) =>
                item.id === tempId
                  ? {
                      ...item,
                      name: product.name,
                      productId: existingPlaceholderId,
                      status: 'success',
                      isNew: true,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executeAction is stable (only uses user + defaultLocationId, both in outer scope)
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
        const locId = defaultLocationId;
        if (!locId) break; // No locations — can't add stock

        // Auto-populate expires_on from product.default_shelf_life_days
        // (LLM-suggested on first import). Non-perishable / unknown
        // products leave default_shelf_life_days NULL → lot gets NULL
        // expires_on and sorts last in consumption order.
        const computedExpiresOn = computeExpiresOn(
          product.default_shelf_life_days,
          new Date(),
        );

        // Check for existing lot with matching merge key
        // (product + location + same expires_on). Different expires_on
        // values split into separate lots per the DB docs.
        let existingQuery = chefbyte()
          .from('stock_lots')
          .select('lot_id, qty_containers')
          .eq('user_id', user.id)
          .eq('product_id', product.product_id)
          .eq('location_id', locId);
        existingQuery = computedExpiresOn
          ? existingQuery.eq('expires_on', computedExpiresOn)
          : existingQuery.is('expires_on', null);
        const { data: existingLot } = await existingQuery.single();

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
          const insertRow: Record<string, unknown> = {
            user_id: user.id,
            product_id: product.product_id,
            qty_containers: qty,
            location_id: locId,
          };
          if (computedExpiresOn) insertRow.expires_on = computedExpiresOn;
          const { data: inserted } = await chefbyte()
            .from('stock_lots')
            .insert(insertRow)
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

        const defaultLocId = defaultLocationId;

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

        const cLocId = defaultLocationId;

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
        // Invalidate shopping list cache
        queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList(user.id) });
        return newCartItem ? { type: 'shopping', recordId: (newCartItem as any).cart_item_id } : undefined;
      }
    }
    // Invalidate stock + product caches after purchase/consume actions
    queryClient.invalidateQueries({ queryKey: queryKeys.stockLots(user.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.products(user.id) });
    return undefined;
  };

  /* ---------------------------------------------------------------- */
  /*  Keypad handler                                                   */
  /* ---------------------------------------------------------------- */

  const handleKeypadClick = (key: string) => {
    // Compute next value from the latest state via functional setters so that
    // rapid-fire presses queued in the same React batch each see the PREVIOUS
    // press's output (not the stale render-time closure). Same for the
    // overwriteNext flag — read/write through the ref, not the state closure.
    const computeNext = (current: string): string | null => {
      const prevOverwrite = overwriteNextRef.current;
      if (key === '\u2190') {
        overwriteNextRef.current = false;
        return current.slice(0, -1) || '0';
      }
      if (key === '.') {
        if (prevOverwrite) {
          overwriteNextRef.current = false;
          return '0.';
        }
        if (!current.includes('.')) {
          return current + '.';
        }
        return null; // no change
      }
      if (prevOverwrite) {
        overwriteNextRef.current = false;
        return key;
      }
      return current === '0' ? key : current + key;
    };

    if (activeField === 'screen') {
      setScreenValue((prev) => {
        const next = computeNext(prev);
        return next ?? prev;
      });
    } else {
      const field = activeField;
      // Mark as user-edited so the pending analyze-product response can't
      // blow this value away when it arrives seconds later.
      userEditedFieldsRef.current.add(field);
      setNutrition((prev) => {
        const current = prev[field] ?? '';
        const next = computeNext(current);
        if (next === null) return prev;
        return autoScaleNutrition(field, next, prev, originalNutrition);
      });
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Nutrition change handler                                         */
  /* ---------------------------------------------------------------- */

  const handleNutritionChange = (field: keyof NutritionData, value: string) => {
    userEditedFieldsRef.current.add(field);
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

  // Flip the previously-active item to confirmed=true whenever activeItemId
  // moves to something else (another queue row click OR a new scan). Red
  // rows mean "still being edited / never touched"; green means "you moved
  // on, which we treat as commit."
  const prevActiveForConfirmRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveForConfirmRef.current;
    if (prev && prev !== activeItemId) {
      setQueue((q) => q.map((i) => (i.id === prev ? { ...i, confirmed: true } : i)));
    }
    prevActiveForConfirmRef.current = activeItemId;
  }, [activeItemId]);

  // When the selected productId changes (queue click or fresh scan finalising
  // its productId), load that product's nutrition from the DB into the
  // editor so the inputs show THIS item's values — not the last-edited
  // item's. Without this the fields keep whatever the user last typed,
  // which is confusing AND (combined with the push-back effect) was the
  // root of cross-item data bleed before userEditedFieldsRef got cleared.
  useEffect(() => {
    if (!activeProductId) return;
    let cancelled = false;
    (async () => {
      const { data } = await chefbyte()
        .from('products')
        .select('servings_per_container, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving')
        .eq('product_id', activeProductId)
        .single();
      if (cancelled || !data) return;
      const loaded: NutritionData = {
        servingsPerContainer: String((data as any).servings_per_container ?? 1),
        calories: String((data as any).calories_per_serving ?? ''),
        carbs: String((data as any).carbs_per_serving ?? ''),
        fat: String((data as any).fat_per_serving ?? ''),
        protein: String((data as any).protein_per_serving ?? ''),
      };
      // Clear the edit-tracking ref too: after a reload, no fields are
      // "dirty" from the user's perspective on THIS item. The push-back
      // effect sees no edits and won't re-write.
      userEditedFieldsRef.current = new Set();
      setNutrition(loaded);
      setOriginalNutrition(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProductId]);

  // Push user-edited nutrition fields back to products on every change.
  // Without this, corrections typed AFTER the initial auto-save (fast path
  // for already-known barcodes, which commits within ~100 ms of scan)
  // would live only in local state and never reach the DB — so the product
  // settings page keeps showing stale values. Effect deps include
  // `activeItem?.productId` so the write also fires when productId
  // transitions from null → set (covers the rare race where the user
  // hits a key before the scan's DB lookup resolves).
  const activeProductId = activeItem?.productId ?? null;
  useEffect(() => {
    if (!activeProductId) return;
    const edited = userEditedFieldsRef.current;
    if (edited.size === 0) return;
    const patch: Record<string, number | null> = {};
    for (const f of edited) {
      const raw = nutrition[f] ?? '';
      if (f === 'servingsPerContainer') patch.servings_per_container = parseFloat(raw) || 1;
      else if (f === 'calories') patch.calories_per_serving = parseFloat(raw) || null;
      else if (f === 'protein') patch.protein_per_serving = parseFloat(raw) || null;
      else if (f === 'carbs') patch.carbs_per_serving = parseFloat(raw) || null;
      else if (f === 'fat') patch.fat_per_serving = parseFloat(raw) || null;
    }
    if (Object.keys(patch).length === 0) return;
    // Fire-and-forget; log errors but don't block the UI.
    chefbyte()
      .from('products')
      .update(patch)
      .eq('product_id', activeProductId)
      .then((res: { error: unknown }) => {
        if (res.error) console.error('scanner: nutrition push-back failed', res.error);
      });
  }, [nutrition, activeProductId]);

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
      <h1 className="text-2xl font-bold text-text mb-4">Scanner</h1>

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
            className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
          />

          {/* Filter buttons */}
          <div data-testid="filter-buttons" className="flex gap-1">
            <button
              onClick={() => setFilter('all')}
              className={`px-3.5 py-1.5 rounded-md font-medium text-sm cursor-pointer border ${
                filter === 'all'
                  ? 'border-emerald-200 bg-success-subtle text-chef-accent'
                  : 'border-border bg-surface text-text-secondary'
              }`}
              data-testid="filter-all"
            >
              All
            </button>
            <button
              onClick={() => setFilter('new')}
              className={`px-3.5 py-1.5 rounded-md font-medium text-sm cursor-pointer border ${
                filter === 'new'
                  ? 'border-emerald-200 bg-success-subtle text-chef-accent'
                  : 'border-border bg-surface text-text-secondary'
              }`}
              data-testid="filter-new"
            >
              New
            </button>
          </div>

          {/* Queue list */}
          <div data-testid="queue-list" className="flex-1 overflow-y-auto flex flex-col gap-1.5">
            {filteredQueue.length === 0 && (
              <p data-testid="queue-empty" className="text-text-secondary italic text-center">
                Scan a barcode to start
              </p>
            )}
            {filteredQueue.map((item) => (
              <div
                key={item.id}
                data-testid={`queue-item-${item.id}`}
                onClick={() => {
                  // Clear edit-tracking BEFORE activeItemId changes.
                  // Without this the push-back effect would fire with the
                  // previous item's nutrition state and write it to the
                  // new activeProductId — the exact bug where editing s/c
                  // on one item and clicking 2 more would propagate that
                  // value to items 2 and 3.
                  userEditedFieldsRef.current = new Set();
                  setActiveItemId(item.id);
                  // Opening a queue row pops focus to Srv/Ctn so the user
                  // can immediately type a replacement value on the keypad.
                  focusField('servingsPerContainer');
                }}
                className={`px-2.5 py-2 border-2 rounded-md cursor-pointer ${queueItemBorderColor(item)} ${
                  item.confirmed ? 'bg-success-subtle' : 'bg-danger-subtle'
                } ${activeItemId === item.id ? 'ring-2 ring-primary/40' : ''}`}
              >
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-[0.9em]">
                    {item.isNew && (
                      <span data-testid={`new-badge-${item.id}`} className="text-danger-text mr-1">
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
                    className="bg-transparent border-none text-danger-text cursor-pointer font-bold text-base"
                  >
                    &times;
                  </button>
                </div>
                <div className="text-[0.8em] text-text-secondary">
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
                    ? 'bg-text text-text-inverse border-text font-extrabold text-base ring-2 ring-text/30 ring-offset-1'
                    : 'bg-surface text-text border-border-strong font-semibold text-[15px]'
                }`}
                onClick={() => {
                  setMode(m.key);
                  // Nutrition editor only renders in 'purchase' mode; fall
                  // back to the main screen so the keypad still targets
                  // something meaningful when the user switches away.
                  if (m.key !== 'purchase') focusField('screen');
                }}
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
              className="px-2 py-2 bg-surface-hover rounded-md text-center font-semibold border border-border-strong w-full text-inherit"
            />
          ) : (
            <div
              data-testid="active-item-display"
              className="px-2 py-2 bg-surface-hover rounded-md text-center font-semibold"
            >
              {activeItem ? activeItem.name : 'No item selected'}
            </div>
          )}

          {/* Screen value — mirrors whichever keypad target is active.
               When a nutrition field is focused the big display shows that
               field's value so users can see what they're typing at read-
               able size instead of squinting at the tiny inline input.
               Click to snap back to the quantity ('screen') target. */}
          <div
            data-testid="screen-value"
            onClick={() => focusField('screen')}
            className={`relative px-3 py-3 bg-surface border-2 rounded-md text-right text-2xl font-bold font-mono cursor-pointer transition-all border-primary ring-2 ring-primary/40`}
          >
            {activeField !== 'screen' && (
              <span
                data-testid="screen-field-label"
                className="absolute top-1 left-2 text-[0.65rem] font-semibold uppercase tracking-wider text-primary"
              >
                {activeField === 'servingsPerContainer' ? 'Srv/Ctn' : activeField}
              </span>
            )}
            {activeField === 'screen' ? screenValue : nutrition[activeField] || '0'}
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
                  <label
                    className={`text-[0.7em] block transition-colors ${
                      activeField === f.key ? 'text-primary font-semibold' : 'text-text-tertiary'
                    }`}
                  >
                    {f.label}
                  </label>
                  <input
                    data-testid={`nut-${f.key}`}
                    type="text"
                    inputMode="decimal"
                    aria-label={f.label}
                    value={nutrition[f.key]}
                    onChange={(e) => handleNutritionChange(f.key, e.target.value)}
                    onFocus={() => focusField(f.key)}
                    onClick={() => focusField(f.key)}
                    className={`w-full px-1.5 py-2 text-center border rounded text-sm min-h-[36px] transition-all ${
                      activeField === f.key ? 'border-primary ring-2 ring-primary/40 bg-primary/5' : 'border-border'
                    }`}
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
                className={`border rounded-lg text-2xl font-bold cursor-pointer select-none flex items-center justify-center min-h-14 text-text hover:bg-surface-hover ${
                  key === '\u2190' ? 'bg-danger-subtle border-danger hover:bg-red-100' : 'bg-surface border-border'
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
              className="bg-info-subtle border border-blue-300 rounded-lg text-sm font-semibold p-2 leading-tight cursor-pointer hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-surface-hover"
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
                overwriteNextRef.current = true;
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
