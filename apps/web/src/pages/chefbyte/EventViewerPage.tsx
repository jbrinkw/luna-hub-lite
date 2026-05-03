/**
 * EventViewerPage (`/chef/events`)
 *
 * Lists Pi-emitted classifier events (from ``chefbyte.shelf_event_log``)
 * LEFT JOIN'd to ``chefbyte.event_overrides`` so the UI can render the
 * current override state. Also surfaces two failure modes that used to be
 * silent:
 *
 *   - applied=false rows (shelf-ingest RPC rejected the event) render an
 *     amber "Needs action" pill and a reason-specific action button
 *     (Configure pairing / Edit product weight / Add stock / Retry).
 *   - classifier_status='review' rows (Pi classifier < threshold) render
 *     a dedicated expanded edit panel with Accept-classifier-pick /
 *     Choose-different-product / Void actions, and any multi_match
 *     alternatives from the classification JSON become one-click buttons.
 *
 * Filter toggle at the top: All / Applied / Needs Review / Voided.
 *
 * Images are loaded from http://<lan_ip>:8000/event/<pi_event_id>/before.jpg
 * — zero cloud storage cost. If any image 404s or times out we flip a
 * banner to "Pi offline — images unavailable". On-LAN only; out-of-LAN
 * users get the same banner.
 *
 * Realtime: subscribes to chefbyte.event_overrides + shelf_event_log
 * postgres_changes and invalidates the events query keys so edits in
 * another tab + Pi retries show up live.
 */

import { useState, useMemo, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronUp,
  Ban,
  Check,
  ImageOff,
  RotateCcw,
  Pencil,
  AlertTriangle,
  HelpCircle,
} from 'lucide-react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { Alert } from '@/components/ui/Alert';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { queryKeys } from '@/shared/queryKeys';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type EventKind = 'consumed' | 'depleted' | 'added' | 'refilled';
const EVENT_KINDS: EventKind[] = ['consumed', 'depleted', 'added', 'refilled'];

type ClassifierStatus = 'pending' | 'classifying' | 'classified' | 'review' | 'failed';

interface EventRow {
  event_id: string;
  client_event_id: string;
  pi_event_id: string | null;
  applied: boolean;
  reason: string | null;
  created_at: string;
  classifier_status: ClassifierStatus | null;
  classification: {
    item_id?: string;
    confidence?: number;
    multi_match?: Array<{ item_id: string; label?: string; confidence?: number }>;
  } | null;
  payload: {
    scale_id?: string;
    kind?: string;
    event_kind?: string;
    product_id?: string;
    delta_g?: number;
    occurred_at?: string;
  } | null;
  /** HTTPS URL in Supabase Storage. Null until Pi uploads the image. */
  before_image_url: string | null;
  /** HTTPS URL in Supabase Storage. Null until Pi uploads the image. */
  after_image_url: string | null;
}

interface OverrideRow {
  override_id: string;
  client_event_id: string;
  stock_qty_override: number | null;
  macros_servings_override: number | null;
  calories_override: number | null;
  protein_override: number | null;
  carbs_override: number | null;
  fat_override: number | null;
  macro_logging_enabled: boolean;
  is_voided: boolean;
  event_kind_override: string | null;
  updated_at: string;
}

interface ProductLite {
  product_id: string;
  name: string;
  net_weight_g: number | null;
  servings_per_container: number | null;
  calories_per_serving: number | null;
  carbs_per_serving: number | null;
  protein_per_serving: number | null;
  fat_per_serving: number | null;
}

interface DeviceLite {
  device_id: string;
  lan_ip: string | null;
  last_heartbeat_ts: string | null;
}

type RangeFilter = 'today' | 'week' | 'all';
export type StatusFilter = 'all' | 'applied' | 'review' | 'voided';

/* ------------------------------------------------------------------ */
/*  Range helpers (exported for tests)                                 */
/* ------------------------------------------------------------------ */

export function rangeCutoff(range: RangeFilter, now: Date = new Date()): string | null {
  if (range === 'all') return null;
  const d = new Date(now);
  if (range === 'today') {
    d.setHours(0, 0, 0, 0);
  } else {
    d.setDate(d.getDate() - 7);
  }
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/*  Reason → retry action mapping                                      */
/* ------------------------------------------------------------------ */

export type RetryAction =
  | { kind: 'configure_pairing'; label: string }
  | { kind: 'edit_product_weight'; label: string; productId: string | null }
  | { kind: 'add_stock'; label: string; productId: string | null }
  | { kind: 'retry'; label: string };

/**
 * Map a shelf-ingest rejection reason to the user-facing action. Pure for
 * easy testing. The reason strings are the exact ones emitted by
 * private.apply_shelf_event (scale not paired / scale paired but product
 * unset / product missing net_weight_g / no lot with stock to decrement).
 */
export function retryActionForReason(reason: string | null, productId: string | null): RetryAction {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('scale not paired') || r.includes('scale paired but product unset')) {
    return { kind: 'configure_pairing', label: 'Configure pairing' };
  }
  if (r.includes('product missing net_weight_g') || r.includes('net_weight_g')) {
    return { kind: 'edit_product_weight', label: 'Edit product weight', productId };
  }
  if (r.includes('no lot') || r.includes('lot with stock')) {
    return { kind: 'add_stock', label: 'Add stock', productId };
  }
  return { kind: 'retry', label: 'Retry' };
}

/* ------------------------------------------------------------------ */
/*  Derived row view model                                              */
/* ------------------------------------------------------------------ */

