import { useState, useRef, useCallback, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ScanBarcode } from 'lucide-react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';
import { queryKeys } from '@/shared/queryKeys';
import { useScannerDetection, type ScannerDropReason, type ScannerDropDetail } from '@/hooks/useScannerDetection';
import { handleKeypadStep } from './keypadLogic';
import { fetchScannerState, pushScannerMode } from '@/shared/scannerStateApi';

/**
 * Snapshot of the most-recent dropped scan, surfaced as a transient toast.
 *
 * Captured the moment `useScannerDetection` reports a keystroke was eaten
 * by the protected-target / buffer-stale / non-digit-clear rules. Auto-
 * clears 3 s after the timestamp (or earlier if the user re-focuses the
 * scanner field). Without this surfacing, a hardware scanner firing while
 * focus was on a non-scanner input dropped digits + Enter into a void —
 * the bug this whole change exists to fix.
 */
interface DroppedScanState {
  reason: ScannerDropReason;
  detail: ScannerDropDetail;
  timestamp: number;
  /** Pre-formatted message rendered into the toast body. */
  message: string;
}

/** Duration the dropped-scan toast stays visible before auto-clearing. */
const DROPPED_SCAN_TOAST_MS = 3000;

/**
 * Format the toast copy for a dropped scan event. Pure helper so the test
 * can mutation-check the user-facing string without rendering. The brief
 * specifies the format `"Scan ignored — focus is on <element>. Click the
 * Scan field."` and we mirror it here, falling back to a generic
 * description if the dropped-target metadata is incomplete.
 */
export function formatDroppedScanMessage(reason: ScannerDropReason, detail: ScannerDropDetail): string {
  if (reason === 'protected-target') {
    const label =
      detail.targetId || (detail.targetTagName ? detail.targetTagName.toLowerCase() : null) || 'another field';
    return `Scan ignored — focus is on ${label}. Click the Scan field.`;
  }
  if (reason === 'buffer-stale') {
    return `Scan ignored — partial barcode timed out${
      detail.bufferLength ? ` (${detail.bufferLength} digits lost)` : ''
    }.`;
  }
  // non-digit-clears-buffer
  return `Scan interrupted — a stray "${detail.key ?? 'key'}" cleared the buffer.`;
}

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
   * True when the queue row should render in the green "committed" treatment
   * instead of the red "needs attention" treatment. Set to true automatically
   * for known products on a successful scan (no edits required from the
   * user); set true on click-away for everything else; left false for
   * placeholders (truly NEW items the user must finish describing).
   *
   * The user-facing rule is "red = something the system doesn't know yet",
   * not "red = un-clicked": a barcode the catalog already knows in full
   * shouldn't demand attention just because the user hasn't navigated away.
   */
  confirmed: boolean;
}

/**
 * Predicate behind the queue row's red-vs-green treatment.
 *
 * Returns true when the row represents a NEW (placeholder) product that the
 * system doesn't fully know yet — the user has to finish entering its
 * macros / name / s-per-c. False once the product is known + the action
 * succeeded (so a re-scanned regular item lands as green immediately) AND
 * for explicit error/pending states (those have their own border color).
 *
 * Exported for unit testing the predicate against the user-reported case
 * "scanned a known product, it shouldn't have shown up red".
 */
