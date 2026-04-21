/**
 * LiveTrack Import Wizard (cloud UI)
 *
 * End-to-end: barcode scan → analyze-product → scale reading from Pi →
 * review + save → re-arm for the next item. Pi ↔ cloud over the
 * livetrack_import_sessions row (Pi polls via GET /active; POSTs results
 * via /pi-update). Browser gets live updates via Supabase Realtime filtered
 * on session_id.
 *
 * Intentionally split off from ScannerPage even though ~40% of the product/
 * nutrition logic would be shared. Rationale: ScannerPage already runs four
 * scan modes and inlining the wizard would double its state machine. The
 * save path here is net-new because ScannerPage.executeAction does not write
 * `tare_weight_g` (plan §0 note 11).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useScannerDetection } from '@/hooks/useScannerDetection';
import { useLiveTrackSession } from '@/hooks/useLiveTrackSession';
import {
  createLiveTrackSession,
  isDeviceFresh,
  loadFreshLiveShelfDevice,
  type LiveTrackSession,
} from '@/pages/chefbyte/livetrackSession';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface NutritionData {
  servingsPerContainer: string;
  calories: string;
  carbs: string;
  fat: string;
  protein: string;
}

interface ProductRow {
  product_id: string;
  name: string;
  barcode: string | null;
  servings_per_container: number | null;
  calories_per_serving: number | null;
  carbs_per_serving: number | null;
  fat_per_serving: number | null;
  protein_per_serving: number | null;
  net_weight_g: number | null;
  tare_weight_g: number | null;
  container_type: string | null;
  unit_type: string | null;
}

/** WizardState — owns the UI's derived-from-session state machine. */
type WizardState =
  | { kind: 'idle' }
  | { kind: 'creating_session' }
  | { kind: 'offline'; reason: string }
  | { kind: 'waiting_barcode' }
  | { kind: 'analyzing'; barcode: string }
  | { kind: 'product_loaded'; product: ProductRow; nutrition: NutritionData; isFullContainer: boolean }
  | { kind: 'review'; product: ProductRow; nutrition: NutritionData; tareG: number; tareSource: 'scale' | 'ai' | 'manual' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

type WizardAction =
  | { type: 'start_session' }
  | { type: 'session_ready'; session: LiveTrackSession }
  | { type: 'offline'; reason: string }
  | { type: 'scan'; barcode: string }
  | { type: 'product_loaded'; product: ProductRow; nutrition: NutritionData }
  | { type: 'set_nutrition'; patch: Partial<NutritionData> }
  | { type: 'toggle_full'; isFull: boolean }
  | { type: 'scale_reading'; scaleG: number; netG: number | null }
  | { type: 'ai_ready'; aiG: number }
  | { type: 'manual_tare'; tareG: number; product: ProductRow; nutrition: NutritionData }
  | { type: 'saving' }
  | { type: 'saved_reset' }
  | { type: 'error'; message: string };

function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'start_session':
      return { kind: 'creating_session' };
    case 'session_ready':
      return { kind: 'waiting_barcode' };
    case 'offline':
      return { kind: 'offline', reason: action.reason };
    case 'scan':
      return { kind: 'analyzing', barcode: action.barcode };
    case 'product_loaded':
      return {
        kind: 'product_loaded',
        product: action.product,
        nutrition: action.nutrition,
        isFullContainer: (action.product.net_weight_g ?? null) != null,
      };
    case 'set_nutrition':
      if (state.kind !== 'product_loaded' && state.kind !== 'review') return state;
      return { ...state, nutrition: { ...state.nutrition, ...action.patch } };
    case 'toggle_full':
      if (state.kind !== 'product_loaded') return state;
      return { ...state, isFullContainer: action.isFull };
    case 'scale_reading': {
      if (state.kind !== 'product_loaded') return state;
      if (action.netG == null) {
        // No declared net_weight_g → cannot auto-compute full-container
        // tare. UI will route to manual or AI branch.
        return state;
      }
      const tareG = Math.max(0, action.scaleG - action.netG);
      return {
        kind: 'review',
        product: state.product,
        nutrition: state.nutrition,
        tareG,
        tareSource: 'scale',
      };
    }
    case 'ai_ready': {
      if (state.kind !== 'product_loaded') return state;
      return {
        kind: 'review',
        product: state.product,
        nutrition: state.nutrition,
        tareG: action.aiG,
        tareSource: 'ai',
      };
    }
    case 'manual_tare':
      return {
        kind: 'review',
        product: action.product,
        nutrition: action.nutrition,
        tareG: action.tareG,
        tareSource: 'manual',
      };
    case 'saving':
      return { kind: 'saving' };
    case 'saved_reset':
      return { kind: 'waiting_barcode' };
    case 'error':
      return { kind: 'error', message: action.message };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function LiveTrackImportPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, { kind: 'idle' });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ariaAnnouncement, setAriaAnnouncement] = useState<string>('');

  // Device freshness — drives the offline banner and auto-triggers the
  // /create call once a fresh device is detected.
  const deviceQuery = useQuery({
    queryKey: queryKeys.liveShelfDevice(user?.id ?? ''),
    queryFn: () => loadFreshLiveShelfDevice(user!.id),
    enabled: !!user?.id,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  const device = deviceQuery.data ?? null;
  const deviceOnline = isDeviceFresh(device?.last_heartbeat_ts);

  const { session, patch: patchSession } = useLiveTrackSession(sessionId);

  /* ---- Default location for post-save stock_lot insert ---- */
  const { data: defaultLocationId } = useQuery({
    queryKey: queryKeys.locations(user?.id ?? ''),
    queryFn: async () => {
      const { data } = await chefbyte()
        .from('locations')
        .select('location_id')
        .eq('user_id', user!.id)
        .order('created_at')
        .limit(1);
      return ((data?.[0] as any)?.location_id as string | undefined) ?? null;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  /* ---- Barcode input handling ---- */
  const barcodeRef = useRef<HTMLInputElement>(null);
  const servingsInputRef = useRef<HTMLInputElement>(null);
  const barcodeSubmitRef = useRef<(barcode: string) => void>(() => {});

  useScannerDetection({
    onBarcodeScanned: (barcode) => barcodeSubmitRef.current(barcode),
    protectedInputIds: ['lt-servings', 'lt-calories', 'lt-carbs', 'lt-fat', 'lt-protein'],
  });

  /* ---------------------------------------------------------------- */
  /*  Session lifecycle                                                */
  /* ---------------------------------------------------------------- */

  const createSession = useCallback(async () => {
    dispatch({ type: 'start_session' });
    try {
      const fresh = await createLiveTrackSession();
      setSessionId(fresh.session_id);
      dispatch({ type: 'session_ready', session: fresh });
    } catch (err: any) {
      const status = err?.status ?? 500;
      if (status === 409) {
        dispatch({ type: 'offline', reason: err?.message ?? 'No fresh Pi available' });
      } else {
        dispatch({ type: 'error', message: err?.message ?? 'Could not create session' });
      }
    }
  }, []);

  // Close session on unmount or when the user navigates away. Best-
  // effort; a failed close is fine — the row expires in 10 min.
  useEffect(() => {
    return () => {
      if (sessionId) {
        chefbyte()
          .from('livetrack_import_sessions')
          .update({ state: 'closed', updated_at: new Date().toISOString() })
          .eq('session_id', sessionId)
          .then(() => {})
          .then(undefined, () => {});
      }
    };
  }, [sessionId]);

  /* ---------------------------------------------------------------- */
  /*  Realtime-driven state transitions                                */
  /* ---------------------------------------------------------------- */

  const lastScaleReadingTs = useRef<string | null>(null);
  const lastAiTareTs = useRef<string | null>(null);

  useEffect(() => {
    if (!session) return;
    // Scale reading arrived.
    if (
      session.state === 'scale_reading_received'
      && session.scale_reading_g != null
      && session.scale_reading_ts !== lastScaleReadingTs.current
    ) {
      lastScaleReadingTs.current = session.scale_reading_ts;
      setAriaAnnouncement(`scale reading received: ${Math.round(session.scale_reading_g)} grams`);
      if (state.kind === 'product_loaded' && state.isFullContainer) {
        dispatch({
          type: 'scale_reading',
          scaleG: session.scale_reading_g,
          netG: state.product.net_weight_g,
        });
      }
    }
    // AI tare arrived.
    if (
      session.state === 'ai_tare_ready'
      && session.ai_tare_g != null
      && session.updated_at !== lastAiTareTs.current
    ) {
      lastAiTareTs.current = session.updated_at;
      setAriaAnnouncement(`AI tare ready: ${Math.round(session.ai_tare_g)} grams`);
      if (state.kind === 'product_loaded') {
        dispatch({ type: 'ai_ready', aiG: session.ai_tare_g });
      }
    }
    // Session expired server-side.
    if (session.state === 'expired' && state.kind !== 'error') {
      dispatch({ type: 'error', message: 'Session timed out — start a new session.' });
    }
  }, [session, state]);

  /* ---------------------------------------------------------------- */
  /*  Barcode submit                                                   */
  /* ---------------------------------------------------------------- */

  const handleBarcode = useCallback(
    async (rawBarcode: string) => {
      const barcode = rawBarcode.trim();
      if (!barcode || !user || !sessionId) return;
      dispatch({ type: 'scan', barcode });

      if (barcodeRef.current) {
        barcodeRef.current.value = '';
        barcodeRef.current.focus();
      }

      try {
        // 1. Existing product?
        const { data: existing } = await chefbyte()
          .from('products')
          .select(
            'product_id, name, barcode, servings_per_container, calories_per_serving, carbs_per_serving, fat_per_serving, protein_per_serving, net_weight_g, tare_weight_g, container_type, unit_type',
          )
          .eq('user_id', user.id)
          .eq('barcode', barcode)
          .maybeSingle();

        let product: ProductRow | null = (existing as ProductRow | null) ?? null;

        // 2. analyze-product if needed.
        if (!product) {
          const { data: efData, error: efError } = await supabase.functions.invoke('analyze-product', {
            body: { barcode },
          });
          if (efError) {
            // Hard error — surface to the user. Don't create a placeholder
            // (plan explicitly excludes that mode for the wizard).
            let body: any = null;
            try {
              body = await (efError as any)?.context?.json?.();
            } catch {
              body = null;
            }
            const msg = body?.error ?? efError.message ?? 'analyze-product failed';
            dispatch({ type: 'error', message: msg });
            return;
          }
          const s = efData?.suggestion;
          const off = efData?.off;
          const name = s?.name || off?.product_name || `Product (${barcode})`;
          const productFields = {
            barcode,
            name,
            description: s?.description ?? null,
            is_placeholder: false,
            servings_per_container: s?.servings_per_container ?? 1,
            calories_per_serving: s?.calories_per_serving ?? null,
            carbs_per_serving: s?.carbs_per_serving ?? null,
            fat_per_serving: s?.fat_per_serving ?? null,
            protein_per_serving: s?.protein_per_serving ?? null,
            default_shelf_life_days: s?.default_shelf_life_days ?? null,
            net_weight_g: off?.product_quantity ?? null,
            container_type: null,
            unit_type: null,
          };
          const { data: created, error: insErr } = await chefbyte()
            .from('products')
            .insert({ user_id: user.id, ...productFields })
            .select(
              'product_id, name, barcode, servings_per_container, calories_per_serving, carbs_per_serving, fat_per_serving, protein_per_serving, net_weight_g, tare_weight_g, container_type, unit_type',
            )
            .single();
          if (insErr || !created) {
            dispatch({ type: 'error', message: insErr?.message ?? 'insert failed' });
            return;
          }
          product = created as ProductRow;
        }

        // 3. Patch the session with barcode + product_id + state=waiting_scale.
        await patchSession({
          current_barcode: barcode,
          current_product_id: product.product_id,
          state: 'waiting_scale',
        });

        const nut: NutritionData = {
          servingsPerContainer: String(product.servings_per_container ?? 1),
          calories: String(product.calories_per_serving ?? ''),
          carbs: String(product.carbs_per_serving ?? ''),
          fat: String(product.fat_per_serving ?? ''),
          protein: String(product.protein_per_serving ?? ''),
        };
        dispatch({ type: 'product_loaded', product, nutrition: nut });

        // Auto-focus servingsPerContainer on analyze-product completion
        // (plan §9 + §0 note). The AI value for servings_per_container is
        // wrong more often than the macros, so the keyboard should start
        // there.
        queueMicrotask(() => servingsInputRef.current?.focus());
      } catch (err: any) {
        dispatch({ type: 'error', message: err?.message ?? 'Unknown error' });
      }
    },
    [sessionId, user, patchSession],
  );
  barcodeSubmitRef.current = handleBarcode;

  /* ---------------------------------------------------------------- */
  /*  AI-tare request                                                  */
  /* ---------------------------------------------------------------- */

  const requestAiTare = useCallback(async () => {
    if (state.kind !== 'product_loaded' || !session) return;
    await patchSession({
      state: 'awaiting_ai_tare',
      ai_tare_product_form: {
        name: state.product.name,
        net_weight_g: state.product.net_weight_g,
        container_type: state.product.container_type,
        unit_type: state.product.unit_type,
        servings_per_container: state.product.servings_per_container,
      },
    });
  }, [state, session, patchSession]);

  /* ---------------------------------------------------------------- */
  /*  Manual tare (offline branch or partial container override)       */
  /* ---------------------------------------------------------------- */

  const [manualTareInput, setManualTareInput] = useState('');
  const applyManualTare = useCallback(() => {
    if (state.kind !== 'product_loaded') return;
    const tareG = Number(manualTareInput);
    if (!Number.isFinite(tareG) || tareG < 0) return;
    dispatch({ type: 'manual_tare', tareG, product: state.product, nutrition: state.nutrition });
    setManualTareInput('');
  }, [manualTareInput, state]);

  /* ---------------------------------------------------------------- */
  /*  Save + re-arm                                                    */
  /* ---------------------------------------------------------------- */

  const doSave = useCallback(async () => {
    if (state.kind !== 'review' || !user || !sessionId) return;
    dispatch({ type: 'saving' });
    try {
      const { product, nutrition, tareG } = state;

      // Net-new: write tare_weight_g + refreshed macros to products. This
      // column is NOT updated by ScannerPage.executeAction, so the wizard
      // is additive (plan §0 note 11).
      const { error: prodUpdErr } = await chefbyte()
        .from('products')
        .update({
          tare_weight_g: Number.isFinite(tareG) ? tareG : null,
          servings_per_container: parseFloat(nutrition.servingsPerContainer) || 1,
          calories_per_serving: parseFloat(nutrition.calories) || null,
          carbs_per_serving: parseFloat(nutrition.carbs) || null,
          fat_per_serving: parseFloat(nutrition.fat) || null,
          protein_per_serving: parseFloat(nutrition.protein) || null,
        })
        .eq('product_id', product.product_id)
        .eq('user_id', user.id);
      if (prodUpdErr) throw new Error(prodUpdErr.message);

      // Optional stock_lot insert — only when we have a location. The lot
      // represents one freshly-placed container on the shelf.
      if (defaultLocationId) {
        await chefbyte()
          .from('stock_lots')
          .insert({
            user_id: user.id,
            product_id: product.product_id,
            location_id: defaultLocationId,
            qty_containers: 1,
            last_update_source: 'manual',
            last_update_ts: new Date().toISOString(),
          });
      }

      // Re-arm: clear Pi-written fields and flip state back.
      await patchSession({
        state: 'waiting_barcode',
        current_barcode: null,
        current_product_id: null,
        scale_reading_g: null,
        scale_reading_ts: null,
        ai_tare_g: null,
        ai_tare_confidence: null,
        ai_tare_reasoning: null,
        ai_tare_product_form: null,
        last_error: null,
      });

      // Refresh product + stock caches so Inventory shows the new lot.
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.stockLots(user.id) });

      dispatch({ type: 'saved_reset' });
    } catch (err: any) {
      dispatch({ type: 'error', message: err?.message ?? 'Save failed' });
    }
  }, [state, user, sessionId, defaultLocationId, patchSession, queryClient]);

  /* ---------------------------------------------------------------- */
  /*  Auto-create session on first mount when device is fresh          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (state.kind !== 'idle') return;
    if (!user) return;
    if (!deviceQuery.isFetched) return;
    if (!device || !deviceOnline) {
      dispatch({ type: 'offline', reason: device ? 'Pi heartbeat is stale' : 'No Pi paired' });
      return;
    }
    createSession();
  }, [state.kind, user, device, deviceOnline, deviceQuery.isFetched, createSession]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  const heartbeatAge = useMemo(() => {
    if (!device?.last_heartbeat_ts) return null;
    const secs = Math.round((Date.now() - new Date(device.last_heartbeat_ts).getTime()) / 1000);
    return secs;
  }, [device]);

  return (
    <ChefLayout title="LiveTrack Import">
      <div className="max-w-3xl mx-auto p-4 space-y-4" data-testid="livetrack-page">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">LiveTrack Import Wizard</h2>
          <div
            className="text-sm"
            data-testid="livetrack-device-status"
            role="status"
            aria-live="polite"
          >
            {device
              ? deviceOnline
                ? `Pi: ${device.device_name} (online, last hb ${heartbeatAge ?? '?'}s ago)`
                : `Pi: ${device.device_name} (offline — last hb ${heartbeatAge ?? '?'}s ago)`
              : 'No Pi paired'}
          </div>
        </div>

        {/* aria-live for scale-reading announcements */}
        <div className="sr-only" aria-live="polite" data-testid="livetrack-aria">{ariaAnnouncement}</div>

        {state.kind === 'idle' && (
          <p className="text-slate-500">Starting…</p>
        )}

        {state.kind === 'creating_session' && (
          <p className="text-slate-500" data-testid="livetrack-creating">Creating session…</p>
        )}

        {state.kind === 'offline' && (
          <section className="rounded-md border border-amber-300 bg-amber-50 p-4 space-y-3" data-testid="livetrack-offline">
            <h3 className="font-semibold text-amber-900">Pi offline</h3>
            <p className="text-sm text-amber-800">{state.reason}. Scale reading disabled; manual tare entry still works.</p>
            <button
              type="button"
              onClick={createSession}
              className="rounded bg-slate-200 px-3 py-1 text-sm"
              data-testid="livetrack-retry-session"
            >
              Retry
            </button>
          </section>
        )}

        {state.kind === 'waiting_barcode' && (
          <section className="rounded-md border border-slate-200 p-4 space-y-3" data-testid="livetrack-waiting-barcode">
            <p className="text-sm text-slate-700">Scan a barcode to begin.</p>
            <input
              ref={barcodeRef}
              id="lt-barcode"
              className="w-full rounded border border-slate-300 px-3 py-2 font-mono"
              placeholder="Scan or type barcode"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const value = (e.target as HTMLInputElement).value;
                  handleBarcode(value);
                }
              }}
              data-testid="livetrack-barcode-input"
            />
          </section>
        )}

        {state.kind === 'analyzing' && (
          <p className="text-slate-500" data-testid="livetrack-analyzing">Analyzing barcode {state.barcode}…</p>
        )}

        {state.kind === 'product_loaded' && (
          <ProductEditor
            state={state}
            servingsInputRef={servingsInputRef}
            onNutritionChange={(patch) => dispatch({ type: 'set_nutrition', patch })}
            onToggleFull={(isFull) => dispatch({ type: 'toggle_full', isFull })}
            onRequestAiTare={requestAiTare}
            manualTareInput={manualTareInput}
            onManualTareChange={setManualTareInput}
            onApplyManualTare={applyManualTare}
            piOnline={deviceOnline}
          />
        )}

        {state.kind === 'review' && (
          <ReviewPanel
            state={state}
            onSave={doSave}
            onBack={() => dispatch({ type: 'saved_reset' })}
          />
        )}

        {state.kind === 'saving' && (
          <p className="text-slate-500" data-testid="livetrack-saving">Saving…</p>
        )}

        {state.kind === 'error' && (
          <section
            className="rounded-md border border-red-300 bg-red-50 p-4 space-y-3"
            data-testid="livetrack-error"
          >
            <p className="text-red-800">{state.message}</p>
            <button
              type="button"
              onClick={() => setSessionId(null)}
              className="rounded bg-slate-200 px-3 py-1 text-sm"
              data-testid="livetrack-error-reset"
            >
              Start over
            </button>
          </section>
        )}
      </div>
    </ChefLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