interface EventView {
  event: EventRow;
  override: OverrideRow | null;
  product: ProductLite | null;
  effectiveKind: EventKind;
  effectiveServings: number;
  effectiveCalories: number;
  effectiveProtein: number;
  effectiveCarbs: number;
  effectiveFat: number;
  effectiveStockDeltaContainers: number;
  isVoided: boolean;
  macroLoggingEnabled: boolean;
  hasEdit: boolean;
  needsReview: boolean;
  needsAction: boolean;
  retryAction: RetryAction | null;
}

function deriveEventView(event: EventRow, override: OverrideRow | null, product: ProductLite | null): EventView {
  const payload = event.payload ?? {};
  const deltaG = Number(payload.delta_g ?? 0);
  const piKindRaw = payload.event_kind ?? 'consumed';
  const piKind: EventKind = (EVENT_KINDS as string[]).includes(piKindRaw) ? (piKindRaw as EventKind) : 'consumed';
  const netG = product?.net_weight_g ?? null;
  const svgPer = product?.servings_per_container ?? 0;

  const effectiveKind: EventKind = (override?.event_kind_override as EventKind | null | undefined) ?? piKind;

  const magnitudeC = netG && netG > 0 ? Math.abs(deltaG / netG) : 0;
  const signedByKindC = effectiveKind === 'consumed' || effectiveKind === 'depleted' ? -magnitudeC : +magnitudeC;

  const overrideServings = override?.macros_servings_override ?? null;
  const overrideStockC = override?.stock_qty_override ?? null;
  const isVoided = Boolean(override?.is_voided);
  const macroLoggingEnabled = override?.macro_logging_enabled ?? true;

  const effectiveStockDeltaContainers = isVoided ? 0 : (overrideStockC ?? signedByKindC);

  const isConsumptionKind = effectiveKind === 'consumed' || effectiveKind === 'depleted';
  const effectiveServings =
    isVoided || !macroLoggingEnabled || !isConsumptionKind
      ? 0
      : (overrideServings ?? Math.abs(effectiveStockDeltaContainers) * svgPer);
  const perServingCal = product?.calories_per_serving ?? 0;
  const perServingP = product?.protein_per_serving ?? 0;
  const perServingC = product?.carbs_per_serving ?? 0;
  const perServingF = product?.fat_per_serving ?? 0;

  const effectiveCalories = override?.calories_override ?? effectiveServings * perServingCal;
  const effectiveProtein = override?.protein_override ?? effectiveServings * perServingP;
  const effectiveCarbs = override?.carbs_override ?? effectiveServings * perServingC;
  const effectiveFat = override?.fat_override ?? effectiveServings * perServingF;

  const hasEdit = Boolean(
    override &&
    (override.stock_qty_override !== null ||
      override.macros_servings_override !== null ||
      override.calories_override !== null ||
      override.protein_override !== null ||
      override.carbs_override !== null ||
      override.fat_override !== null ||
      override.event_kind_override !== null ||
      override.is_voided ||
      !override.macro_logging_enabled),
  );

  const needsReview = event.classifier_status === 'review' && !isVoided;
  const needsAction = !event.applied && !isVoided;
  const retryAction = needsAction ? retryActionForReason(event.reason, payload.product_id ?? null) : null;

  return {
    event,
    override,
    product,
    effectiveKind,
    effectiveServings,
    effectiveCalories,
    effectiveProtein,
    effectiveCarbs,
    effectiveFat,
    effectiveStockDeltaContainers,
    isVoided,
    macroLoggingEnabled,
    hasEdit,
    needsReview,
    needsAction,
    retryAction,
  };
}

/* ================================================================== */
/*  EventViewerPage                                                    */
/* ================================================================== */

/**
 * `embedded` skips the ChefLayout wrapper so callers can mount the Events
 * UI inside another page (e.g. SettingsPage's "Events" sub-tab). The
 * standalone `/chef/events` route still defaults to embedded=false and
 * renders the full layout.
 */