export function isQueueItemNew(item: { status: 'success' | 'pending' | 'error'; isNew: boolean }): boolean {
  if (item.status !== 'success') return false; // pending = amber, error = red-error (separate)
  return item.isNew === true;
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
export function computeExpiresOn(shelfLifeDays: number | null | undefined, purchaseDate: Date): string | null {
  if (shelfLifeDays == null) return null;
  // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: immediately guarded by Number.isFinite on the next line
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
  const [searchParams] = useSearchParams();

  // Cloud-side scanner_state hydration (USB Scanner Task 11). The Pi USB
  // scanner forwarder + the web Scanner page must agree on the active
  // mode, so the row at chefbyte.scanner_state is the cross-device
  // source of truth. On mount we read it once via TanStack Query;
  // initialMode below blends locked_mode > last_active_mode > URL param.
  // The query is fire-and-forget on first paint — render proceeds with a
  // local default ('purchase') and re-renders when the row resolves; the
  // scanner UI auto-corrects the highlighted mode the moment the data
  // arrives. staleTime keeps us from re-fetching on every page mount
  // within a 60s window (the row only changes on user action).
  const { data: scannerState } = useQuery({
    queryKey: queryKeys.scannerState(user?.id),
    queryFn: fetchScannerState,
    enabled: !!user,
    staleTime: 60_000,
  });

  // Deep-link support from EventViewerPage "Add stock" retry action:
  //   /chef/scanner?mode=purchase&product=<uuid>
  // The ?mode= param honors one of the four valid scan modes on mount.
  // The ?product= param lands as a read-only hint today — the scanner's
  // primary entrypoint is still a barcode scan. We log it on mount so
  // operators can confirm the deep-link wired up correctly, and future
  // work can upgrade it into an auto-queue entry without breaking the
  // URL contract.
  //
  // Mode resolution priority (matches the Pi-side decision in shelf-ingest
  // /barcode-scan handleBarcodeScan):
  //   1. scanner_state.locked_mode  — admin/cross-device lock; can't be
  //      overridden locally even via deep-link.
  //   2. scanner_state.last_active_mode — the most-recent local pick on
  //      any device.
  //   3. ?mode=<...> URL param — explicit deep-link intent from another
  //      page (e.g. EventViewerPage "Add stock" retry).
  //   4. 'purchase' — system default.
  const initialModeParam = searchParams.get('mode') as ScanMode | null;
  const initialMode: ScanMode = (() => {
    if (scannerState?.locked_mode) return scannerState.locked_mode;
    if (scannerState?.last_active_mode) return scannerState.last_active_mode;
    if (
      initialModeParam === 'purchase' ||
      initialModeParam === 'consume_macros' ||
      initialModeParam === 'consume_no_macros' ||
      initialModeParam === 'shopping'
    ) {
      return initialModeParam;
    }
    return 'purchase';
  })();

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
  const [mode, setMode] = useState<ScanMode>(initialMode);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'new'>('all');
  const [activeItemId, setActiveItemId] = useState<string | null>(null);

  // Hydrate `mode` from cloud scanner_state once the query resolves. The
  // initial render uses `useState(initialMode)` which sees `scannerState
  // === undefined` (still fetching) and falls back to URL param /
  // 'purchase'; this effect re-syncs as soon as the cloud row arrives so
  // the highlighted mode reflects the cross-device source of truth. We
  // bypass the local `handleSetMode` push wrapper deliberately — this
  // setMode is "I just learned the cloud's value", not "user picked",
  // so re-pushing would be a write echo.
  //
  // Scoped to a ref so we only hydrate ONCE per mount: a background
  // refetch of scannerState (e.g. window-focus refetch) shouldn't yank
  // the mode out from under the user mid-scan.
  const hydratedFromCloudRef = useRef(false);
  useEffect(() => {
    if (hydratedFromCloudRef.current) return;
    if (!scannerState) return; // still loading
    const cloudMode: ScanMode | null = scannerState.locked_mode ?? scannerState.last_active_mode ?? null;
    if (cloudMode) setMode(cloudMode);
    hydratedFromCloudRef.current = true;
  }, [scannerState]);

  // Debounced mode-change push to chefbyte.scanner_state. The 500ms
  // window absorbs keypad-mashing during testing without spamming the
  // edge function — only the LAST mode pick within a 500ms burst
  // actually hits the network. Held in a ref + cleared on unmount
  // below so a navigation away mid-debounce doesn't fire a state update
  // on a torn-down component.
  //
  // Failures are logged + swallowed: the local UI mode change is the
  // load-bearing user feedback; the cloud sync is "best effort" cross-
  // device coordination. A network blip shouldn't surface a red banner
  // for a successful local mode click.
  const debouncedPushModeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSetMode = useCallback((newMode: ScanMode) => {
    setMode(newMode);
    if (debouncedPushModeRef.current) clearTimeout(debouncedPushModeRef.current);
    debouncedPushModeRef.current = setTimeout(() => {
      pushScannerMode({ last_active_mode: newMode }).catch((err) => {
        console.warn('scanner-state push failed (non-fatal):', err);
      });
    }, 500);
  }, []);

  // Cancel any pending debounced push when the component unmounts —
  // otherwise a navigation away during the 500ms window would fire a
  // POST after the page has been disposed (no harm functionally but the
  // console.warn on a tear-down failure is noise).
  useEffect(() => {
    return () => {
      if (debouncedPushModeRef.current) clearTimeout(debouncedPushModeRef.current);
    };
  }, []);

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

  /**
   * In-flight barcode coordination — Map<barcode, Promise<void>> so the
   * SECOND (and Nth) scan of the same barcode can AWAIT the first
   * pipeline's completion and then re-enter the scan flow. By the time
   * the first scan finishes, the product row exists, so the duplicate's
   * lookup matches and the existing-product path runs executeAction —
   * each duplicate scan adds its own stock_lot.
   *
   * This replaces an earlier Set<string> + silent-drop design that lost
   * scans 2..N when the user rapid-fired the same barcode. Without the
   * coordination at all, parallel pipelines for the same barcode race
   * against each other: parallel analyze-product calls, parallel
   * placeholder INSERTs, duplicate `Unknown (<barcode>)` products, and
   * duplicate `stock_lots` from one physical "I scanned 3 ramen" event.
   *
   * The Promise resolves in the `finally` of handleBarcodeSubmit (success
   * OR error) so a thrown pipeline doesn't leave duplicates hanging. Held
   * in a ref (not state) so the synchronous scan handler reads the latest
   * value without waiting for a re-render.
   */
  const inFlightBarcodesRef = useRef<Map<string, Promise<void>>>(new Map());

  /* ---- Scanner drop observability ----
   *
   * `droppedScan` records the most recent silent-drop event so the UI can
   * render a transient toast. `scannerFocused` tracks whether the barcode
   * input currently owns focus — drives the green/yellow indicator next
   * to the input. Both pieces of state exist purely to surface the bug
   * class where a hardware scanner fires while focus is on the wrong
   * field and digits go to /dev/null. The protected-target predicate
   * inside `useScannerDetection` itself is unchanged.
   */
  const [droppedScan, setDroppedScan] = useState<DroppedScanState | null>(null);
  const [scannerFocused, setScannerFocused] = useState(false);
  const droppedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useScannerDetection({
    onBarcodeScanned: (barcode) => barcodeSubmitRef.current(barcode),
    onScanDropped: (reason, detail) => {
      setDroppedScan({
        reason,
        detail,
        timestamp: Date.now(),
        message: formatDroppedScanMessage(reason, detail),
      });
      // Refresh the auto-clear timer on every drop so back-to-back drops
      // (a hardware scanner fires 12 digits + Enter = 13 events) don't
      // each schedule their own competing clear timeouts.
      if (droppedClearTimerRef.current) clearTimeout(droppedClearTimerRef.current);
      droppedClearTimerRef.current = setTimeout(() => {
        setDroppedScan(null);
        droppedClearTimerRef.current = null;
      }, DROPPED_SCAN_TOAST_MS);
    },
    protectedInputIds: ['nut-servingsPerContainer', 'nut-calories', 'nut-carbs', 'nut-fat', 'nut-protein'],
  });

  // Clean up the toast timer on unmount so it can't fire setState after
  // the component is gone (React would warn about state updates on an
  // unmounted component).
  useEffect(() => {
    return () => {
      if (droppedClearTimerRef.current) clearTimeout(droppedClearTimerRef.current);
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Persistent audit log (chefbyte.scan_transactions)                */
  /* ---------------------------------------------------------------- */

  /**
   * USB Scanner Task 12 — fire-and-forget INSERT into
   * `chefbyte.scan_transactions` after every scan completes (success
   * OR error). This is the persistent audit log that the Settings →
   * Scanner Transactions tab subscribes to via Realtime.
   *
   * Critical: never blocks the UI. A failed audit-log INSERT only emits
   * a console.warn — the user-visible scan flow is the load-bearing
   * code, the audit log is observability sugar. This mirrors the
   * scanner-state push pattern.
   *
   * The `applied_*` IDs connect a transaction back to its downstream
   * effect (lot, food_log, cart_item) so the void-mutation can reverse
   * them. They're optional — any may be null when the side-effect didn't
   * happen (e.g. errored scan, or a mode where that effect isn't created).
   */
  const logTransaction = useCallback(
    (args: {
      barcode: string;
      productId: string | null;
      mode: ScanMode;
      qty: number | null;
      unit: 'serving' | 'container' | null;
      status: 'applied' | 'errored';
      errorMsg: string | null;
      appliedLotId?: string | null;
      appliedFoodLogId?: string | null;
      appliedCartItemId?: string | null;
    }) => {
      if (!user) return;
      const today = new Date().toISOString().slice(0, 10);
      // Fire-and-forget INSERT inside an async IIFE so any rejection (or
      // `.then` called on a non-thenable from a test mock builder) is
      // confined to a try/catch and never surfaces as an unhandled
      // rejection. The audit log is observability sugar — a failure here
      // must NEVER break the user-visible scan flow.
      void (async () => {
        try {
          const res = await chefbyte()
            .from('scan_transactions')
            .insert({
              user_id: user.id,
              barcode: args.barcode,
              product_id: args.productId,
              mode: args.mode,
              qty: args.qty,
              unit: args.unit,
              status: args.status,
              error_msg: args.errorMsg,
              logical_date: today,
              source: 'web',
              applied_lot_id: args.appliedLotId ?? null,
              applied_food_log_id: args.appliedFoodLogId ?? null,
              applied_cart_item_id: args.appliedCartItemId ?? null,
              applied_at: args.status === 'applied' ? new Date().toISOString() : null,
            });
          if ((res as { error?: unknown })?.error) {
            console.warn('scan_transactions log failed:', (res as { error?: unknown }).error);
          }
        } catch (err) {
          console.warn('scan_transactions log failed (threw):', err);
        }
      })();
    },
    [user],
  );

  /* ---------------------------------------------------------------- */
  /*  Barcode submit                                                   */
  /* ---------------------------------------------------------------- */

  const handleBarcodeSubmit = useCallback(
    async (barcode: string) => {
      if (!barcode.trim() || !user) return;

      // In-flight coordination: if a scan for this exact barcode is
      // already mid-pipeline, AWAIT its completion and then re-enter
      // ourselves. By the time the original finishes, the product row
      // exists, so the duplicate's lookup matches the existing-product
      // path and executeAction adds another stock_lot. This is what
      // "scanned 3 ramen at once and only 1 registered" used to fail —
      // scans 2 + 3 silently dropped.
      const trimmedBarcode = barcode.trim();
      const existingPromise = inFlightBarcodesRef.current.get(trimmedBarcode);
      if (existingPromise) {
        setDroppedScan({
          reason: 'protected-target',
          detail: {},
          timestamp: Date.now(),
          message: `Queued ${trimmedBarcode} — waiting for previous scan...`,
        });
        if (droppedClearTimerRef.current) clearTimeout(droppedClearTimerRef.current);
        droppedClearTimerRef.current = setTimeout(() => {
          setDroppedScan(null);
          droppedClearTimerRef.current = null;
        }, DROPPED_SCAN_TOAST_MS);
        if (barcodeRef.current) {
          barcodeRef.current.value = '';
          barcodeRef.current.focus();
        }
        // Wait for the in-flight pipeline (success OR error). Re-enter via
        // the ref so a closure that's been re-created on a later render is
        // the one we invoke (matches the pattern used by hardware-scanner
        // detection). Sequential await + recursive call also serializes
        // when 3+ scans pile up: the third scan sees the SECOND scan's
        // Promise after the first resolves.
        await existingPromise;
        return barcodeSubmitRef.current(barcode);
      }
      let resolveInFlight: () => void = () => {};
      const inFlightPromise = new Promise<void>((resolve) => {
        resolveInFlight = resolve;
      });
      inFlightBarcodesRef.current.set(trimmedBarcode, inFlightPromise);

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
        // Look up product by barcode. Use maybeSingle() because "0 rows" is
        // the normal first-scan case — single() would raise PGRST116 and
        // throw us into the catch, blocking the analyze-product fallback.
        // deleted_at filter is defensive — current settings deletes are
        // hard, but legacy soft-deleted rows may still exist in the DB
        // and would otherwise short-circuit the scan to a tombstone.
        const { data: product, error: lookupErr } = await chefbyte()
          .from('products')
          .select(
            'product_id, name, barcode, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container',
          )
          .eq('user_id', user.id)
          .eq('barcode', barcode)
          .is('deleted_at', null)
          .maybeSingle();
        if (lookupErr) throw new Error(lookupErr.message);

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
          const result = await executeAction(mode, product, qty, unit, freshNutrition);

          setQueue((prev) =>
            prev.map((item) =>
              item.id === tempId
                ? {
                    ...item,
                    name: product.name,
                    productId: product.product_id,
                    // If the DB write silently failed (no undoInfo + an error
                    // surfaced), reflect that in the queue row so the user
                    // doesn't think a non-existent lot was created. Without
                    // this surfacing, a failed Purchase mode UPDATE would
                    // present as a green/red row with "Purchased N" subtitle
                    // and no trace of the underlying problem.
                    status: result.error ? 'error' : 'success',
                    isNew: product.is_placeholder,
                    undoInfo: result.undoInfo,
                    errorMsg: result.error ?? undefined,
                    // Known product + successful action = no work left for
                    // the user → auto-confirm to the green treatment. Avoids
                    // the user-reported "scanned a product I already have, it
                    // showed up red as if new" complaint.
                    confirmed: !result.error && !product.is_placeholder,
                  }
                : item,
            ),
          );

          // Persistent audit log (Task 12). The applied_*_id fields
          // connect this transaction to its downstream effect so void
          // can reverse it. undoInfo carries the IDs created by
          // executeAction — extract per mode.
          //
          // When the web purchase MERGES into an existing lot (rather
          // than minting a fresh one), applied_lot_id stays null.
          // private.void_scan_transaction unconditionally DELETEs the
          // referenced lot, which would destroy inventory added by
          // other scans / manual entry / Pi USB into the same merged
          // lot. The void path then becomes a status-flip-only —
          // macros are voided correctly, but stock changes from a
          // merge are intentionally not reversible because the local
          // merge collapses the per-scan history. Asymmetric with the
          // Pi USB path (which always INSERTs new lots and gets clean
          // void semantics), but acceptable for v1.
          const wasNewLotKnown =
            mode === 'purchase' && result.undoInfo?.type === 'purchase' && result.undoInfo.wasNewLot === true;
          logTransaction({
            barcode,
            productId: product.product_id,
            mode,
            qty,
            unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
            status: result.error ? 'errored' : 'applied',
            errorMsg: result.error ?? null,
            appliedLotId: wasNewLotKnown ? (result.undoInfo?.recordId ?? null) : null,
            appliedFoodLogId:
              mode === 'consume_macros' && result.undoInfo?.type === 'consume' ? (result.undoInfo.logId ?? null) : null,
            appliedCartItemId:
              mode === 'shopping' && result.undoInfo?.type === 'shopping' ? (result.undoInfo.recordId ?? null) : null,
          });
        } else {
          // No product OR stale-placeholder row — call analyze-product and
          // either INSERT a new row or UPDATE the placeholder in place.
          const existingPlaceholderId: string | undefined = product?.is_placeholder ? product.product_id : undefined;

          let analyzedProduct: any = null;
          let hardAiError: { message: string; reason: string } | null = null;
          // Captures any inner-try failure (write error from
          // INSERT/UPDATE/revive, or a thrown exception) so we can surface
          // it as a red queue-row message instead of swallowing silently.
          // Without this, e.g. a unique-constraint collision or RLS failure
          // would leave the queue row stuck at "pending" amber with no
          // actionable signal — and the user sees an empty inventory with
          // no idea why.
          let inlineErr: string | null = null;
          try {
            // Fetch the user's placeholder products so the AI can match by
            // name/description in the same call — zero extra HTTP requests.
            const { data: placeholderCandidates } = await chefbyte()
              .from('products')
              .select('product_id, name, description')
              .eq('user_id', user.id)
              .eq('is_placeholder', true);

            const { data: efData, error: efError } = await supabase.functions.invoke('analyze-product', {
              body: { barcode, placeholder_candidates: placeholderCandidates ?? [] },
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

              // AI-matched placeholder: the model identified a name-based match
              // among the user's placeholder products. Use that id as the upgrade
              // target — same code path as barcode-based placeholder upgrade, so
              // all FK references (recipe_ingredients, meal_plan_entries, etc.)
              // survive intact. The barcode-matched id takes precedence if both
              // exist (shouldn't happen, but be explicit).
              const aiMatchedPlaceholderId: string | null =
                typeof efData.matched_placeholder_id === 'string' && efData.matched_placeholder_id.length > 0
                  ? efData.matched_placeholder_id
                  : null;

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
                const shelfLife = s?.default_shelf_life_days != null ? Number(s.default_shelf_life_days) || null : null;
                // analyze-product also returns default_expiry_days (AI-estimated
                // days-until-expiry from import date; range 1–730). Distinct from
                // default_shelf_life_days. Surfaces in Settings → Products list.
                const expiryDays = s?.default_expiry_days != null ? Number(s.default_expiry_days) || null : null;
                // Wire new distinct-unit + recipe-unit fields from AI response.
                // Defensive: only trust these when the suggestion object is present
                // (the OFF-only fallback path doesn't produce them).
                const isDistinctUnitItem: boolean = s?.is_distinct_unit_item === true;
                const netWeightG: number | null =
                  s?.net_weight_g != null && Number(s.net_weight_g) > 0 ? Number(s.net_weight_g) : null;
                // Sanitize default_recipe_unit: 'gram' requires net_weight_g > 0.
                let defaultRecipeUnit: string | null = null;
                if (s?.default_recipe_unit && ['gram', 'serving', 'container'].includes(s.default_recipe_unit)) {
                  defaultRecipeUnit = s.default_recipe_unit;
                  if (defaultRecipeUnit === 'gram' && !netWeightG) {
                    defaultRecipeUnit = 'serving';
                  }
                }
                // Display layer: visual unit pair + display_by_weight from the
                // AI suggestion. The edge function already applies both-or-
                // neither validation and downgrades display_by_weight when
                // net_weight_g is missing — this client-side path just
                // mirrors the contract defensively.
                const visualLabelRaw = (s as any)?.visual_unit_label;
                const visualUnitsRaw = (s as any)?.visual_units_per_serving;
                const visualLabel: string | null =
                  typeof visualLabelRaw === 'string' && visualLabelRaw.trim() !== '' ? visualLabelRaw.trim() : null;
                // parseFloat avoids the no-bare-number-coerce lint rule and
                // gives us NaN on garbage input — Number.isFinite then guards
                // both NaN and ±Infinity in one check.
                const visualUnitsParsed =
                  visualUnitsRaw == null
                    ? NaN
                    : typeof visualUnitsRaw === 'number'
                      ? visualUnitsRaw
                      : parseFloat(String(visualUnitsRaw));
                const visualUnitsPerServing: number | null =
                  Number.isFinite(visualUnitsParsed) && visualUnitsParsed > 0 ? visualUnitsParsed : null;
                // Both-or-neither: server-side CHECK constraint enforces the same.
                const visualPairOk = visualLabel != null && visualUnitsPerServing != null;
                const displayByWeight: boolean = !!(s as any)?.display_by_weight && !!netWeightG;
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
                  default_expiry_days: expiryDays,
                  is_distinct_unit_item: isDistinctUnitItem,
                  net_weight_g: netWeightG,
                  default_recipe_unit: defaultRecipeUnit,
                  // Display layer — display_by_weight wins precedence; if it's
                  // true the visual pair is forced null to match the helper's
                  // resolution logic and avoid stale form-state.
                  visual_unit_label: displayByWeight || !visualPairOk ? null : visualLabel,
                  visual_units_per_serving: displayByWeight || !visualPairOk ? null : visualUnitsPerServing,
                  display_by_weight: displayByWeight,
                };
                const returning =
                  'product_id, name, is_placeholder, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, servings_per_container, default_shelf_life_days, default_expiry_days, is_distinct_unit_item, net_weight_g, default_recipe_unit, visual_unit_label, visual_units_per_serving, display_by_weight';

                // Priority for upgrade target:
                //   1. barcode-matched placeholder (existingPlaceholderId) — most
                //      specific, this barcode was previously scanned and failed.
                //   2. AI name-matched placeholder (aiMatchedPlaceholderId) — new
                //      path: model matched by semantic name similarity.
                //   3. No match → INSERT a new product row.
                const upgradeTargetId = existingPlaceholderId ?? aiMatchedPlaceholderId ?? null;

                let resultRow: any = null;
                let writeErr: { message: string } | null = null;
                if (upgradeTargetId) {
                  // Upgrade the placeholder row instead of creating a duplicate —
                  // preserves all FK references (stock lots, food logs, recipe
                  // ingredients, meal plan entries) referencing the placeholder id.
                  const { data: updated, error: updErr } = await chefbyte()
                    .from('products')
                    .update(productFields)
                    .eq('product_id', upgradeTargetId)
                    .select(returning)
                    .single();
                  resultRow = updated;
                  writeErr = updErr ?? null;

                  // Surface the AI name-match promotion to the user so they
                  // know the placeholder was promoted rather than a new row
                  // created. Only fires for the AI-matched case (barcode-matched
                  // placeholder upgrades are invisible — the user already knew
                  // the product existed).
                  if (!existingPlaceholderId && aiMatchedPlaceholderId && resultRow) {
                    // Find the old placeholder name from the candidates list for
                    // the toast copy ("Greek Yogurt" → "Chobani Greek Yogurt 0%").
                    const matchedCandidate = (placeholderCandidates ?? []).find(
                      (c: { product_id: string; name: string; description?: string | null }) =>
                        c.product_id === aiMatchedPlaceholderId,
                    );
                    const oldName = matchedCandidate?.name ?? 'placeholder';
                    // Use the dropped-scan toast mechanism to surface a transient
                    // confirmation — reusing the existing toast infra avoids a new
                    // state variable. The message is informational, not an error.
                    setDroppedScan({
                      reason: 'protected-target',
                      detail: {},
                      timestamp: Date.now(),
                      message: `Promoted "${oldName}" → "${resultRow.name}"`,
                    });
                    if (droppedClearTimerRef.current) clearTimeout(droppedClearTimerRef.current);
                    droppedClearTimerRef.current = setTimeout(() => {
                      setDroppedScan(null);
                      droppedClearTimerRef.current = null;
                    }, 5000);
                  }
                } else {
                  // Revive-on-tombstone: even though Settings + the MCP tool
                  // hard-delete now, a user's DB may still hold legacy
                  // tombstones from older soft-deletes. The unique-on
                  // (user_id, barcode) index applies regardless of
                  // deleted_at, so a plain INSERT here would hit a duplicate-
                  // key violation that the outer catch swallows silently —
                  // surfacing as a red queue row + no stock_lot. Detect that
                  // case explicitly and UPDATE the tombstoned row to revive
                  // it (clear deleted_at, apply new fields) instead.
                  const { data: tombstoned } = await chefbyte()
                    .from('products')
                    .select('product_id')
                    .eq('user_id', user.id)
                    .eq('barcode', barcode)
                    .not('deleted_at', 'is', null)
                    .maybeSingle();
                  if (tombstoned) {
                    const { data: revived, error: revErr } = await chefbyte()
                      .from('products')
                      .update({ ...productFields, deleted_at: null })
                      .eq('product_id', (tombstoned as { product_id: string }).product_id)
                      .select(returning)
                      .single();
                    resultRow = revived;
                    writeErr = revErr ?? null;
                  } else {
                    const { data: created, error: insErr } = await chefbyte()
                      .from('products')
                      .insert({ user_id: user.id, ...productFields })
                      .select(returning)
                      .single();
                    resultRow = created;
                    writeErr = insErr ?? null;
                  }
                }
                if (resultRow) {
                  analyzedProduct = resultRow;
                } else if (writeErr) {
                  inlineErr = `Product write failed: ${writeErr.message}`;
                }
              }
            }
          } catch (err: any) {
            // Capture any thrown exception inside the analyze-product +
            // product-write block so it surfaces as a red queue row instead
            // of disappearing silently.
            inlineErr = err?.message ? `Scan pipeline error: ${err.message}` : 'Scan pipeline error';
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
            logTransaction({
              barcode,
              productId: null,
              mode,
              qty,
              unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
              status: 'errored',
              errorMsg: hardAiError.message,
            });
          } else if (inlineErr && !analyzedProduct) {
            // Inner-block write or thrown exception failed and we don't have
            // a product row to act on. Surface the captured message — without
            // this the row used to stay at "pending" amber and the user had
            // no signal that the side effects didn't happen.
            setQueue((prev) =>
              prev.map((item) =>
                item.id === tempId ? { ...item, status: 'error', name: inlineErr!, errorMsg: inlineErr! } : item,
              ),
            );
            logTransaction({
              barcode,
              productId: null,
              mode,
              qty,
              unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
              status: 'errored',
              errorMsg: inlineErr,
            });
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

            const result = await executeAction(mode, analyzedProduct, qty, unit, mergedNut);

            setQueue((prev) =>
              prev.map((item) =>
                item.id === tempId
                  ? {
                      ...item,
                      name: analyzedProduct.name,
                      productId: analyzedProduct.product_id,
                      status: result.error ? 'error' : 'success',
                      isNew: false,
                      undoInfo: result.undoInfo,
                      errorMsg: result.error ?? undefined,
                      // Newly-AI-imported product is "known" the moment the
                      // analyze-product call succeeds + the side-effect commit
                      // succeeds. Auto-confirm so the user sees the same green
                      // treatment as a returning known product.
                      confirmed: !result.error,
                    }
                  : item,
              ),
            );

            // Persistent audit log (Task 12) — AI-imported product path.
            // See the "wasNewLot" comment block on the known-product
            // path above for the rationale: applied_lot_id is only
            // recorded when the scan minted a fresh lot. Merges leave
            // it null so void becomes a status-flip-only and doesn't
            // destroy inventory contributed by other scans/manual/Pi.
            const wasNewLotAi =
              mode === 'purchase' && result.undoInfo?.type === 'purchase' && result.undoInfo.wasNewLot === true;
            logTransaction({
              barcode,
              productId: analyzedProduct.product_id,
              mode,
              qty,
              unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
              status: result.error ? 'errored' : 'applied',
              errorMsg: result.error ?? null,
              appliedLotId: wasNewLotAi ? (result.undoInfo?.recordId ?? null) : null,
              appliedFoodLogId:
                mode === 'consume_macros' && result.undoInfo?.type === 'consume'
                  ? (result.undoInfo.logId ?? null)
                  : null,
              appliedCartItemId:
                mode === 'shopping' && result.undoInfo?.type === 'shopping' ? (result.undoInfo.recordId ?? null) : null,
            });
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
            // Persistent audit log (Task 12). The placeholder fallback
            // didn't run executeAction so no downstream IDs exist —
            // record the placeholder match as `applied` (the queue row
            // shows success) but no lot/log/cart attachment.
            logTransaction({
              barcode,
              productId: existingPlaceholderId,
              mode,
              qty,
              unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
              status: 'applied',
              errorMsg: null,
            });
          } else {
            // analyze-product failed and no placeholder exists. Scanners always
            // have a barcode so minting a placeholder here is wrong — surfacing
            // the error lets the user create the product properly via Settings.
            const errMsg = `Scan failed for ${barcode}. Create the product manually in Settings.`;
            setQueue((prev) =>
              prev.map((item) =>
                item.id === tempId
                  ? {
                      ...item,
                      name: errMsg,
                      productId: null,
                      status: 'error',
                      errorMsg: errMsg,
                    }
                  : item,
              ),
            );
            logTransaction({
              barcode,
              productId: null,
              mode,
              qty,
              unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
              status: 'errored',
              errorMsg: errMsg,
            });
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
        // Persistent audit log (Task 12) — outer pipeline exception.
        logTransaction({
          barcode,
          productId: null,
          mode,
          qty,
          unit: mode === 'purchase' || mode === 'shopping' ? 'container' : unit,
          status: 'errored',
          errorMsg: err?.message ?? 'Unknown',
        });
      } finally {
        // Always release the in-flight slot — even when the pipeline threw
        // — so a transient failure doesn't permanently block re-scanning
        // the same barcode. Resolve the awaitable Promise so any duplicate
        // scans currently parked on `await existingPromise` wake up and
        // retry; they'll find the now-existing product (or hit the same
        // error) and surface in the queue accordingly.
        inFlightBarcodesRef.current.delete(trimmedBarcode);
        resolveInFlight();
      }
    },
    [user, mode, screenValue, unit, nutrition, defaultLocationId, logTransaction],
  );

  // Keep ref in sync so hardware scanner detection can call the latest version
  barcodeSubmitRef.current = handleBarcodeSubmit;

  /* ---------------------------------------------------------------- */
  /*  Execute action based on mode                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Execute the post-scan side-effect for the active mode.
   *
   * Returns `{ undoInfo, error }` instead of bare undoInfo so the caller can
   * surface a DB write failure in the queue UI. Prior shape collapsed
   * "succeeded but nothing to undo" and "failed silently" into the same
   * `undefined`, which reproduced the user-reported "scanned properly but
   * the lot never showed up in inventory" silent fault.
   *
   * Cache invalidation is now scoped per-branch BEFORE the early return —
   * the prior placement at the bottom of the function was unreachable for
   * Purchase / Consume (those branches `return` inside the case), so the
   * Inventory page would not refresh after a Purchase write succeeded.
   */
  const executeAction = async (
    actionMode: ScanMode,
    product: any,
    qty: number,
    unitType: 'serving' | 'container',
    nutData: NutritionData,
  ): Promise<{ undoInfo: UndoInfo | undefined; error: string | null }> => {
    if (!user) return { undoInfo: undefined, error: null };

    switch (actionMode) {
      case 'purchase': {
        let locId = defaultLocationId ?? null;
        if (!locId) {
          // No locations configured yet — auto-create a "Pantry" so the
          // first-time scan doesn't dead-end. Earlier we returned a red
          // "No location configured" error which left the user staring at
          // the catalog with no stock_lot and no clear next step. The
          // location row carries ON DELETE CASCADE from auth.users so a
          // user delete cleans it up. queryKeys.locations gets invalidated
          // so the cached null becomes the new id immediately.
          const { data: created, error: createErr } = await chefbyte()
            .from('locations')
            .insert({ user_id: user.id, name: 'Pantry' })
            .select('location_id')
            .single();
          if (createErr || !created) {
            return {
              undoInfo: undefined,
              error: `Failed to create default Pantry location: ${createErr?.message ?? 'unknown'}`,
            };
          }
          locId = (created as { location_id: string }).location_id;
          queryClient.invalidateQueries({ queryKey: queryKeys.locations(user.id) });
        }

        // Auto-populate expires_on from product.default_shelf_life_days
        // (LLM-suggested on first import). Non-perishable / unknown
        // products leave default_shelf_life_days NULL → lot gets NULL
        // expires_on and sorts last in consumption order.
        const computedExpiresOn = computeExpiresOn(product.default_shelf_life_days, new Date());

        // Check for existing lot with matching merge key
        // (product + location + same expires_on). Different expires_on
        // values split into separate lots per the DB docs.
        //
        // `.maybeSingle()` instead of `.single()` so the "0 rows" case
        // returns null + null-error (the natural insert path) rather than
        // PGRST116 + null-data — `.single()` errors on 0-row results, and
        // we'd previously been treating both that error and a real RLS
        // failure as "no row, fall through to insert", which masked
        // legitimate failures.
        // Include tombstoned rows (deleted_at IS NOT NULL): the unique index
        // `stock_lots_merge_key` covers all rows, so an INSERT would conflict
        // with a surviving tombstone. We revive the tombstone by clearing
        // deleted_at and resetting qty when matched.
        let existingQuery = chefbyte()
          .from('stock_lots')
          .select('lot_id, qty_containers, deleted_at')
          .eq('user_id', user.id)
          .eq('product_id', product.product_id)
          .eq('location_id', locId);
        existingQuery = computedExpiresOn
          ? existingQuery.eq('expires_on', computedExpiresOn)
          : existingQuery.is('expires_on', null);
        const { data: existingLot, error: lookupError } = await existingQuery.maybeSingle();
        if (lookupError) {
          return { undoInfo: undefined, error: `Lot lookup failed: ${lookupError.message}` };
        }

        let newLot: { lot_id: string } | null = null;
        let writeError: string | null = null;
        if (existingLot) {
          // Coerce qty_containers to a number — Postgres NUMERIC can deserialize
          // as a string under some PostgREST configurations and `string + number`
          // would silently concatenate (e.g. "0.000" + 1 = "0.0001"). Even when
          // PostgREST returns numeric we want the explicit Number() so unit
          // tests and integration tests can't drift around the JS coercion rules.
          const isTombstone = (existingLot as any).deleted_at != null;
          const currentQty = Number((existingLot as any).qty_containers) || 0;
          // Revived tombstones: reset qty to the new value rather than
          // adding to the (zeroed) qty, and clear deleted_at.
          const updatePayload: Record<string, unknown> = {
            qty_containers: isTombstone ? qty : currentQty + qty,
          };
          if (isTombstone) updatePayload.deleted_at = null;
          const { data: updated, error: updErr } = await chefbyte()
            .from('stock_lots')
            .update(updatePayload)
            .eq('lot_id', (existingLot as any).lot_id)
            .select('lot_id')
            .single();
          if (updErr) {
            writeError = `Stock merge failed: ${updErr.message}`;
          } else {
            newLot = updated as any;
          }
        } else {
          const insertRow: Record<string, unknown> = {
            user_id: user.id,
            product_id: product.product_id,
            qty_containers: qty,
            location_id: locId,
          };
          if (computedExpiresOn) insertRow.expires_on = computedExpiresOn;
          const { data: inserted, error: insErr } = await chefbyte()
            .from('stock_lots')
            .insert(insertRow)
            .select('lot_id')
            .single();
          if (insErr) {
            writeError = `Stock insert failed: ${insErr.message}`;
          } else {
            newLot = inserted as any;
          }
        }
        // Update product nutrition if changed
        if (nutData.calories || nutData.protein || nutData.carbs || nutData.fat) {
          const { error: nutErr } = await chefbyte()
            .from('products')
            .update({
              calories_per_serving: parseFloat(nutData.calories) || null,
              protein_per_serving: parseFloat(nutData.protein) || null,
              carbs_per_serving: parseFloat(nutData.carbs) || null,
              fat_per_serving: parseFloat(nutData.fat) || null,
              servings_per_container: parseFloat(nutData.servingsPerContainer) || 1,
            })
            .eq('product_id', product.product_id);
          // Don't abort the whole scan on a nutrition write failure (the
          // stock_lot insert above is the load-bearing part), but DO surface
          // it via writeError so the row turns red and the user knows the
          // edited macros didn't actually persist.
          if (nutErr && !writeError) {
            writeError = `Nutrition update failed: ${nutErr.message}`;
          }
        }

        // Invalidate the InventoryPage caches BEFORE returning. Previously
        // this lived at the end of executeAction, after the switch — but the
        // Purchase branch returns inside its case, so the invalidation never
        // ran for the most common scan flow. Result: lot was created in DB
        // but the Inventory tab kept showing the old (zero-stock or absent)
        // state until a manual refresh.
        queryClient.invalidateQueries({ queryKey: queryKeys.stockLots(user.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.products(user.id) });

        return {
          undoInfo: newLot
            ? { type: 'purchase', recordId: (newLot as any).lot_id, purchaseQty: qty, wasNewLot: !existingLot }
            : undefined,
          error: writeError,
        };
      }
      case 'consume_macros': {
        const logicalDate = todayStr(dayStartHour);
        const { error: rpcErr } = await (chefbyte() as any).rpc('consume_product', {
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

        // Find the food_log that was just created (most recent for this product+date).
        // maybeSingle() because the first scan of the day legitimately has no
        // prior row — single() would throw PGRST116 and abort the consume flow.
        const { data: recentLog } = await chefbyte()
          .from('food_logs')
          .select('log_id')
          .eq('user_id', user.id)
          .eq('product_id', product.product_id)
          .eq('logical_date', logicalDate)
          .is('meal_id', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        queryClient.invalidateQueries({ queryKey: queryKeys.stockLots(user.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.products(user.id) });

        return {
          undoInfo: {
            type: 'consume',
            productId: product.product_id,
            locationId: defaultLocId ?? undefined,
            qtyContainers,
            logId: (recentLog as any)?.log_id ?? undefined,
          },
          error: rpcErr ? `Consume failed: ${rpcErr.message}` : null,
        };
      }
      case 'consume_no_macros': {
        const { error: rpcErr } = await (chefbyte() as any).rpc('consume_product', {
          p_product_id: product.product_id,
          p_qty: qty,
          p_unit: unitType,
          p_log_macros: false,
          p_logical_date: todayStr(dayStartHour),
        });

        const cLocId = defaultLocationId;

        const cSpc = product.servings_per_container ?? 1;
        const cQtyContainers = unitType === 'serving' ? qty / Math.max(cSpc, 0.001) : qty;

        queryClient.invalidateQueries({ queryKey: queryKeys.stockLots(user.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.products(user.id) });

        return {
          undoInfo: {
            type: 'consume',
            productId: product.product_id,
            locationId: cLocId ?? undefined,
            qtyContainers: cQtyContainers,
          },
          error: rpcErr ? `Consume failed: ${rpcErr.message}` : null,
        };
      }
      case 'shopping': {
        const { data: newCartItem, error: insErr } = await chefbyte()
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
        return {
          undoInfo: newCartItem ? { type: 'shopping', recordId: (newCartItem as any).cart_item_id } : undefined,
          error: insErr ? `Shopping list insert failed: ${insErr.message}` : null,
        };
      }
    }
    return { undoInfo: undefined, error: null };
  };

  /* ---------------------------------------------------------------- */
  /*  Keypad handler                                                   */
  /* ---------------------------------------------------------------- */

  const handleKeypadClick = (key: string) => {
    // Use the shared `handleKeypadStep` reducer (same code the unit tests
    // cover) and mirror its `overwriteNext` into the ref so rapid-fire
    // presses queued in the same React batch each see the previous press's
    // output — the ref-versus-state distinction is the wrapper's job, the
    // reducer itself is pure.
    const step = (current: string): string | null => {
      const prevState = {
        screenValue: current,
        overwriteNext: overwriteNextRef.current,
      };
      const next = handleKeypadStep(prevState, key);
      if (next === prevState) return null; // double-decimal no-op (same ref)
      overwriteNextRef.current = next.overwriteNext;
      return next.screenValue;
    };

    if (activeField === 'screen') {
      setScreenValue((prev) => {
        const next = step(prev);
        return next ?? prev;
      });
    } else {
      const field = activeField;
      // Mark as user-edited so the pending analyze-product response can't
      // blow this value away when it arrives seconds later.
      userEditedFieldsRef.current.add(field);
      setNutrition((prev) => {
        const current = prev[field] ?? '';
        const next = step(current);
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
                const { error: delErr } = await chefbyte().from('stock_lots').delete().eq('lot_id', info.recordId);
                if (delErr) throw new Error(delErr.message);
              } else {
                // Merged lot — decrement qty by the amount added in this scan
                const { data: lot, error: selErr } = await chefbyte()
                  .from('stock_lots')
                  .select('qty_containers')
                  .eq('lot_id', info.recordId)
                  .maybeSingle();
                if (selErr) throw new Error(selErr.message);
                if (lot) {
                  const newQty = Number((lot as any).qty_containers) - (info.purchaseQty ?? 1);
                  if (newQty <= 0) {
                    const { error: delErr } = await chefbyte().from('stock_lots').delete().eq('lot_id', info.recordId);
                    if (delErr) throw new Error(delErr.message);
                  } else {
                    const { error: updErr } = await chefbyte()
                      .from('stock_lots')
                      .update({ qty_containers: newQty })
                      .eq('lot_id', info.recordId);
                    if (updErr) throw new Error(updErr.message);
                  }
                }
              }
            }
            break;
          case 'consume':
            // Re-add the consumed stock as a new lot
            if (info.productId && info.locationId && info.qtyContainers && user) {
              const { error: insErr } = await chefbyte().from('stock_lots').insert({
                user_id: user.id,
                product_id: info.productId,
                location_id: info.locationId,
                qty_containers: info.qtyContainers,
              });
              if (insErr) throw new Error(insErr.message);
            }
            // Delete the food_log if one was created
            if (info.logId) {
              const { error: delErr } = await chefbyte().from('food_logs').delete().eq('log_id', info.logId);
              if (delErr) throw new Error(delErr.message);
            }
            break;
          case 'shopping':
            // Delete the shopping list item
            if (info.recordId) {
              const { error: delErr } = await chefbyte()
                .from('shopping_list')
                .delete()
                .eq('cart_item_id', info.recordId);
              if (delErr) throw new Error(delErr.message);
            }
            break;
        }
      } catch (err: any) {
        // Undo failed — surface the error so the user knows the mutation
        // wasn't actually reverted. Mark the queue row as errored and KEEP
        // it so the user can retry; previously we silently ate the failure
        // and removed the row, leaving the user thinking the scan was
        // undone when it wasn't.
        setQueue((prev) =>
          prev.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  status: 'error' as const,
                  confirmed: false,
                  errorMsg: `Undo failed: ${err?.message ?? 'unknown error'}`,
                }
              : item,
          ),
        );
        return;
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

  const activeProductId = activeItem?.productId ?? null;

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
    const { error: nameErr } = await chefbyte()
      .from('products')
      .update({ name: trimmed, is_placeholder: false })
      .eq('product_id', activeItem.productId);
    if (nameErr) {
      // Surface the failure on the queue row instead of silently leaving
      // the editor showing the new name while the DB still has the old one.
      // Also un-confirm so the row's bg flips to danger (the bg-color
      // logic at render time is driven by `item.confirmed`).
      const failedItemId = activeItem.id;
      setQueue((prev) =>
        prev.map((item) =>
          item.id === failedItemId
            ? {
                ...item,
                status: 'error' as const,
                confirmed: false,
                errorMsg: `Name save failed: ${nameErr.message}`,
              }
            : item,
        ),
      );
      return;
    }
    // Naming the placeholder upgrades the underlying product row for
    // EVERY queue item pointing at it — not just the row the user clicked.
    // If the user scanned the same new item N times before naming it,
    // all N queue rows must flip from red (unconfirmed placeholder) to
    // green (confirmed) and lose the [!NEW] tag together.
    const upgradedProductId = activeItem.productId;
    setQueue((prev) =>
      prev.map((item) =>
        item.productId === upgradedProductId ? { ...item, name: trimmed, isNew: false, confirmed: true } : item,
      ),
    );
    setNameEdited(false);
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  const queueItemBorderColor = (item: QueueItem) => {
    if (item.status === 'error') return 'border-red-600';
    if (item.status === 'pending') return 'border-amber-500';
    // Border follows the confirmed state so it matches the bg color pair:
    // unconfirmed (still being edited / never touched) = red border + red bg,
    // confirmed (user moved on) = green border + green bg. Old isNew flag no
    // longer drives color — see confirmed logic + the [!NEW] label below.
    return item.confirmed ? 'border-green-600' : 'border-red-600';
  };

  return (
    <ChefLayout title="Scanner">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h1 className="text-2xl font-bold text-text">Scanner</h1>
        <Link
          to="/chef/livetrack-import"
          data-testid="livetrack-import-btn"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white no-underline shadow-sm text-sm font-semibold transition-colors"
        >
          <ScanBarcode className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>LiveTrack Import</span>
        </Link>
      </div>

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
            onFocus={() => {
              setScannerFocused(true);
              // Re-focusing the scanner field is a strong "I noticed and
              // am ready to scan again" signal. Clear any pending dropped-
              // scan toast so the user isn't reading a stale message
              // about a focus-mismatch they've already corrected.
              if (droppedClearTimerRef.current) {
                clearTimeout(droppedClearTimerRef.current);
                droppedClearTimerRef.current = null;
              }
              setDroppedScan(null);
            }}
            onBlur={() => setScannerFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleBarcodeSubmit(e.currentTarget.value);
              }
            }}
            className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
          />

          {/* Scanner-status indicator. Green dot = barcode input has focus
              (hardware scans will be captured normally). Yellow dot =
              focus is elsewhere; any hardware scanner pulse will be
              eaten by the protected-target rule and digits will be
              dropped silently unless the user re-focuses the field.
              The persistent affordance complements the transient
              dropped-scan toast below. */}
          <div
            data-testid="scanner-status-indicator"
            data-scanner-focused={scannerFocused ? 'true' : 'false'}
            role="status"
            aria-live="polite"
            className={`flex items-center gap-2 text-xs px-2 py-1 rounded-md border ${
              scannerFocused
                ? 'border-emerald-300 bg-success-subtle text-emerald-700'
                : 'border-amber-300 bg-amber-50 text-amber-800'
            }`}
          >
            <span
              data-testid="scanner-status-dot"
              aria-hidden="true"
              className={`inline-block w-2 h-2 rounded-full ${scannerFocused ? 'bg-emerald-500' : 'bg-amber-500'}`}
            />
            <span data-testid="scanner-status-text">
              {scannerFocused ? 'Scanner active' : 'Scanner inactive — focus the barcode field'}
            </span>
          </div>

          {/* Dropped-scan toast. Only renders while a recent drop is
              present in state; the auto-clear timer (3 s after the
              latest drop) wipes it out, and re-focusing the scanner
              input also wipes it. Without this surfacing, the
              hardware-scanner-while-focus-elsewhere case looked
              identical to "scanned successfully" from the user's side
              — the exact UX bug we're closing. */}
          {droppedScan && (
            <div
              data-testid="dropped-scan-toast"
              role="alert"
              aria-live="assertive"
              className="text-xs px-2 py-1.5 rounded-md border border-amber-400 bg-amber-100 text-amber-900 font-medium"
            >
              {droppedScan.message}
            </div>
          )}

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
                  // Mark the previously-active item confirmed (green). This
                  // ONLY happens on click-away — scanning a new barcode
                  // leaves the prior item red so the user can come back and
                  // fix it without the scan itself signaling "commit."
                  if (activeItemId && activeItemId !== item.id) {
                    const prev = activeItemId;
                    setQueue((q) => q.map((i) => (i.id === prev ? { ...i, confirmed: true } : i)));
                  }
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
                  {item.mode === 'purchase'
                    ? 'Added to stock'
                    : item.mode === 'shopping'
                      ? 'Added to cart'
                      : 'Consumed'}{' '}
                  {item.quantity} {item.unit === 'container' ? `container${item.quantity === 1 ? '' : 's'}` : item.unit}
                </div>
                {/* errorMsg surfaces the actual reason a row went red.
                    Without this the queue row would say "Added to stock
                    1 container" even when executeAction returned an error
                    like "No location configured" — the row coloring
                    changed but the user had no signal that the side
                    effect (stock_lot insert) didn't actually happen. */}
                {item.status === 'error' && item.errorMsg && (
                  <div
                    data-testid={`item-error-${item.id}`}
                    className="text-[0.8em] text-danger-text mt-0.5 break-words"
                  >
                    {item.errorMsg}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ========================================================== */}
        {/*  RIGHT COLUMN — KEYPAD                                      */}
        {/* ========================================================== */}
        <div data-testid="keypad-panel" className="flex flex-col gap-2.5">
          {/* Mode selector — labels rewritten per the R1 audit (mode-name
              decoding was the single biggest silent-intake-error source).
              Canonical: "Add to stock" (purchase), "I just ate this"
              (consume_macros), "Remove from stock (no macros)"
              (consume_no_macros), "Shopping list" (shopping). The intent-named labels reduce
              the translation step the user does every scan. */}
          <div data-testid="mode-selector" className="grid grid-cols-2 gap-2">
            {(
              [
                { key: 'purchase', label: 'Add to stock' },
                { key: 'consume_macros', label: 'I just ate this' },
                { key: 'consume_no_macros', label: 'Remove from stock (no macros)' },
                { key: 'shopping', label: 'Shopping list' },
              ] as const
            ).map((m) => (
              <button
                key={m.key}
                disabled={!!scannerState?.locked_mode}
                className={`p-2.5 border-2 rounded-lg cursor-pointer w-full flex items-center justify-center text-center leading-tight transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                  mode === m.key
                    ? 'bg-text text-text-inverse border-text font-extrabold text-base ring-2 ring-text/30 ring-offset-1'
                    : 'bg-surface text-text border-border-strong font-semibold text-[15px]'
                }`}
                onClick={() => {
                  // Use the wrapper that fires the debounced cloud push
                  // — every user-driven mode change must broadcast to
                  // chefbyte.scanner_state so other devices (Pi USB
                  // forwarder, second browser tab) stay in sync.
                  handleSetMode(m.key);
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