interface ProductEditorProps {
  state: Extract<WizardState, { kind: 'product_loaded' }>;
  servingsInputRef: React.RefObject<HTMLInputElement>;
  onNutritionChange: (patch: Partial<NutritionData>) => void;
  onToggleFull: (isFull: boolean) => void;
  onRequestAiTare: () => void;
  manualTareInput: string;
  onManualTareChange: (v: string) => void;
  onApplyManualTare: () => void;
  piOnline: boolean;
}

function ProductEditor({
  state,
  servingsInputRef,
  onNutritionChange,
  onToggleFull,
  onRequestAiTare,
  manualTareInput,
  onManualTareChange,
  onApplyManualTare,
  piOnline,
}: ProductEditorProps) {
  const { product, nutrition, isFullContainer } = state;
  const hasNet = (product.net_weight_g ?? null) != null;

  return (
    <section className="rounded-md border border-slate-200 p-4 space-y-4" data-testid="livetrack-product-loaded">
      <header>
        <h3 className="font-semibold text-lg">{product.name}</h3>
        {product.barcode ? (
          <p className="text-xs text-slate-500 font-mono">{product.barcode}</p>
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-2">
        <Field id="lt-servings" label="Srv/Ctn" value={nutrition.servingsPerContainer} inputRef={servingsInputRef} onChange={(v) => onNutritionChange({ servingsPerContainer: v })} />
        <Field id="lt-calories" label="Calories" value={nutrition.calories} onChange={(v) => onNutritionChange({ calories: v })} />
        <Field id="lt-carbs" label="Carbs" value={nutrition.carbs} onChange={(v) => onNutritionChange({ carbs: v })} />
        <Field id="lt-fat" label="Fat" value={nutrition.fat} onChange={(v) => onNutritionChange({ fat: v })} />
        <Field id="lt-protein" label="Protein" value={nutrition.protein} onChange={(v) => onNutritionChange({ protein: v })} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Container state</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="container-state"
            checked={isFullContainer && hasNet}
            onChange={() => onToggleFull(true)}
            disabled={!hasNet}
            data-testid="livetrack-full-radio"
          />
          <span>
            Full + sealed
            {!hasNet ? (
              <span className="text-xs text-slate-500"> (unavailable — no net weight on file)</span>
            ) : null}
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="container-state"
            checked={!isFullContainer || !hasNet}
            onChange={() => onToggleFull(false)}
            data-testid="livetrack-partial-radio"
          />
          <span>Partial / opened</span>
        </label>
      </fieldset>

      {isFullContainer && hasNet ? (
        <p className="rounded bg-slate-50 p-3 text-sm text-slate-700" data-testid="livetrack-waiting-scale-hint">
          Place container on the catch-all scale. Tare will auto-compute from
          {' '}
          {product.net_weight_g}g net.
        </p>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={onRequestAiTare}
            disabled={!piOnline}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            data-testid="livetrack-ai-tare-btn"
          >
            {piOnline ? 'Request AI tare from Pi' : 'Pi offline — AI tare unavailable'}
          </button>
          <label className="block text-sm">
            Or enter tare manually (g):
            <input
              type="number"
              min={0}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
              value={manualTareInput}
              onChange={(e) => onManualTareChange(e.target.value)}
              data-testid="livetrack-manual-tare-input"
            />
          </label>
          <button
            type="button"
            onClick={onApplyManualTare}
            disabled={!manualTareInput}
            className="rounded bg-slate-800 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            data-testid="livetrack-manual-tare-apply"
          >
            Apply manual tare
          </button>
        </div>
      )}
    </section>
  );
}

interface ReviewPanelProps {
  state: Extract<WizardState, { kind: 'review' }>;
  onSave: () => void;
  onBack: () => void;
}

function ReviewPanel({ state, onSave, onBack }: ReviewPanelProps) {
  return (
    <section className="rounded-md border border-green-300 bg-green-50 p-4 space-y-3" data-testid="livetrack-review">
      <h3 className="font-semibold text-green-900">Review & save</h3>
      <p className="text-sm text-green-900">
        Tare: <strong data-testid="livetrack-tare-g">{state.tareG.toFixed(1)} g</strong>
        {' '}from{' '}
        <span data-testid="livetrack-tare-source">{state.tareSource}</span>
      </p>
      <p className="text-sm text-green-900">Product: {state.product.name}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          className="rounded bg-green-700 px-4 py-2 text-sm font-medium text-white"
          data-testid="livetrack-next-btn"
        >
          Next (save + re-arm)
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded bg-slate-200 px-4 py-2 text-sm"
          data-testid="livetrack-back-btn"
        >
          Back
        </button>
      </div>
    </section>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputRef?: React.RefObject<HTMLInputElement>;
}

function Field({ id, label, value, onChange, inputRef }: FieldProps) {
  return (
    <label className="text-sm">
      <span className="block text-slate-500 text-xs">{label}</span>
      <input
        id={id}
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="w-full rounded border border-slate-300 px-2 py-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`livetrack-field-${label.toLowerCase().replace(/[^a-z]/g, '')}`}
      />
    </label>
  );
}