export function EventViewerPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Default to 'all' so the count rendered in the ChefLayout tab badge
  // (which itself has no range filter) matches what users see when they
  // click into the page. Previously defaulted to 'week', which silently
  // hid every event older than 7 days even when the badge advertised
  // hundreds — clicking the tab landed users on an empty page.
  const [range, setRange] = useState<RangeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [piOffline, setPiOffline] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const eventsKey = ['event-viewer-events', user!.id, range] as const;
  const overridesKey = ['event-viewer-overrides', user!.id] as const;
  const productsKey = ['event-viewer-products', user!.id] as const;
  const devicesKey = ['event-viewer-devices', user!.id] as const;

  /* ---- Events ---- */
  const {
    data: events = [],
    isLoading: eventsLoading,
    error: eventsErr,
  } = useQuery({
    queryKey: eventsKey,
    queryFn: async () => {
      let q = chefbyte()
        .from('shelf_event_log')
        .select(
          'event_id,client_event_id,pi_event_id,applied,reason,created_at,classifier_status,classification,payload,before_image_url,after_image_url',
        )
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(200);
      const cutoff = rangeCutoff(range);
      if (cutoff) q = q.gte('created_at', cutoff);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as EventRow[];
    },
    enabled: !!user,
    staleTime: 30_000,
  });

  const { data: overrides = [] } = useQuery({
    queryKey: overridesKey,
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('event_overrides')
        .select(
          'override_id,client_event_id,stock_qty_override,macros_servings_override,calories_override,protein_override,carbs_override,fat_override,macro_logging_enabled,is_voided,event_kind_override,updated_at',
        )
        .eq('user_id', user!.id);
      if (error) throw error;
      return (data ?? []) as OverrideRow[];
    },
    enabled: !!user,
    staleTime: 30_000,
  });

  const { data: products = [] } = useQuery({
    queryKey: productsKey,
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('products')
        .select(
          'product_id,name,net_weight_g,servings_per_container,calories_per_serving,carbs_per_serving,protein_per_serving,fat_per_serving',
        )
        .eq('user_id', user!.id);
      if (error) throw error;
      return (data ?? []) as ProductLite[];
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });

  const { data: devices = [] } = useQuery({
    queryKey: devicesKey,
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('live_shelf_devices')
        .select('device_id,lan_ip,last_heartbeat_ts')
        .eq('user_id', user!.id);
      if (error) throw error;
      return (data ?? []) as DeviceLite[];
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  // Per-product measured-state lookup driving the "Item is full" checkbox
  // in the editor panel. Separate from the products list above because:
  //   1. The full products query selects only macro/weight columns; this
  //      query also surfaces measured_full_at + tare_weight_g.
  //   2. The set-once stamp mutation invalidates this key so the checkbox
  //      flips checked + disabled immediately after a successful write.
  const productStatesKey = queryKeys.productMeasuredStates(user!.id);
  const { data: productStates = {} } = useQuery({
    queryKey: productStatesKey,
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('products')
        .select('product_id, tare_weight_g, measured_full_at')
        .eq('user_id', user!.id);
      if (error) throw error;
      return Object.fromEntries(
        (
          (data ?? []) as Array<{ product_id: string; tare_weight_g: number | null; measured_full_at: string | null }>
        ).map((p) => [p.product_id, p]),
      );
    },
    enabled: !!user,
    staleTime: 30_000,
  });

  useRealtimeInvalidation('event-viewer', [
    { schema: 'chefbyte', table: 'event_overrides', queryKeys: [overridesKey] },
    { schema: 'chefbyte', table: 'shelf_event_log', queryKeys: [eventsKey] },
    // products is read into productsById and rendered as the per-event
    // name + macros. Without this, a Settings rename or AI-analyzer
    // macro update doesn't reflect on the events list until refresh.
    { schema: 'chefbyte', table: 'products', queryKeys: [productsKey] },
    // live_shelf_devices supplies the LAN IP used to resolve
    // before/after image URLs. Heartbeat-update or new device pair
    // means a different IP — refresh is required without this sub.
    { schema: 'chefbyte', table: 'live_shelf_devices', queryKeys: [devicesKey] },
  ]);

  /* ---- Merge ---- */
  const overridesByClient = useMemo(() => {
    const map: Record<string, OverrideRow> = {};
    for (const o of overrides) map[o.client_event_id] = o;
    return map;
  }, [overrides]);

  const productsById = useMemo(() => {
    const map: Record<string, ProductLite> = {};
    for (const p of products) map[p.product_id] = p;
    return map;
  }, [products]);

  const allRows: EventView[] = useMemo(
    () =>
      events.map((ev: EventRow) =>
        deriveEventView(
          ev,
          overridesByClient[ev.client_event_id] ?? null,
          ev.payload?.product_id ? (productsById[ev.payload.product_id] ?? null) : null,
        ),
      ),
    [events, overridesByClient, productsById],
  );

  const rows: EventView[] = useMemo(() => {
    switch (statusFilter) {
      case 'applied':
        return allRows.filter((r) => r.event.applied && !r.isVoided && !r.needsReview);
      case 'review':
        return allRows.filter((r) => r.needsReview);
      case 'voided':
        return allRows.filter((r) => r.isVoided);
      case 'all':
      default:
        return allRows;
    }
  }, [allRows, statusFilter]);

  /* ---- Pi LAN IP ---- */
  const lanIp = useMemo(() => {
    const fresh = [...devices]
      .filter((d) => d.lan_ip && d.lan_ip.trim() !== '')
      .sort((a, b) => {
        const ta = a.last_heartbeat_ts ? new Date(a.last_heartbeat_ts).getTime() : 0;
        const tb = b.last_heartbeat_ts ? new Date(b.last_heartbeat_ts).getTime() : 0;
        return tb - ta;
      });
    return fresh[0]?.lan_ip ?? null;
  }, [devices]);

  /* ---- Mutations ---- */
  const applyOverride = useMutation({
    mutationFn: async (args: {
      clientEventId: string;
      stockQty?: number | null;
      servings?: number | null;
      calories?: number | null;
      protein?: number | null;
      carbs?: number | null;
      fat?: number | null;
      macroLoggingEnabled?: boolean;
      isVoided?: boolean;
      eventKind?: EventKind | null;
      classifierOverrideItemId?: string | null;
    }) => {
      const { data, error } = await (supabase as any).schema('chefbyte').rpc('apply_event_override', {
        p_client_event_id: args.clientEventId,
        p_stock_qty_override: args.stockQty ?? null,
        p_macros_servings_override: args.servings ?? null,
        p_calories_override: args.calories ?? null,
        p_protein_override: args.protein ?? null,
        p_carbs_override: args.carbs ?? null,
        p_fat_override: args.fat ?? null,
        p_macro_logging_enabled: args.macroLoggingEnabled ?? true,
        p_is_voided: args.isVoided ?? false,
        p_event_kind: args.eventKind ?? null,
        p_classifier_override_item_id: args.classifierOverrideItemId ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: overridesKey });
      queryClient.invalidateQueries({ queryKey: eventsKey });
      queryClient.invalidateQueries({ queryKey: ['daily-macros', user!.id] });
      queryClient.invalidateQueries({ queryKey: ['stock-lots', user!.id] });
      queryClient.invalidateQueries({ queryKey: ['chef-events-attention', user!.id] });
    },
    onError: (e: any) => {
      setErrorMsg(e?.message ?? 'Failed to save override');
    },
  });

  const retryEvent = useMutation({
    mutationFn: async (clientEventId: string) => {
      const { data, error } = await (supabase as any).schema('chefbyte').rpc('retry_shelf_event', {
        p_client_event_id: clientEventId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: eventsKey });
      queryClient.invalidateQueries({ queryKey: ['chef-events-attention', user!.id] });
      queryClient.invalidateQueries({ queryKey: ['stock-lots', user!.id] });
    },
    onError: (e: any) => {
      setErrorMsg(e?.message ?? 'Retry failed');
    },
  });

  // Manual fallback for the catch-all auto-import: when the AI estimate of
  // net_weight_g is off, the user can mark a fresh container as "full"
  // here and the cloud locks measured_full_at on the product. Set-once is
  // enforced at THREE layers — Pi guard, edge-function guard, AND the
  // `.is('measured_full_at', null)` filter below — so re-runs are no-ops.
  const stampMeasuredFullMutation = useMutation({
    mutationFn: async (vars: { product_id: string; measured_full_at: string }) => {
      const { error } = await chefbyte()
        .from('products')
        .update({ measured_full_at: vars.measured_full_at })
        .eq('product_id', vars.product_id)
        .eq('user_id', user!.id)
        .is('measured_full_at', null);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: productStatesKey });
      // Inventory tag color (Task 11) reads from the products query — refresh
      // it so the blue "needs measurement" tag flips to green immediately.
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
      queryClient.invalidateQueries({ queryKey: productsKey });
    },
    onError: (e: any) => {
      setErrorMsg(e?.message ?? 'Failed to stamp item-is-full');
    },
  });

  /* ---- Retry action router ---- */
  const handleRetryAction = (row: EventView) => {
    const action = row.retryAction;
    if (!action) return;
    switch (action.kind) {
      case 'configure_pairing':
        navigate('/chef/settings?tab=scales');
        return;
      case 'edit_product_weight':
        if (action.productId) {
          navigate(`/chef/settings?tab=products&product=${action.productId}`);
        } else {
          navigate('/chef/settings?tab=products');
        }
        return;
      case 'add_stock':
        if (action.productId) {
          navigate(`/chef/scanner?mode=purchase&product=${action.productId}`);
        } else {
          navigate('/chef/scanner?mode=purchase');
        }
        return;
      case 'retry':
        retryEvent.mutate(row.event.client_event_id);
        return;
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'applied', label: 'Applied' },
    { id: 'review', label: 'Needs Review' },
    { id: 'voided', label: 'Voided' },
  ];

  const attentionCount = useMemo(() => allRows.filter((r) => r.needsAction || r.needsReview).length, [allRows]);

  const content = (
    <div className="space-y-4" data-testid="event-viewer-page">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-text">Event Viewer</h1>
          {attentionCount > 0 && (
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full bg-warning-subtle text-warning-text"
              data-testid="attention-count"
            >
              {attentionCount} need attention
            </span>
          )}
        </div>
        <div className="flex items-center gap-2" role="tablist" aria-label="Range filter">
          {(['today', 'week', 'all'] as RangeFilter[]).map((r) => (
            <button
              key={r}
              data-testid={`range-${r}`}
              onClick={() => setRange(r)}
              className={[
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                range === r
                  ? 'bg-chef-accent text-white shadow-inner'
                  : 'bg-surface text-text-secondary border border-border hover:bg-surface-hover',
              ].join(' ')}
              aria-pressed={range === r}
            >
              {r === 'today' ? 'Today' : r === 'week' ? 'This week' : 'All time'}
            </button>
          ))}
        </div>
      </header>

      {/* Status filter */}
      <div
        className="flex items-center gap-2 flex-wrap"
        role="tablist"
        aria-label="Status filter"
        data-testid="status-filter"
      >
        {STATUS_FILTERS.map((s) => (
          <button
            key={s.id}
            data-testid={`status-${s.id}`}
            onClick={() => setStatusFilter(s.id)}
            className={[
              'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
              statusFilter === s.id
                ? 'bg-chef-accent text-white shadow-inner'
                : 'bg-surface text-text-secondary border border-border hover:bg-surface-hover',
            ].join(' ')}
            aria-pressed={statusFilter === s.id}
          >
            {s.label}
          </button>
        ))}
      </div>

      {piOffline && (
        <Alert variant="warning" data-testid="pi-offline-banner">
          Pi offline — images unavailable. Classifier events still editable.
        </Alert>
      )}
      {!lanIp && !piOffline && (
        <Alert variant="info" data-testid="no-lan-ip-banner">
          No Pi LAN IP on file — set one in Settings → Scales to see event images.
        </Alert>
      )}
      {errorMsg && (
        <Alert variant="error" data-testid="error-banner" onDismiss={() => setErrorMsg(null)}>
          {errorMsg}
        </Alert>
      )}
      {eventsErr && (
        <Alert variant="error" data-testid="events-load-error">
          Failed to load events: {(eventsErr as Error).message}
        </Alert>
      )}

      {eventsLoading ? (
        <ListSkeleton count={6} />
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-text-tertiary" data-testid="no-events">
          No classifier events in this range yet.
        </div>
      ) : (
        <ul className="space-y-3" data-testid="event-list">
          {rows.map((row) => (
            <EventCard
              key={row.event.event_id}
              row={row}
              products={products}
              lanIp={lanIp}
              onImageError={() => setPiOffline(true)}
              expanded={expandedEventId === row.event.event_id}
              onToggleExpanded={() =>
                setExpandedEventId((id) => (id === row.event.event_id ? null : row.event.event_id))
              }
              onSave={(args) =>
                applyOverride.mutate({
                  clientEventId: row.event.client_event_id,
                  ...args,
                })
              }
              onToggleMacroLogging={() =>
                applyOverride.mutate({
                  clientEventId: row.event.client_event_id,
                  macroLoggingEnabled: !row.macroLoggingEnabled,
                  isVoided: row.isVoided,
                  eventKind: row.effectiveKind,
                })
              }
              onVoid={() =>
                applyOverride.mutate({
                  clientEventId: row.event.client_event_id,
                  isVoided: true,
                  eventKind: row.effectiveKind,
                })
              }
              onUnvoid={() =>
                applyOverride.mutate({
                  clientEventId: row.event.client_event_id,
                  isVoided: false,
                  macroLoggingEnabled: row.macroLoggingEnabled,
                  eventKind: row.effectiveKind,
                })
              }
              onAcceptClassifier={(itemId) =>
                applyOverride.mutate({
                  clientEventId: row.event.client_event_id,
                  classifierOverrideItemId: itemId,
                  eventKind: row.effectiveKind,
                })
              }
              onRetryAction={() => handleRetryAction(row)}
              saving={applyOverride.isPending || retryEvent.isPending}
              productMeasuredFullAt={
                row.event.payload?.product_id
                  ? (productStates[row.event.payload.product_id]?.measured_full_at ?? null)
                  : null
              }
              stampingMeasuredFull={stampMeasuredFullMutation.isPending}
              onStampMeasuredFull={() => {
                const pid = row.event.payload?.product_id;
                if (!pid) return;
                stampMeasuredFullMutation.mutate({
                  product_id: pid,
                  measured_full_at: new Date().toISOString(),
                });
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );

  if (embedded) return content;
  return <ChefLayout title="Events">{content}</ChefLayout>;
}

/* ------------------------------------------------------------------ */
/*  EventCard                                                          */
/* ------------------------------------------------------------------ */

interface EventCardProps {
  row: EventView;
  products: ProductLite[];
  lanIp: string | null;
  onImageError: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSave: (args: {
    stockQty?: number | null;
    servings?: number | null;
    calories?: number | null;
    protein?: number | null;
    carbs?: number | null;
    fat?: number | null;
    macroLoggingEnabled?: boolean;
    isVoided?: boolean;
    eventKind?: EventKind | null;
  }) => void;
  onToggleMacroLogging: () => void;
  onVoid: () => void;
  onUnvoid: () => void;
  onAcceptClassifier: (itemId: string) => void;
  onRetryAction: () => void;
  saving: boolean;
  /** Current measured_full_at for this event's product (null = not yet stamped). */
  productMeasuredFullAt: string | null;
  /** Set-once handler that stamps measured_full_at on the event's product. */
  onStampMeasuredFull: () => void;
  /** True while the stamp mutation is inflight (disables the checkbox). */
  stampingMeasuredFull: boolean;
}

function EventCard(props: EventCardProps) {
  const {
    row,
    products,
    lanIp,
    onImageError,
    expanded,
    onToggleExpanded,
    onSave,
    onToggleMacroLogging,
    onVoid,
    onUnvoid,
    onAcceptClassifier,
    onRetryAction,
    saving,
    productMeasuredFullAt,
    onStampMeasuredFull,
    stampingMeasuredFull,
  } = props;
  const {
    event,
    product,
    isVoided,
    macroLoggingEnabled,
    hasEdit,
    effectiveKind,
    needsReview,
    needsAction,
    retryAction,
  } = row;
  const occurredAt = event.payload?.occurred_at ?? event.created_at;
  const piEventId = event.pi_event_id;

  // Image URL priority:
  //   1. Cloud HTTPS URL (Supabase Storage) — no mixed-content, works everywhere
  //   2. LAN fallback (http://pi-ip:8000) — only when cloud URL not yet populated
  //      and lanIp is available (on-LAN only; Chrome will block off-LAN)
  //   3. Placeholder — "Image not available yet"
  const cloudBeforeUrl = event.before_image_url ?? null;
  const cloudAfterUrl = event.after_image_url ?? null;
  const lanImgBase =
    !cloudBeforeUrl && lanIp && piEventId ? `http://${lanIp}:8000/event/${encodeURIComponent(piEventId)}` : null;

  const borderCls = needsAction
    ? 'border-warning-subtle ring-1 ring-warning-subtle'
    : needsReview
      ? 'border-warning-subtle'
      : 'border-border';

  return (
    <li
      className={[
        'bg-surface border rounded-xl overflow-hidden transition-colors',
        borderCls,
        isVoided ? 'opacity-60' : '',
      ].join(' ')}
      data-testid={`event-row-${event.client_event_id}`}
      data-needs-action={needsAction ? 'true' : 'false'}
      data-needs-review={needsReview ? 'true' : 'false'}
    >
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        {/* Images — priority: cloud HTTPS > LAN fallback > placeholder */}
        <div className="flex gap-2 shrink-0">
          {cloudBeforeUrl || cloudAfterUrl ? (
            <Fragment>
              <img
                src={cloudBeforeUrl ?? `${lanImgBase}/before.jpg`}
                alt="Before"
                loading="lazy"
                className="w-16 h-16 rounded-lg object-cover border border-border bg-surface-sunken"
                onError={onImageError}
                data-testid="event-image-before"
              />
              <img
                src={cloudAfterUrl ?? `${lanImgBase}/after.jpg`}
                alt="After"
                loading="lazy"
                className="w-16 h-16 rounded-lg object-cover border border-border bg-surface-sunken"
                onError={onImageError}
                data-testid="event-image-after"
              />
            </Fragment>
          ) : lanImgBase ? (
            <Fragment>
              <img
                src={`${lanImgBase}/before.jpg`}
                alt="Before"
                loading="lazy"
                className="w-16 h-16 rounded-lg object-cover border border-border bg-surface-sunken"
                onError={onImageError}
                data-testid="event-image-before"
              />
              <img
                src={`${lanImgBase}/after.jpg`}
                alt="After"
                loading="lazy"
                className="w-16 h-16 rounded-lg object-cover border border-border bg-surface-sunken"
                onError={onImageError}
                data-testid="event-image-after"
              />
            </Fragment>
          ) : (
            <div
              className="w-16 h-16 rounded-lg border border-border bg-surface-sunken flex items-center justify-center text-text-tertiary"
              title="Image not available yet"
              data-testid="event-image-placeholder"
            >
              <ImageOff className="h-5 w-5" />
            </div>
          )}
        </div>

        {/* Summary */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-text truncate" data-testid="event-product-name">
              {product?.name ?? 'Unknown product'}
            </span>
            {needsAction && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-warning-subtle text-warning-text inline-flex items-center gap-1"
                title={event.reason ?? 'Event not applied'}
                data-testid="needs-action-badge"
              >
                <AlertTriangle className="h-3 w-3" /> Needs action
              </span>
            )}
            {needsReview && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-warning-subtle text-warning-text inline-flex items-center gap-1"
                data-testid="needs-review-badge"
              >
                <HelpCircle className="h-3 w-3" /> Review
              </span>
            )}
            {isVoided && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-danger-subtle text-danger-text"
                data-testid="voided-badge"
              >
                Voided
              </span>
            )}
            {hasEdit && !isVoided && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-info-subtle text-info-text inline-flex items-center gap-1"
                data-testid="edited-badge"
              >
                <Pencil className="h-3 w-3" /> Edited
              </span>
            )}
            {!macroLoggingEnabled && !isVoided && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full bg-warning-subtle text-warning-text"
                data-testid="macros-off-badge"
              >
                Macros off
              </span>
            )}
          </div>
          <div className="text-xs text-text-tertiary mt-0.5">
            {new Date(occurredAt).toLocaleString()} · <span data-testid="event-effective-kind">{effectiveKind}</span>
          </div>
          {needsAction && event.reason && (
            <div className="text-xs text-warning-text mt-1" data-testid="event-reason" title={event.reason}>
              Reason: {event.reason}
            </div>
          )}
          <div className="text-sm text-text-secondary mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
            <span data-testid="event-stock-delta">Stock: {row.effectiveStockDeltaContainers.toFixed(1)} ctn</span>
            <span data-testid="event-cal">{row.effectiveCalories.toFixed(0)} cal</span>
            <span data-testid="event-pcf">
              P {row.effectiveProtein.toFixed(0)}g · C {row.effectiveCarbs.toFixed(0)}g · F{' '}
              {row.effectiveFat.toFixed(0)}g
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {needsAction && retryAction && (
            <button
              onClick={onRetryAction}
              disabled={saving}
              data-testid="retry-action-btn"
              data-retry-kind={retryAction.kind}
              className="px-3 py-1 rounded-lg text-xs font-semibold bg-warning-subtle text-warning-text border border-warning-subtle hover:opacity-80 disabled:opacity-50"
            >
              {retryAction.label}
            </button>
          )}
          <button
            onClick={onToggleMacroLogging}
            disabled={saving || isVoided || needsAction}
            data-testid="toggle-macro-logging-btn"
            className={[
              'px-3 py-1 rounded-lg text-xs font-medium border transition-colors',
              macroLoggingEnabled
                ? 'bg-success-subtle text-success-text border-success-subtle'
                : 'bg-surface-sunken text-text-tertiary border-border',
              saving || isVoided || needsAction ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80',
            ].join(' ')}
            aria-pressed={macroLoggingEnabled}
          >
            <Check className="inline h-3 w-3 mr-1" />
            {macroLoggingEnabled ? 'Macros on' : 'Macros off'}
          </button>
          {isVoided ? (
            <button
              onClick={onUnvoid}
              disabled={saving}
              data-testid="unvoid-btn"
              className="px-3 py-1 rounded-lg text-xs font-medium bg-surface text-text-secondary border border-border hover:bg-surface-hover disabled:opacity-50 flex items-center gap-1"
            >
              <RotateCcw className="h-3 w-3" /> Un-void
            </button>
          ) : (
            <button
              onClick={onVoid}
              disabled={saving}
              data-testid="void-btn"
              className="px-3 py-1 rounded-lg text-xs font-medium bg-danger-subtle text-danger-text border border-danger-subtle hover:opacity-80 disabled:opacity-50 flex items-center gap-1"
            >
              <Ban className="h-3 w-3" /> Void
            </button>
          )}
          <button
            onClick={onToggleExpanded}
            data-testid="toggle-edit-btn"
            className="px-3 py-1 rounded-lg text-xs font-medium bg-surface text-text-secondary border border-border hover:bg-surface-hover flex items-center gap-1"
            aria-expanded={expanded}
          >
            {expanded ? (
              <Fragment>
                Hide <ChevronUp className="h-3 w-3" />
              </Fragment>
            ) : (
              <Fragment>
                {needsReview ? 'Review' : 'Edit'} <ChevronDown className="h-3 w-3" />
              </Fragment>
            )}
          </button>
        </div>
      </div>

      {/* Edit / Review drawer */}
      {expanded && !isVoided && (
        <Fragment>
          {needsReview && (
            <ReviewPanel row={row} products={products} onAcceptClassifier={onAcceptClassifier} saving={saving} />
          )}
          <EditorPanel
            row={row}
            onSave={onSave}
            saving={saving}
            productMeasuredFullAt={productMeasuredFullAt}
            onStampMeasuredFull={onStampMeasuredFull}
            stampingMeasuredFull={stampingMeasuredFull}
          />
        </Fragment>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  ReviewPanel — Needs-Review affordances                             */
/* ------------------------------------------------------------------ */

interface ReviewPanelProps {
  row: EventView;
  products: ProductLite[];
  onAcceptClassifier: (itemId: string) => void;
  saving: boolean;
}

function ReviewPanel({ row, products, onAcceptClassifier, saving }: ReviewPanelProps) {
  const [picker, setPicker] = useState<string>('');
  const classification = row.event.classification ?? {};
  const multiMatch = Array.isArray(classification.multi_match) ? classification.multi_match : [];
  const classifierPick = classification.item_id ?? row.event.payload?.product_id ?? null;
  const classifierPickProduct = classifierPick ? products.find((p) => p.product_id === classifierPick) : null;

  return (
    <div className="border-t border-warning-subtle p-4 bg-warning-subtle/10 space-y-3" data-testid="review-panel">
      <div className="flex items-center gap-2">
        <HelpCircle className="h-4 w-4 text-warning-text" />
        <span className="text-sm font-semibold text-warning-text">
          Classifier confidence low — please confirm the product
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {classifierPick && (
          <button
            type="button"
            onClick={() => onAcceptClassifier(classifierPick)}
            disabled={saving}
            data-testid="accept-classifier-btn"
            className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-chef-accent text-white hover:opacity-90 disabled:opacity-50"
          >
            Accept classifier pick
            {classifierPickProduct && <span className="ml-1 opacity-80">({classifierPickProduct.name})</span>}
          </button>
        )}
        {multiMatch.map((alt) => {
          const altProduct = products.find((p) => p.product_id === alt.item_id);
          if (!altProduct) return null;
          return (
            <button
              key={alt.item_id}
              type="button"
              onClick={() => onAcceptClassifier(alt.item_id)}
              disabled={saving}
              data-testid={`multi-match-${alt.item_id}`}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-surface text-text border border-border hover:bg-surface-hover disabled:opacity-50"
            >
              {alt.label ?? altProduct.name}
              {typeof alt.confidence === 'number' && (
                <span className="ml-1 text-xs text-text-tertiary">({Math.round(alt.confidence * 100)}%)</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label className="text-sm text-text-secondary" htmlFor="choose-product-picker">
          Choose different product:
        </label>
        <select
          id="choose-product-picker"
          data-testid="choose-product-picker"
          className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-text"
          value={picker}
          onChange={(e) => setPicker(e.target.value)}
        >
          <option value="">— pick —</option>
          {products.map((p) => (
            <option key={p.product_id} value={p.product_id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => picker && onAcceptClassifier(picker)}
          disabled={saving || !picker}
          data-testid="choose-product-apply-btn"
          className="px-3 py-1 rounded-lg text-sm font-medium bg-surface text-text-secondary border border-border hover:bg-surface-hover disabled:opacity-50"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  EditorPanel — independent stock/macros + kind selector             */
/* ------------------------------------------------------------------ */

interface EditorPanelProps {
  row: EventView;
  onSave: (args: {
    stockQty?: number | null;
    servings?: number | null;
    calories?: number | null;
    protein?: number | null;
    carbs?: number | null;
    fat?: number | null;
    macroLoggingEnabled?: boolean;
    isVoided?: boolean;
    eventKind?: EventKind | null;
  }) => void;
  saving: boolean;
  /** Current measured_full_at for this event's product (null = not yet stamped). */
  productMeasuredFullAt: string | null;
  /** Set-once handler that stamps measured_full_at on the event's product. */
  onStampMeasuredFull: () => void;
  /** True while the stamp mutation is inflight (disables the checkbox). */
  stampingMeasuredFull: boolean;
}

function EditorPanel({
  row,
  onSave,
  saving,
  productMeasuredFullAt,
  onStampMeasuredFull,
  stampingMeasuredFull,
}: EditorPanelProps) {
  const [stockQty, setStockQty] = useState<string>(row.effectiveStockDeltaContainers.toFixed(3).replace(/\.?0+$/, ''));
  const [servings, setServings] = useState<string>(
    row.effectiveServings === 0 ? '0' : row.effectiveServings.toFixed(2).replace(/\.?0+$/, ''),
  );
  const [macrosEnabled, setMacrosEnabled] = useState<boolean>(row.macroLoggingEnabled);
  const [eventKind, setEventKind] = useState<EventKind>(row.effectiveKind);
  const [customOpen, setCustomOpen] = useState(false);
  const [cal, setCal] = useState<string>('');
  const [prot, setProt] = useState<string>('');
  const [carb, setCarb] = useState<string>('');
  const [fat, setFat] = useState<string>('');

  const svgPer = row.product?.servings_per_container ?? 0;
  const perCal = row.product?.calories_per_serving ?? 0;
  const perP = row.product?.protein_per_serving ?? 0;
  const perC = row.product?.carbs_per_serving ?? 0;
  const perF = row.product?.fat_per_serving ?? 0;

  const servingsNum = Number(servings) || 0;
  const derivedCal = servingsNum * perCal;
  const derivedP = servingsNum * perP;
  const derivedC = servingsNum * perC;
  const derivedF = servingsNum * perF;

  const parseNum = (s: string): number | null => {
    if (s.trim() === '') return null;
    // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce -- reason: immediately guarded by Number.isFinite on the next line
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const isConsumption = eventKind === 'consumed' || eventKind === 'depleted';

  const handleSave = () => {
    onSave({
      stockQty: parseNum(stockQty),
      servings: isConsumption ? parseNum(servings) : null,
      calories: customOpen && isConsumption ? parseNum(cal) : null,
      protein: customOpen && isConsumption ? parseNum(prot) : null,
      carbs: customOpen && isConsumption ? parseNum(carb) : null,
      fat: customOpen && isConsumption ? parseNum(fat) : null,
      macroLoggingEnabled: macrosEnabled,
      isVoided: false,
      eventKind,
    });
  };

  return (
    <div className="border-t border-border p-4 bg-surface-sunken space-y-4" data-testid="edit-panel">
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">Event kind</label>
        <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label="Event kind" data-testid="event-kind-group">
          {EVENT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={eventKind === k}
              onClick={() => setEventKind(k)}
              data-testid={`event-kind-${k}`}
              className={[
                'px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors capitalize',
                eventKind === k
                  ? 'bg-chef-accent text-white border-chef-accent'
                  : 'bg-surface text-text-secondary border-border hover:bg-surface-hover',
              ].join(' ')}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="text-xs text-text-tertiary mt-1">
          consumed / depleted = stock out & macros log · added / refilled = stock in, no macros
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block text-sm font-medium text-text-secondary">
          Stock change (containers)
          <input
            type="number"
            step="0.001"
            value={stockQty}
            onChange={(e) => setStockQty(e.target.value)}
            data-testid="stock-qty-input"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
          />
          <div className="text-xs text-text-tertiary mt-1">Negative = consumed, positive = added</div>
        </label>

        <label className="block text-sm font-medium text-text-secondary">
          <span className="flex items-center justify-between gap-2">
            <span>Macros (servings)</span>
            <button
              type="button"
              role="switch"
              aria-checked={macrosEnabled}
              onClick={() => setMacrosEnabled((v) => !v)}
              data-testid="edit-macros-toggle"
              className={[
                'px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors',
                macrosEnabled
                  ? 'bg-success-subtle text-success-text border-success-subtle'
                  : 'bg-surface-sunken text-text-tertiary border-border',
              ].join(' ')}
            >
              {macrosEnabled ? 'LOG MACROS' : 'MACROS OFF'}
            </button>
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={servings}
            onChange={(e) => setServings(e.target.value)}
            disabled={!macrosEnabled || !isConsumption}
            data-testid="servings-input"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text disabled:opacity-50"
          />
          <div className="text-xs text-text-tertiary mt-1">
            {!isConsumption
              ? 'No macros for added/refilled events.'
              : macrosEnabled
                ? `Product: ${svgPer || 0} svg/ctn`
                : 'Stock will change but no food log entry will be written.'}
          </div>
        </label>
      </div>

      {isConsumption && macrosEnabled && (
        <div className="text-sm text-text-secondary">
          Derived macros: <span data-testid="derived-cal">{derivedCal.toFixed(0)}</span> cal · P {derivedP.toFixed(0)}g
          · C {derivedC.toFixed(0)}g · F {derivedF.toFixed(0)}g
        </div>
      )}

      {isConsumption && macrosEnabled && (
        <details
          className="rounded-lg border border-border bg-surface"
          open={customOpen}
          onToggle={(e) => setCustomOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary
            className="px-3 py-2 text-sm font-medium cursor-pointer select-none text-text-secondary"
            data-testid="custom-macros-disclosure"
          >
            Custom macros (override derived values)
          </summary>
          <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-border">
            <label className="text-xs text-text-tertiary">
              Calories
              <input
                type="number"
                step="0.01"
                value={cal}
                onChange={(e) => setCal(e.target.value)}
                placeholder={derivedCal.toFixed(1)}
                data-testid="cal-input"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1 text-sm text-text"
              />
            </label>
            <label className="text-xs text-text-tertiary">
              Protein (g)
              <input
                type="number"
                step="0.01"
                value={prot}
                onChange={(e) => setProt(e.target.value)}
                placeholder={derivedP.toFixed(1)}
                data-testid="prot-input"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1 text-sm text-text"
              />
            </label>
            <label className="text-xs text-text-tertiary">
              Carbs (g)
              <input
                type="number"
                step="0.01"
                value={carb}
                onChange={(e) => setCarb(e.target.value)}
                placeholder={derivedC.toFixed(1)}
                data-testid="carb-input"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1 text-sm text-text"
              />
            </label>
            <label className="text-xs text-text-tertiary">
              Fat (g)
              <input
                type="number"
                step="0.01"
                value={fat}
                onChange={(e) => setFat(e.target.value)}
                placeholder={derivedF.toFixed(1)}
                data-testid="fat-input"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1 text-sm text-text"
              />
            </label>
          </div>
        </details>
      )}

      {/*
        Manual fallback for the catch-all auto-import (Tasks 8-10):
        if the AI-estimated net_weight_g is off, the auto-stamp may
        never trigger. The user can mark the container as full here
        and the cloud locks measured_full_at. Set-once: once stamped,
        the checkbox stays checked and disabled.
      */}
      {row.event.payload?.product_id ? (
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <input
            type="checkbox"
            id={`event-item-full-${row.event.event_id}`}
            data-testid="event-item-full-checkbox"
            checked={!!productMeasuredFullAt}
            disabled={!!productMeasuredFullAt || stampingMeasuredFull}
            onChange={(e) => {
              if (!e.target.checked) return;
              if (productMeasuredFullAt) return;
              onStampMeasuredFull();
            }}
            className="h-4 w-4 rounded border-border accent-chef-accent disabled:opacity-60"
          />
          <label
            htmlFor={`event-item-full-${row.event.event_id}`}
            className="text-xs text-text-secondary"
            title={
              productMeasuredFullAt
                ? `Stamped at ${productMeasuredFullAt}`
                : 'Mark this container as full — locks the LiveTrack tag to fully calibrated. One-way.'
            }
          >
            Item is full {productMeasuredFullAt ? <span className="text-text-tertiary">(stamped)</span> : null}
          </label>
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          data-testid="save-override-btn"
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-chef-accent text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {saving ? 'Saving…' : 'Save override'}
        </button>
      </div>
    </div>
  );
}
