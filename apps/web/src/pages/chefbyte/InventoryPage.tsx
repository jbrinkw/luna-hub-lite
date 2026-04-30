import { useState, useMemo, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Activity,
  AlertTriangle,
  Scale,
  CheckCircle2,
  X,
  Info,
  Plus,
  Minus,
} from 'lucide-react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { CloseInFlightModal, type CloseInFlightResolution } from '@/components/chefbyte/CloseInFlightModal';
import { ProductActionModal } from '@/components/chefbyte/ProductActionModal';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { useChefbyteProducts, type ChefbyteProduct } from '@/shared/useChefbyteProducts';
import { todayStr } from '@/shared/dates';
import { isValidLanIp } from '@/components/chefbyte/ScalesTab';
import { formatQuantityWithVisual } from '@/shared/recipes/formatIngredientDisplay';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

// Product type comes from the shared hook — re-export a local alias so
// the rest of this file can keep using the short name.
type Product = ChefbyteProduct;

interface StockLot {
  lot_id: string;
  product_id: string;
  qty_containers: number;
  expires_on: string | null;
  last_update_source: 'manual' | 'live_shelf' | 'live_scale' | 'catch_all' | null;
  last_update_ts: string | null;
  /**
   * Set when a live-scale/shelf lot has been picked up but not yet placed
   * back (or reconciled as consumed). Null on every row until the Pi flips
   * it via the future mark_lot_in_flight RPC — drives the "In-flight"
   * badge on the inventory page.
   */
  in_flight_since: string | null;
  /**
   * Most recent gram-level weight observation streamed from the Pi via
   * the live_weight_sync flow (live_shelf + live_scale lots only —
   * catch_all uses pickup_weight_g). NULL when the lot has never been
   * observed. Paired with last_observed_at so the UI can render
   * freshness alongside the value.
   */
  last_observed_weight_g: number | null;
  last_observed_at: string | null;
  locations: { name: string } | null;
  /**
   * Joined from `chefbyte.products` — provides product name,
   * servings_per_container, and visual-unit display fields without a
   * separate map lookup. Includes [MEAL] sentinel products so the lot
   * view can render a [MEAL] flag rather than showing "Unknown" for
   * those lots.
   */
  products: {
    name: string;
    servings_per_container: number;
    visual_unit_label: string | null;
    visual_units_per_serving: number | null;
  } | null;
}

interface LiveShelfDeviceLite {
  device_id: string;
  lan_ip: string | null;
  // Column is NOT NULL DEFAULT 0 in the DB, but we type it as nullable for
  // defense in depth so the `?? 0` coalesce below stays correct if schema
  // changes or a partial projection ever drops the default.
  pending_review_count: number | null;
  last_heartbeat_ts: string | null;
}

interface GroupedProduct {
  product: Product;
  totalStock: number;
  nearestExpiry: string | null;
  lotCount: number;
  /**
   * Most recent automated-source tag across this product's lots, or null if the
   * last update was manual / untagged. Manual rows are intentionally excluded
   * from the pill UI, so they're excluded from this type too — keeps the
   * `sourcePillCls` switch exhaustive without a dead default branch.
   */
  latestSource: 'live_shelf' | 'live_scale' | 'catch_all' | null;
  /** Timestamp of the row that produced `latestSource` — used as tie-breaker. */
  latestSourceTs: string | null;
  /**
   * Earliest `in_flight_since` across this product's lots (if any lot is
   * currently in-flight). Null when no lot is in-flight — drives whether
   * the "In-flight" badge renders. Using the earliest pickup time matches
   * "how long has this product been off the shelf?" in the tooltip.
   */
  inFlightSince: string | null;
  /**
   * True when at least one of this product's lots is currently on a live
   * scale (lot_id ∈ pairedLotIds, in_flight_since IS NULL). Drives the
   * per-product ⚖ On Scale badge in the grouped view. Per-lot precision
   * lives on the lots view; the grouped view collapses to "any lot".
   */
  anyLotOnScale: boolean;
}

type ViewMode = 'grouped' | 'lots';

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for testing)                                 */
/* ------------------------------------------------------------------ */

/**
 * Compute the Review (N) button state from a set of live-shelf devices.
 *
 * - `pendingReviewTotal` is the sum of every device's `pending_review_count`
 *   (null-coalesced to 0). The sum is displayed in the UI even when the
 *   button is disabled so the user can see backlog at a glance.
 * - `reviewUrl` is built from the most-recently-heartbeated device whose
 *   `lan_ip` passes `isValidLanIp`. Because the IP is interpolated into an
 *   href, we re-validate at URL-build time — a value that slipped into the
 *   DB before the Settings-tab validation existed MUST NOT produce a clickable
 *   `javascript:`-style URL.
 * - `reviewDisabledReason` distinguishes "no device has a LAN IP" from
 *   "a device has one but it failed re-validation" so the user knows what
 *   to fix.
 */
export function computeReviewState(
  shelfDevices: ReadonlyArray<{
    lan_ip: string | null;
    pending_review_count: number | null;
    last_heartbeat_ts: string | null;
  }>,
): {
  pendingReviewTotal: number;
  reviewUrl: string | null;
  reviewDisabledReason: string | null;
} {
  const total = shelfDevices.reduce((sum, d) => sum + (d.pending_review_count ?? 0), 0);
  const withIp = shelfDevices.filter((d) => d.lan_ip && d.lan_ip.trim() !== '');
  const sorted = [...withIp].sort((a, b) => {
    const ta = a.last_heartbeat_ts ? new Date(a.last_heartbeat_ts).getTime() : 0;
    const tb = b.last_heartbeat_ts ? new Date(b.last_heartbeat_ts).getTime() : 0;
    return tb - ta;
  });
  const target = sorted[0];
  const targetIpValid = target && target.lan_ip ? isValidLanIp(target.lan_ip) : false;
  const url = target && targetIpValid ? `http://${target.lan_ip}:8000/inventory#review` : null;
  let reason: string | null = null;
  if (!target) {
    reason = 'Set LAN IP in Settings → Scales';
  } else if (!targetIpValid) {
    reason = 'Invalid LAN IP — update in Settings → Scales';
  }
  return { pendingReviewTotal: total, reviewUrl: url, reviewDisabledReason: reason };
}

/**
 * Pick the earliest `in_flight_since` across a product's lots (null if none
 * are in-flight). Earliest-wins so the tooltip naturally shows "picked up X
 * minutes ago" for the longest-outstanding lot — if two lots were picked up
 * in quick succession and one comes back first, the badge reflects the
 * oldest remaining pickup until it too is reconciled.
 *
 * Exported for unit testing; consumed by the Inventory page's grouped
 * aggregation.
 */
export function pickEarliestInFlight(lots: ReadonlyArray<{ in_flight_since: string | null }>): string | null {
  let earliest: string | null = null;
  for (const l of lots) {
    if (!l.in_flight_since) continue;
    if (earliest === null || l.in_flight_since < earliest) {
      earliest = l.in_flight_since;
    }
  }
  return earliest;
}

/**
 * Whether a lot's `last_update_source` should produce a visible pill in the
 * lots-view table. Mirrors `pickLatestAutomatedSource`'s gate so the per-row
 * lots view and the per-product grouped view agree on what counts as a
 * tracked source. Manual + null are always hidden; `live_scale` requires the
 * product to be currently paired in `chefbyte.scale_pairings`.
 *
 * Exported for unit testing.
 */
export function shouldShowLotSourcePill(
  source: 'manual' | 'live_shelf' | 'live_scale' | 'catch_all' | null,
  productId: string,
  liveScalePairedProductIds: ReadonlySet<string>,
): source is 'live_shelf' | 'live_scale' | 'catch_all' {
  if (!source || source === 'manual') return false;
  if (source === 'live_scale' && !liveScalePairedProductIds.has(productId)) return false;
  return true;
}

/**
 * Whether a specific lot is currently "On Scale" — i.e. paired AND not
 * in-flight AND not at sub-display residual qty.
 *
 * Independent of the in-flight badge: a lot can be paired (in
 * pairedLotIds) but currently in flight (in_flight_since != null); in
 * that case "On Scale" is false because the bottle is physically
 * elsewhere.
 *
 * 2026-04-28 — qty-residual guard: a paired lot at qty < 0.01 ctn is
 * treated as "not on scale" defensively. Cloud rotation is supposed
 * to repoint scale_pairings.lot_id away from a depleted lot via
 * private.rotate_pairing_after_depletion, but the trigger predicate
 * historically required exactly qty=0; scale-noise residuals (≈0.001-
 * 0.01 ctn) left some pairings stuck pointing at phantom-empty lots.
 * The cloud predicate is now widened to < 0.01 too (migration
 * 20260428010000), so this UI guard is belt-and-suspenders against
 * realtime lag between the cloud rotation and the next
 * scale_pairings refetch. The threshold MUST match the cloud
 * threshold so the UI never disagrees with the source of truth.
 *
 * After the 2026-04-27 lot-level pairings refactor this answers the
 * precise question "is this exact ``stock_lots`` row pinned to a live
 * scale right now and physically usable?" — replacing the old
 * per-product approximation.
 *
 * Exported for unit testing.
 */
export const ON_SCALE_QTY_EPSILON = 0.01;
export function isLotOnScale(
  lot: { lot_id: string; in_flight_since: string | null; qty_containers?: number | string | null },
  pairedLotIds: ReadonlySet<string>,
): boolean {
  if (lot.in_flight_since !== null) return false;
  if (!pairedLotIds.has(lot.lot_id)) return false;
  // qty_containers is optional in the type so the older test seeds that
  // don't carry it still work — those default to "non-empty paired"
  // which preserves the prior assertion behaviour. When qty IS present
  // we coerce + threshold-check against ON_SCALE_QTY_EPSILON.
  if (lot.qty_containers != null) {
    const q = Number(lot.qty_containers);
    if (Number.isFinite(q) && q < ON_SCALE_QTY_EPSILON) return false;
  }
  return true;
}

/**
 * Pick the most-recently-updated automated source tag across a product's lots.
 *
 * Manual-source rows are intentionally excluded — the pill is reserved for
 * automated sources (live_shelf / live_scale / catch_all). A lot with a
 * source but a null ts falls back to "first non-manual seen" so we still
 * show something sensible for legacy data written before `last_update_ts`
 * was populated.
 *
 * `live_scale` is special-cased: the badge means "this product is currently
 * paired to a live scale," not "a live_scale event ever touched a lot of this
 * product." `last_update_source='live_scale'` is a per-lot historical tag that
 * persists forever after the pairing is torn down — so we must additionally
 * require the product be present in `liveScalePairedProductIds`, which is the
 * live truth-source from `chefbyte.scale_pairings WHERE kind='live_scale'`.
 *
 * When a lot's tag is `live_scale` but the product is no longer paired, the
 * lot is skipped (treated as if its tag were null) so a still-valid older
 * `live_shelf` or `catch_all` tag on a sibling lot can still surface.
 *
 * `productId` is only consulted to look up the paired-set; pass any string
 * (including the empty string) when calling with a lot collection where every
 * lot belongs to the same product.
 */
export function pickLatestAutomatedSource(
  lots: ReadonlyArray<{
    last_update_source: 'manual' | 'live_shelf' | 'live_scale' | 'catch_all' | null;
    last_update_ts: string | null;
  }>,
  productId: string = '',
  liveScalePairedProductIds: ReadonlySet<string> = new Set(),
): {
  latestSource: 'live_shelf' | 'live_scale' | 'catch_all' | null;
  latestSourceTs: string | null;
} {
  let latestSource: 'live_shelf' | 'live_scale' | 'catch_all' | null = null;
  let latestSourceTs: string | null = null;
  const liveScalePaired = liveScalePairedProductIds.has(productId);
  for (const l of lots) {
    if (!l.last_update_source || l.last_update_source === 'manual') continue;
    // Suppress stale live_scale tags when no scale_pairings row currently
    // pairs this product. Without this guard, a product that was once on a
    // scale shows the "live scale" pill indefinitely after the pairing is
    // removed — see fix(chefbyte/inventory) commit history.
    if (l.last_update_source === 'live_scale' && !liveScalePaired) continue;
    if (!l.last_update_ts) {
      if (latestSource === null) latestSource = l.last_update_source;
      continue;
    }
    if (!latestSourceTs || l.last_update_ts > latestSourceTs) {
      latestSourceTs = l.last_update_ts;
      latestSource = l.last_update_source;
    }
  }
  return { latestSource, latestSourceTs };
}

/* ================================================================== */
/*  InventoryPage                                                      */
/* ================================================================== */

export function InventoryPage() {
  const { user } = useAuth();
  const { dayStartHour } = useAppContext();
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('grouped');

  /* ---- Search filter state ---- */
  const [searchText, setSearchText] = useState('');
  /* ---- Expand/collapse state (grouped view) ---- */
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  /* ---- Add-stock modal state ---- */
  const [addingStockFor, setAddingStockFor] = useState<string | null>(null);
  const [addStockQty, setAddStockQty] = useState<number>(1);
  const [addStockExpiry, setAddStockExpiry] = useState<string>('');

  /* ---- Confirm modal state ---- */
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    action: () => void;
  }>({ open: false, action: () => {} });
  const closeConfirm = () => setConfirmState((prev) => ({ ...prev, open: false }));

  /* ---- Mutation error state ---- */
  const [error, setError] = useState<string | null>(null);

  /* ---- Status (aria-live) for successful mutations.
     The audit called out that trust signals are weak: most mutations
     commit silently. This polite-live region is read by screen readers
     and visually surfaces a transient toast for sighted users. Cleared
     after 4 s by the timer below. */
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announceStatus = (msg: string) => {
    setStatusMessage(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMessage(null), 4000);
  };
  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);

  /* ---- Badge legend (collapse-by-default + permanently dismissible).
     R2: the always-visible 6-line legend pushed the actual data below
     the fold on a phone-at-fridge first paint. Now collapsed by default
     under a single "What do these badges mean?" trigger; once the user
     toggles "Got it", we persist a flag so the trigger stops appearing.
     Five badge meanings (Certified / On Scale / In Flight / source pill /
     stock dot) are still surfaced — just on demand. localStorage is
     scoped by user_id so a shared device with multiple Supabase accounts
     doesn't hide the legend across users. Reads are defensive (Safari
     private + SSR-safe). */
  const legendStorageKey = user ? `chefbyte_inv_legend_dismissed:${user.id}` : 'chefbyte_inv_legend_dismissed';
  const [legendDismissed, setLegendDismissed] = useState(() => {
    try {
      return localStorage.getItem(legendStorageKey) === '1';
    } catch {
      return false;
    }
  });
  const [legendOpen, setLegendOpen] = useState(false);
  const dismissLegend = () => {
    setLegendDismissed(true);
    setLegendOpen(false);
    try {
      localStorage.setItem(legendStorageKey, '1');
      // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment -- reason: Safari private mode throws on localStorage.setItem — ephemeral dismiss is fine for a comfort optimization
    } catch {}
  };

  /* ---- Realtime pulse tracking.
     Realtime is wired (stock_lots invalidation refetches transparently)
     but the data updates were silent — a Pi consume re-rendered the row
     with no visual feedback. R2 #6 addresses this with a brief 600ms
     pulse on the rows whose lots changed since the last data snapshot.
     We compare a simple fingerprint per product_id (sum-of-qty +
     in_flight_since presence) on every render; rows whose fingerprint
     changes get added to `pulsingProductIds` for one frame and the
     animation class fires. The first non-empty render is treated as the
     baseline so a fresh page load doesn't flash everything green.

     Skipping the pulse when the user just kicked off a mutation locally
     (within ~1.5s) keeps the toast as the canonical confirmation —
     otherwise the same event fires both surfaces. */
  const [pulsingProductIds, setPulsingProductIds] = useState<ReadonlySet<string>>(new Set());
  const lastFingerprintRef = useRef<Map<string, string> | null>(null);
  const pulseClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocalMutationAtRef = useRef<number>(0);
  useEffect(() => {
    return () => {
      if (pulseClearRef.current) clearTimeout(pulseClearRef.current);
    };
  }, []);

  /* ---- Close-in-flight modal state ----
     The In-Flight badge is a button that opens this modal scoped to a
     specific lot. The modal calls back with one of three resolutions
     ('discarded' | 'consumed' | 'returned') which we forward to the
     ``chefbyte.close_in_flight_lot`` RPC. Carries the product name +
     pickup timestamp purely for display — the lot_id is the source of
     truth on the server. */
  const [closeModalLot, setCloseModalLot] = useState<{
    lotId: string;
    productName: string;
    pickupTs: string | null;
  } | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading via TanStack Query                                  */
  /* ---------------------------------------------------------------- */

  // Use the shared hook — applies deleted_at IS NULL + [MEAL] exclusion,
  // matching SettingsPage exactly. This was the root cause of the bug where
  // soft-deleted products (e.g. Bacon, Extra Sharp Cheddar) appeared at
  // "0.0 ctn" in inventory but were missing from Settings → Products.
  const { data: products = [], isLoading: productsLoading, error: productsError } = useChefbyteProducts();

  const { data: lots = [], isLoading: lotsLoading } = useQuery({
    queryKey: queryKeys.stockLots(user!.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('stock_lots')
        .select(
          'lot_id,product_id,qty_containers,expires_on,last_update_source,last_update_ts,in_flight_since,last_observed_weight_g,last_observed_at,locations:location_id(name),products:product_id(name,servings_per_container,visual_unit_label,visual_units_per_serving)',
        )
        .eq('user_id', user!.id);
      if (error) throw error;
      return (data ?? []) as StockLot[];
    },
    enabled: !!user,
  });

  /* Live Shelf devices — used to total pending_review_count and resolve the
     LAN IP for the "Review (N)" deep-link. Short refetch keeps the badge honest. */
  const { data: shelfDevices = [] } = useQuery({
    queryKey: queryKeys.liveShelfDevices(user!.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('live_shelf_devices')
        .select('device_id,lan_ip,pending_review_count,last_heartbeat_ts')
        .eq('user_id', user!.id);
      if (error) throw error;
      return (data ?? []) as LiveShelfDeviceLite[];
    },
    enabled: !!user,
    refetchInterval: 15_000,
  });

  /* Live-scale pairings — drives the per-lot "On Scale" badge. After the
     2026-04-27 lot-level pairings refactor (migration
     20260427080000_scale_pairings_lot_level.sql), pairings carry
     ``lot_id`` so the badge can pin to the exact lot rather than every
     lot of the paired product. We still surface ``product_id`` so a
     never-rotated pairing (lot_id NULL, FEFO fallback in cloud) keeps
     showing the badge on the FEFO winner — preserves the user's mental
     model that "this product is on the scale" until the cloud rotates. */
  const { data: liveScalePairings = [] } = useQuery({
    queryKey: queryKeys.scalePairings(user!.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('scale_pairings')
        .select('product_id,lot_id,kind')
        .eq('user_id', user!.id)
        .eq('kind', 'live_scale')
        .not('product_id', 'is', null);
      if (error) throw error;
      return (data ?? []) as Array<{ product_id: string; lot_id: string | null; kind: string }>;
    },
    enabled: !!user,
    refetchInterval: 15_000,
  });

  // Memoise to keep `===` stable between renders so downstream `useMemo`
  // dependencies don't churn — re-derives only when the rows actually change.
  const liveScalePairedProductIds = useMemo(
    () => new Set(liveScalePairings.map((p) => p.product_id)),
    [liveScalePairings],
  );

  // Set of paired lot_ids — drives the per-lot "On Scale" badge.
  // Empty when every pairing is rotation-pending (lot_id NULL); the
  // product-level fallback above handles that case.
  const pairedLotIds = useMemo(
    () =>
      new Set(
        liveScalePairings.map((p) => p.lot_id).filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    [liveScalePairings],
  );

  const { data: locationId = null } = useQuery({
    queryKey: queryKeys.defaultLocationId(user!.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('locations')
        .select('location_id')
        .eq('user_id', user!.id)
        .order('created_at')
        .limit(1);
      if (error) throw error;
      return data?.[0]?.location_id ?? null;
    },
    enabled: !!user,
  });

  const loading = productsLoading || lotsLoading;
  const loadError = productsError ? (productsError as Error).message : null;

  /* ---------------------------------------------------------------- */
  /*  Realtime subscriptions                                           */
  /* ---------------------------------------------------------------- */

  useRealtimeInvalidation('inventory-changes', [
    {
      schema: 'chefbyte',
      table: 'stock_lots',
      queryKeys: [queryKeys.stockLots(user!.id)],
    },
    // products is joined into the stock_lots query
    // (`products:product_id(name, servings_per_container)`); the page
    // also keys the products cache via queryKeys.products. Invalidate
    // both so a product rename / servings-per-container edit from
    // Settings (or AI analyzer) reflects on the lot rows immediately.
    {
      schema: 'chefbyte',
      table: 'products',
      queryKeys: [queryKeys.stockLots(user!.id), queryKeys.products(user!.id)],
    },
    // locations is joined into stock_lots (`locations:location_id(name)`).
    // Without this, renaming a location in Settings won't update the
    // location label on each lot row in Inventory.
    {
      schema: 'chefbyte',
      table: 'locations',
      queryKeys: [queryKeys.stockLots(user!.id), queryKeys.locations(user!.id)],
    },
    {
      schema: 'chefbyte',
      table: 'live_shelf_devices',
      queryKeys: [queryKeys.liveShelfDevices(user!.id)],
    },
    // scale_pairings drives the "live scale" badge gating; subscribe so an
    // unpair (or new pair) flips the badge on the inventory page within
    // realtime latency without a full refetch cycle.
    {
      schema: 'chefbyte',
      table: 'scale_pairings',
      queryKeys: [queryKeys.scalePairings(user!.id)],
    },
  ]);

  /* ---------------------------------------------------------------- */
  /*  Aggregation                                                      */
  /* ---------------------------------------------------------------- */

  const grouped: GroupedProduct[] = useMemo(() => {
    const lotsByProduct = new Map<string, StockLot[]>();
    for (const lot of lots) {
      const existing = lotsByProduct.get(lot.product_id) ?? [];
      existing.push(lot);
      lotsByProduct.set(lot.product_id, existing);
    }

    return products.map((product) => {
      const productLots = lotsByProduct.get(product.product_id) ?? [];
      const totalStock = productLots.reduce((sum, l) => sum + Number(l.qty_containers), 0);

      // Find nearest expiry (excluding null)
      const expiries = productLots
        .map((l) => l.expires_on)
        .filter((e): e is string => e !== null)
        .sort();
      const nearestExpiry = expiries[0] ?? null;

      // Pick the most-recently-updated automated source tag for the pill.
      // The paired-set gates `live_scale` so a stale tag from a torn-down
      // pairing doesn't keep the pill lit. See `pickLatestAutomatedSource`
      // for the full rationale.
      const { latestSource, latestSourceTs } = pickLatestAutomatedSource(
        productLots,
        product.product_id,
        liveScalePairedProductIds,
      );

      // Earliest outstanding pickup across this product's lots (null when none).
      const inFlightSince = pickEarliestInFlight(productLots);

      // Per-product On-Scale roll-up: true iff at least one lot is paired
      // AND not currently in-flight. Lot-level precision is enforced by
      // ``isLotOnScale`` in the lots view.
      const anyLotOnScale = productLots.some((l) => isLotOnScale(l, pairedLotIds));

      return {
        product,
        totalStock,
        nearestExpiry,
        lotCount: productLots.length,
        latestSource,
        latestSourceTs,
        inFlightSince,
        anyLotOnScale,
      };
    });
  }, [products, lots, liveScalePairedProductIds, pairedLotIds]);

  /* ---- Realtime pulse fingerprint detection.
     Compute a per-product fingerprint that captures the bits the user
     would notice changing (total qty, in-flight presence, lot count).
     On every lots-array change we diff against the prior snapshot and
     mark changed products as pulsing for 600ms. The first non-empty
     snapshot is treated as the baseline (no pulse) so a fresh page load
     doesn't flash everything. Local mutations within the last 1.5s
     suppress the pulse so the toast remains the canonical confirmation
     for user-initiated changes. */
  /* eslint-disable react-hooks/set-state-in-effect -- legitimate: realtime data delta → transient UI flash */
  useEffect(() => {
    if (lots.length === 0 && lastFingerprintRef.current === null) return;

    const fingerprint = new Map<string, string>();
    for (const g of grouped) {
      fingerprint.set(g.product.product_id, `${g.totalStock.toFixed(3)}|${g.lotCount}|${g.inFlightSince ?? ''}`);
    }

    const prior = lastFingerprintRef.current;
    lastFingerprintRef.current = fingerprint;

    if (!prior) return; // baseline snapshot — no pulse

    // Suppress pulses fired close on the heels of a local mutation —
    // the toast already announced what happened.
    if (Date.now() - lastLocalMutationAtRef.current < 1500) return;

    const changed = new Set<string>();
    for (const [pid, fp] of fingerprint) {
      if (prior.get(pid) !== fp) changed.add(pid);
    }
    // Also pulse rows whose products were just removed (stock fully
    // consumed) — they may still render briefly via min-stock reminder.
    for (const pid of prior.keys()) {
      if (!fingerprint.has(pid)) changed.add(pid);
    }

    if (changed.size === 0) return;

    setPulsingProductIds(changed);
    if (pulseClearRef.current) clearTimeout(pulseClearRef.current);
    pulseClearRef.current = setTimeout(() => setPulsingProductIds(new Set()), 700);
  }, [lots, grouped]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ---------------------------------------------------------------- */
  /*  Expired lots — rendered as their own "discard" section at the   */
  /*  top of the grouped view. Expired = expires_on < today. Today is */
  /*  NOT expired (food is still good through the printed date).      */
  /* ---------------------------------------------------------------- */

  const todayYmd = todayStr(dayStartHour);

  const expiredLots = useMemo(() => {
    const productMap = new Map(products.map((p) => [p.product_id, p]));
    return (
      lots
        .filter((l) => l.expires_on && l.expires_on < todayYmd && Number(l.qty_containers) > 0)
        .map((l) => ({
          ...l,
          product: productMap.get(l.product_id) ?? null,
          productName: productMap.get(l.product_id)?.name ?? 'Unknown',
        }))
        // Oldest expiry first — most urgent at the top of the section.
        .sort((a, b) => {
          const cmp = (a.expires_on ?? '').localeCompare(b.expires_on ?? '');
          if (cmp !== 0) return cmp;
          return a.productName.localeCompare(b.productName);
        })
    );
  }, [lots, products, todayYmd]);

  /**
   * Days since an expired lot's printed date. Used to render the
   * "X days expired" chip. expires_on is stored as YYYY-MM-DD so we
   * compare midnight-to-midnight and floor fractions.
   */
  const daysExpired = (expiresOn: string): number => {
    const expired = new Date(expiresOn + 'T00:00:00');
    const today = new Date(todayYmd + 'T00:00:00');
    const ms = today.getTime() - expired.getTime();
    return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
  };

  /* ---------------------------------------------------------------- */
  /*  Anchor scroll — #expired from dashboard card                    */
  /* ---------------------------------------------------------------- */

  const location = useLocation();
  const expiredSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only scroll after data has loaded — otherwise the anchor sits
    // inside the skeleton and scroll-to-element is a no-op.
    if (!loading && location.hash === '#expired' && expiredSectionRef.current) {
      expiredSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.hash, loading, expiredLots.length]);

  /* ---------------------------------------------------------------- */
  /*  Filtered grouped (by search text)                                */
  /* ---------------------------------------------------------------- */

  const filteredGrouped = useMemo(() => {
    // Keep: any stock, or a min-stock target (shows as out-of-stock reminder),
    // or currently-in-flight (picked up, waiting for reunite — stock may be 0).
    // The in-flight carve-out fixes the "item disappears after pickup" bug:
    // a lot with qty=0 + in_flight_since IS NOT NULL is tracked, not lost,
    // and must remain visible so the user sees where it went.
    let result = grouped.filter(
      (g) => g.totalStock > 0 || Number(g.product.min_stock_amount) > 0 || g.inFlightSince !== null,
    );
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((g) => g.product.name.toLowerCase().includes(lower));
    }
    // Sort order:
    //   1. In-flight products first — what's out RIGHT NOW is most relevant.
    //   2. In-stock (totalStock > 0) next.
    //   3. Zero-stock (e.g. min-stock reminders, or returned-but-consumed) last.
    //   4. Within each group, alphabetical by product name.
    // Ties inside the in-flight group fall through to the name comparator so
    // there's no dependence on earliest-pickup ordering across products.
    result.sort((a, b) => {
      const aInFlight = a.inFlightSince !== null ? 0 : 1;
      const bInFlight = b.inFlightSince !== null ? 0 : 1;
      if (aInFlight !== bInFlight) return aInFlight - bInFlight;
      const aZero = a.totalStock <= 0 ? 1 : 0;
      const bZero = b.totalStock <= 0 ? 1 : 0;
      if (aZero !== bZero) return aZero - bZero;
      return a.product.name.localeCompare(b.product.name);
    });
    return result;
  }, [grouped, searchText]);

  /* ---------------------------------------------------------------- */
  /*  Sorted lots for Lots view                                        */
  /*  Filter: qty > 0 OR in_flight_since IS NOT NULL.                  */
  /*  In-flight lots with qty=0 are tracked (picked up, waiting for    */
  /*  reunite) and must remain visible — dropping them is the "item    */
  /*  disappears after pickup" bug this view is part of.               */
  /*  Tombstoned zero-qty rows (not in-flight) are still hidden.       */
  /* ---------------------------------------------------------------- */

  const sortedLots = useMemo(() => {
    const productMap = new Map(products.map((p) => [p.product_id, p]));
    return lots
      .filter((l) => Number(l.qty_containers) > 0 || l.in_flight_since !== null)
      .map((lot) => {
        // Use the joined product data from the query for name + servings.
        // The join includes [MEAL] sentinel products that are excluded from
        // useChefbyteProducts, so [MEAL] lots display their real name + flag
        // rather than "Unknown". Fall back to the products[] map for the
        // certified flag which is only fetched via useChefbyteProducts.
        const joinedProduct = lot.products;
        const mappedProduct = productMap.get(lot.product_id);
        const productName = joinedProduct?.name ?? mappedProduct?.name ?? 'Unknown';
        const servingsPerContainer: number = Number(
          joinedProduct?.servings_per_container ?? mappedProduct?.servings_per_container ?? 1,
        );
        const qtyServings = Number(lot.qty_containers) * servingsPerContainer;
        const isMealLot = productName.startsWith('[MEAL]');
        // Visual unit: prefer the joined-row value (covers [MEAL] sentinel
        // products that are filtered out of useChefbyteProducts) and fall
        // back to the mappedProduct entry from the regular catalog.
        const visualUnitLabel = joinedProduct?.visual_unit_label ?? mappedProduct?.visual_unit_label ?? null;
        const visualUnitsPerServing =
          joinedProduct?.visual_units_per_serving != null
            ? Number(joinedProduct.visual_units_per_serving)
            : mappedProduct?.visual_units_per_serving != null
              ? Number(mappedProduct.visual_units_per_serving)
              : null;
        return {
          ...lot,
          productName,
          productCertified: mappedProduct?.certified === true,
          qtyServings,
          isMealLot,
          visualUnitLabel,
          visualUnitsPerServing,
          servingsPerContainer,
        };
      })
      .sort((a, b) => {
        // Primary: in-flight first (what's off the shelf right now is most
        // relevant for the user to see).
        const aInFlight = a.in_flight_since !== null ? 0 : 1;
        const bInFlight = b.in_flight_since !== null ? 0 : 1;
        if (aInFlight !== bInFlight) return aInFlight - bInFlight;
        // Secondary: expires_on ASC NULLS LAST within each group.
        if (!a.expires_on && !b.expires_on) return a.productName.localeCompare(b.productName);
        if (!a.expires_on) return 1;
        if (!b.expires_on) return -1;
        const dateCompare = a.expires_on.localeCompare(b.expires_on);
        if (dateCompare !== 0) return dateCompare;
        return a.productName.localeCompare(b.productName);
      });
  }, [lots, products]);

  /* ---- Filtered lots (by search text) — mirrors filteredGrouped logic */
  const filteredSortedLots = useMemo(() => {
    if (!searchText.trim()) return sortedLots;
    const lower = searchText.toLowerCase();
    return sortedLots.filter((l) => l.productName.toLowerCase().includes(lower));
  }, [sortedLots, searchText]);

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const getLogicalDate = () => todayStr(dayStartHour);

  const invalidateInventory = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.stockLots(user!.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
  };

  const openAddStockModal = (productId: string, defaultQty: number = 1) => {
    setAddingStockFor(productId);
    setAddStockQty(defaultQty);
    setAddStockExpiry('');
  };

  const closeAddStockModal = () => {
    setAddingStockFor(null);
    setAddStockQty(1);
    setAddStockExpiry('');
  };

  const addStockMutation = useMutation({
    mutationFn: async ({
      productId,
      qtyContainers,
      expiresOn,
    }: {
      productId: string;
      qtyContainers: number;
      expiresOn: string | null;
    }) => {
      if (!user || !locationId) throw new Error('Missing user or location');

      const resolvedExpiry = expiresOn || null;

      // Build query to find existing lot with same product/location/expiry
      let query = chefbyte()
        .from('stock_lots')
        .select('lot_id, qty_containers')
        .eq('user_id', user.id)
        .eq('product_id', productId)
        .eq('location_id', locationId);

      if (resolvedExpiry) {
        query = query.eq('expires_on', resolvedExpiry);
      } else {
        query = query.is('expires_on', null);
      }

      const { data: existing } = await query.limit(1).maybeSingle();

      if (existing) {
        // Merge into existing lot
        const { error: err } = await chefbyte()
          .from('stock_lots')
          .update({ qty_containers: Number(existing.qty_containers) + qtyContainers })
          .eq('lot_id', existing.lot_id);
        if (err) throw err;
      } else {
        // Create new lot
        const { error: err } = await chefbyte().from('stock_lots').insert({
          user_id: user.id,
          product_id: productId,
          location_id: locationId,
          qty_containers: qtyContainers,
          expires_on: resolvedExpiry,
        });
        if (err) throw err;
      }
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
    },
    onSuccess: (_data, vars) => {
      setError(null);
      const name = products.find((p) => p.product_id === vars.productId)?.name ?? 'item';
      announceStatus(`Added ${vars.qtyContainers} container${vars.qtyContainers === 1 ? '' : 's'} of ${name}`);
      // Toast suppresses the realtime pulse — see pulse fingerprint effect.
      lastLocalMutationAtRef.current = Date.now();
    },
    onSettled: () => {
      invalidateInventory();
    },
  });

  const confirmAddStock = async () => {
    if (!addingStockFor || addStockQty <= 0) return;
    addStockMutation.mutate({
      productId: addingStockFor,
      qtyContainers: addStockQty,
      expiresOn: addStockExpiry || null,
    });
    closeAddStockModal();
  };

  const consumeStockMutation = useMutation({
    mutationFn: async ({
      productId,
      qty,
      unit,
    }: {
      productId: string;
      qty: number;
      unit: 'container' | 'serving';
      // productName carried for the status announcement only — not sent to the RPC.
      productName?: string;
    }) => {
      const { error: err } = await (chefbyte() as any).rpc('consume_product', {
        p_product_id: productId,
        p_qty: qty,
        p_unit: unit,
        p_log_macros: true,
        p_logical_date: getLogicalDate(),
      });
      if (err) throw err;
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
    },
    onSuccess: (_data, vars) => {
      setError(null);
      const name = vars.productName ?? 'item';
      announceStatus(`Removed ${vars.qty} ${vars.unit}${vars.qty === 1 ? '' : 's'} of ${name}`);
      // Toast suppresses the realtime pulse — see pulse fingerprint effect.
      lastLocalMutationAtRef.current = Date.now();
    },
    onSettled: () => {
      invalidateInventory();
    },
  });

  /**
   * Discard an expired lot WITHOUT logging macros. Legitimate when food
   * went bad and is being thrown out — we still need the stock to go to
   * zero so the inventory isn't inflated, but the calories/macros must
   * NOT be counted against the user's daily totals.
   *
   * Implementation: hit the specific lot directly (not consume_product,
   * which is FIFO across all lots and always logs macros). Since RLS
   * scopes by user_id, the UPDATE is safe to issue from the client.
   */
  const discardLotMutation = useMutation({
    mutationFn: async ({ lotId, productName: _productName }: { lotId: string; productName?: string }) => {
      const { error: err } = await chefbyte().from('stock_lots').update({ qty_containers: 0 }).eq('lot_id', lotId);
      if (err) throw err;
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: (_data, vars) => {
      setError(null);
      announceStatus(`Tossed ${vars.productName ?? 'expired lot'}`);
    },
    onSettled: () => invalidateInventory(),
  });

  /**
   * Manual close-out for an in-flight lot. Calls the
   * ``chefbyte.close_in_flight_lot`` RPC introduced in migration
   * 20260427110000_close_in_flight_lot_rpc.sql. The RPC enforces
   * ownership + the in_flight_since IS NOT NULL precondition; we only
   * surface the returned error here.
   *
   * Optimistic update: we eagerly clear ``in_flight_since`` on the
   * matching lot in the TanStack Query cache so the badge disappears
   * immediately. For 'discarded' / 'consumed' we also zero qty so the
   * row drops out of the visible list (mirrors what the realtime
   * invalidation will produce). 'returned' preserves qty on the server,
   * so we only clear in_flight_since locally. Roll back the previous
   * snapshot on error.
   */
  const closeInFlightMutation = useMutation({
    mutationFn: async ({
      lotId,
      resolution,
      note,
    }: {
      lotId: string;
      resolution: CloseInFlightResolution;
      note: string | null;
    }) => {
      const { error: err } = await (chefbyte() as any).rpc('close_in_flight_lot', {
        p_lot_id: lotId,
        p_resolution: resolution,
        p_note: note,
      });
      if (err) throw err;
    },
    onMutate: async ({ lotId, resolution }) => {
      const key = queryKeys.stockLots(user!.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<StockLot[]>(key);
      queryClient.setQueriesData<StockLot[]>({ queryKey: key }, (old) => {
        if (!old) return old;
        return old.map((l) => {
          if (l.lot_id !== lotId) return l;
          // 'returned' keeps qty as-is; the other two zero it.
          const nextQty = resolution === 'returned' ? l.qty_containers : 0;
          return { ...l, in_flight_since: null, qty_containers: nextQty };
        });
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // Roll back to the prior snapshot so a server-side failure doesn't
      // leave the user with a phantom "this lot is fine now" UI.
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.stockLots(user!.id), ctx.previous);
      }
    },
    onSettled: () => {
      invalidateInventory();
    },
  });

  const handleOpenCloseModal = (lotId: string, productName: string, pickupTs: string | null) => {
    setCloseModalLot({ lotId, productName, pickupTs });
  };

  const handleResolveClose = async ({
    resolution,
    note,
  }: {
    resolution: CloseInFlightResolution;
    note: string | null;
  }): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!closeModalLot) return { ok: false, error: 'no lot selected' };
    try {
      await closeInFlightMutation.mutateAsync({
        lotId: closeModalLot.lotId,
        resolution,
        note,
      });
      setCloseModalLot(null);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  };

  /**
   * "Consumed anyway" — user ate the expired food. Logs macros like a
   * normal consume. Uses consume_product to respect per-product macro
   * math (servings_per_container → kcal, etc). FIFO across lots is
   * acceptable here: the user picked the expired product because it's
   * the oldest, and FIFO will deplete the expired lot first.
   */
  const consumeExpiredMutation = useMutation({
    mutationFn: async ({ productId, qty }: { productId: string; qty: number }) => {
      const { error: err } = await (chefbyte() as any).rpc('consume_product', {
        p_product_id: productId,
        p_qty: qty,
        p_unit: 'container',
        p_log_macros: true,
        p_logical_date: getLogicalDate(),
      });
      if (err) throw err;
    },
    onError: (err: any) => setError(err.message ?? String(err)),
    onSuccess: () => setError(null),
    onSettled: () => invalidateInventory(),
  });

  const handleConsumeAll = (productId: string) => {
    const item = grouped.find((g) => g.product.product_id === productId);
    if (!item || item.totalStock <= 0) return;
    setConfirmState({
      open: true,
      action: () => {
        closeConfirm();
        consumeStockMutation.mutate({ productId, qty: item.totalStock, unit: 'container' });
      },
    });
  };

  /* ---------------------------------------------------------------- */
  /*  Stock badge color                                                */
  /* ---------------------------------------------------------------- */

  const stockDotColor = (totalStock: number, minStock: number): string => {
    if (totalStock <= 0) return 'bg-danger';
    if (totalStock < minStock) return 'bg-warning';
    return 'bg-success';
  };

  /* ---------------------------------------------------------------- */
  /*  Review queue — pending_review_count summed across shelf devices   */
  /* ---------------------------------------------------------------- */

  const { pendingReviewTotal, reviewUrl, reviewDisabledReason } = useMemo(
    () => computeReviewState(shelfDevices),
    [shelfDevices],
  );

  /* ---------------------------------------------------------------- */
  /*  Source pill                                                      */
  /* ---------------------------------------------------------------- */

  const sourceLabel: Record<NonNullable<GroupedProduct['latestSource']>, string> = {
    live_shelf: 'live shelf',
    live_scale: 'live scale',
    catch_all: 'catch-all',
  };

  /** Pill style per source kind — uses existing tokens, no new colors.
   * Exhaustive over the tightened `latestSource` type (manual is excluded
   * upstream, so there's no dead default branch). */
  const sourcePillCls = (src: NonNullable<GroupedProduct['latestSource']>): string => {
    switch (src) {
      case 'live_shelf':
        return 'bg-info-subtle text-info-text';
      case 'live_scale':
        return 'bg-success-subtle text-success-text';
      case 'catch_all':
        return 'bg-warning-subtle text-warning-text';
    }
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  const inputCls =
    'w-full px-3 py-2.5 border border-border-strong rounded-md text-sm bg-surface text-text focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary box-border';

  if (loading) {
    return (
      <ChefLayout title="Inventory">
        <div className="p-5" data-testid="inventory-loading">
          <ListSkeleton count={6} />
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Inventory">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="m-0 text-2xl font-bold text-text">Inventory</h1>
        {/* Review (N) button — deep-links to the Pi's local review UI.
            Always visible; disabled with tooltip when no device has a LAN IP. */}
        {reviewUrl ? (
          <a
            href={reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="inventory-review-btn"
            className="inline-flex items-center gap-2 bg-surface border border-border-strong text-text hover:bg-surface-hover px-3 py-1.5 rounded-lg text-sm font-semibold no-underline transition-colors"
          >
            Review ({pendingReviewTotal})
          </a>
        ) : (
          <button
            type="button"
            disabled
            title={reviewDisabledReason ?? ''}
            data-testid="inventory-review-btn-disabled"
            className="inline-flex items-center gap-2 bg-surface border border-border text-text-tertiary px-3 py-1.5 rounded-lg text-sm font-semibold opacity-60 cursor-not-allowed"
          >
            Review ({pendingReviewTotal})
          </button>
        )}
      </div>
      {loadError && (
        <div data-testid="load-error" className="bg-danger-subtle border border-danger rounded-lg p-3 mb-3">
          <p className="text-danger-text m-0 mb-2">Failed to load data: {loadError}</p>
          <button
            className="bg-success text-white border-none px-4 py-1.5 rounded-md cursor-pointer font-semibold text-sm hover:bg-success-hover"
            onClick={() => invalidateInventory()}
          >
            Retry
          </button>
        </div>
      )}
      {error && <p className="text-danger-text">{error}</p>}

      {/* aria-live status region for successful mutations. Visible toast
          for sighted users + announced by screen readers. The audit
          called out that trust signals are weak — this is the cheapest
          high-impact fix: every successful add/consume/discard now has
          an explicit confirmation. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="inventory-status"
        className={[
          'transition-all duration-200 overflow-hidden',
          statusMessage ? 'mb-3 max-h-12 opacity-100' : 'mb-0 max-h-0 opacity-0',
        ].join(' ')}
      >
        {statusMessage && (
          <div className="bg-success-subtle border border-emerald-300 text-emerald-800 rounded-md px-3 py-1.5 text-sm font-medium inline-flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            {statusMessage}
          </div>
        )}
      </div>

      {/* View toggle */}
      <div className="flex gap-2 mb-4" data-testid="inventory-view-toggle">
        <button
          className={`px-4 py-1.5 rounded-md cursor-pointer font-semibold border text-sm ${
            viewMode === 'grouped'
              ? 'bg-success text-white border-success'
              : 'bg-surface text-text-secondary border-border'
          }`}
          onClick={() => {
            setViewMode('grouped');
            setExpandedProductId(null);
          }}
        >
          Grouped
        </button>
        <button
          className={`px-4 py-1.5 rounded-md cursor-pointer font-semibold border text-sm ${
            viewMode === 'lots'
              ? 'bg-success text-white border-success'
              : 'bg-surface text-text-secondary border-border'
          }`}
          onClick={() => {
            setViewMode('lots');
            setExpandedProductId(null);
          }}
        >
          Lots
        </button>
      </div>

      {/* ========================================================== */}
      {/*  SEARCH FILTER                                               */}
      {/* ========================================================== */}
      <div className="my-3">
        <input
          placeholder="Search products..."
          aria-label="Search products"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setExpandedProductId(null);
          }}
          data-testid="inventory-search"
          className={inputCls}
        />
      </div>

      {/* Badge legend (collapse-by-default + permanently dismissible).
          R2: was always-rendered above the view toggle and pushed actual
          data below the fold on a phone-at-fridge first paint. Now lives
          below the toggle + search row, collapsed under a single
          "What do these badges mean?" trigger. After "Got it" the trigger
          stops appearing entirely (legendDismissed). The popped-out
          panel covers the same five badge meanings (Certified / On Scale
          / In Flight / source pill / stock dot) on demand. */}
      {!legendDismissed && (
        <div data-testid="inventory-legend-wrapper" className="mb-3">
          <button
            type="button"
            data-testid="inventory-legend-toggle"
            aria-expanded={legendOpen}
            aria-controls="inventory-legend-panel"
            onClick={() => setLegendOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text underline-offset-2 hover:underline transition-colors"
          >
            <Info className="w-3.5 h-3.5" aria-hidden="true" />
            {legendOpen ? 'Hide legend' : 'What do these badges mean?'}
          </button>
          {legendOpen && (
            <div
              id="inventory-legend-panel"
              data-testid="inventory-legend"
              className="bg-surface border border-border rounded-lg px-4 py-3 mt-2 flex items-start gap-3"
            >
              <Info className="w-4 h-4 text-info-text shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text m-0 mb-1">Quick legend</p>
                <ul className="text-xs text-text-secondary space-y-0.5 m-0 pl-0 list-none">
                  <li>
                    <span className="inline-flex items-center gap-1 mr-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-success align-middle" />{' '}
                      <span>In stock</span>
                    </span>
                    <span className="inline-flex items-center gap-1 mr-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-warning align-middle" />{' '}
                      <span>Low stock</span>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-danger align-middle" />{' '}
                      <span>Out of stock</span>
                    </span>
                  </li>
                  <li>
                    <CheckCircle2 className="inline w-3 h-3 text-emerald-700 align-middle" aria-hidden="true" />{' '}
                    <strong>Certified</strong> — calibrated for live shelf tracking.
                  </li>
                  <li>
                    <Scale className="inline w-3 h-3 text-sky-700 align-middle" aria-hidden="true" />{' '}
                    <strong>On Scale</strong> — currently sitting on a paired live scale.
                  </li>
                  <li>
                    <Activity className="inline w-3 h-3 text-amber-700 align-middle" aria-hidden="true" />{' '}
                    <strong>In Flight</strong> — picked up off the shelf (✋ "picked up — awaiting reunite"); click the
                    badge to close out.
                  </li>
                  <li>
                    <span className="inline-block px-1 rounded bg-info-subtle text-info-text text-[10px] font-semibold uppercase mr-1">
                      source
                    </span>
                    <strong>Source pill</strong> — most recent automated source for the lot (live shelf / live scale /
                    catch-all).
                  </li>
                  <li className="text-text-tertiary italic">
                    "container" (ctn) = one packaged unit of the product (e.g. one carton of milk).
                  </li>
                </ul>
              </div>
              <button
                type="button"
                onClick={dismissLegend}
                data-testid="inventory-legend-dismiss"
                aria-label="Got it — stop showing legend"
                title="Got it — stop showing this legend"
                className="p-1 rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text transition-colors shrink-0"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ========================================================== */}
      {/*  EXPIRED — DISCARD SECTION (top of list)                    */}
      {/* ========================================================== */}
      {viewMode === 'grouped' && expiredLots.length > 0 && (
        <div
          id="expired"
          ref={expiredSectionRef}
          data-testid="expired-section"
          className="mb-5 border-2 border-danger bg-danger-subtle rounded-lg overflow-hidden"
        >
          <div className="flex items-center gap-2 px-3 py-2 bg-danger text-white font-bold text-sm">
            <AlertTriangle className="w-4 h-4" />
            <span>Expired — discard ({expiredLots.length})</span>
          </div>
          <div className="flex flex-col">
            {expiredLots.map((lot) => {
              const days = daysExpired(lot.expires_on!);
              return (
                <div
                  key={lot.lot_id}
                  data-testid={`expired-lot-${lot.lot_id}`}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5 border-l-4 border-danger border-b border-border-light last:border-b-0 bg-surface"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-text">{lot.productName}</span>
                      <span
                        data-testid={`expired-chip-${lot.lot_id}`}
                        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-danger text-white"
                      >
                        {days === 0 ? 'expired today' : `${days} day${days === 1 ? '' : 's'} expired`}
                      </span>
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      <span className="line-through mr-2" data-testid={`expired-date-${lot.lot_id}`}>
                        Expires {lot.expires_on}
                      </span>
                      <span>
                        {formatQuantityWithVisual({
                          quantity: Number(lot.qty_containers),
                          unit: 'container',
                          visualUnitLabel: lot.product?.visual_unit_label ?? null,
                          visualUnitsPerServing:
                            lot.product?.visual_units_per_serving != null
                              ? Number(lot.product.visual_units_per_serving)
                              : null,
                          servingsPerContainer: Number(lot.product?.servings_per_container ?? 1),
                          canonicalDecimals: 1,
                        })}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      onClick={() => discardLotMutation.mutate({ lotId: lot.lot_id, productName: lot.productName })}
                      data-testid={`discard-lot-${lot.lot_id}`}
                      title="Mark this lot as tossed (qty → 0). Macros are NOT logged."
                      className="px-2.5 py-1 bg-danger text-white rounded text-xs font-semibold hover:bg-danger-hover transition-colors"
                    >
                      Mark as tossed
                    </button>
                    <button
                      onClick={() =>
                        consumeExpiredMutation.mutate({
                          productId: lot.product_id,
                          qty: Number(lot.qty_containers),
                        })
                      }
                      data-testid={`consume-anyway-${lot.lot_id}`}
                      className="px-2.5 py-1 bg-surface text-danger-text border border-danger rounded text-xs font-semibold hover:bg-danger-subtle transition-colors"
                    >
                      Consumed anyway
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/*  GROUPED VIEW                                                */}
      {/* ========================================================== */}
      {viewMode === 'grouped' && (
        <div data-testid="grouped-view">
          {filteredGrouped.length === 0 && (
            <p data-testid="no-products" className="text-text-secondary">
              No products in inventory. Scan a barcode or add products in Settings to get started.
            </p>
          )}

          {filteredGrouped.length > 0 && (
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {/* Table header */}
              <div className="grid grid-cols-[24px_1fr_80px] sm:grid-cols-[24px_1fr_100px_80px] gap-0 px-3 py-2 bg-surface-sunken border-b-2 border-border text-xs font-semibold text-text-secondary uppercase tracking-wide">
                <span />
                <span>Product</span>
                <span>Stock</span>
                <span className="hidden sm:block">Expiry</span>
              </div>

              {/* Product rows */}
              {filteredGrouped.map(
                ({ product, totalStock, nearestExpiry, latestSource, inFlightSince, anyLotOnScale }, idx) => {
                  const isZeroStock = totalStock <= 0;
                  // A zero-stock product that's currently in-flight is NOT really
                  // "missing" — it's off the shelf, waiting to be placed back.
                  // Skip the row dim (opacity-50 is the "out of stock reminder"
                  // treatment reserved for truly-empty products kept around as
                  // min-stock reminders) and replace the "0.0 ctn" numeric with
                  // a "(picked up)" label so the user immediately sees WHY the
                  // stock dropped to zero — the bottle is in their hand, not gone.
                  const isPickedUp = isZeroStock && inFlightSince !== null;
                  // servingsTotal moved into the ProductActionModal-driven
                  // computation block at the bottom of the file — was only
                  // used by the now-extracted "(servings)" detail label.
                  const isExpanded = expandedProductId === product.product_id;
                  const expiryLabel = nearestExpiry
                    ? new Date(nearestExpiry + 'T00:00:00').toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                      })
                    : '\u2014';

                  // Quick-edit (±) handlers — close over the product to avoid passing
                  // the loop var through callbacks. These fire the EXISTING add /
                  // consume mutations directly, no modal, default qty 1 ctn so
                  // the common case "I just bought another / used another" is a
                  // single tap. Modal still wins when you need to set an
                  // explicit expiry.
                  const onQuickAdd = (e: ReactMouseEvent) => {
                    e.stopPropagation();
                    if (!user || !locationId) return;
                    addStockMutation.mutate({ productId: product.product_id, qtyContainers: 1, expiresOn: null });
                  };
                  const onQuickSub = (e: ReactMouseEvent) => {
                    e.stopPropagation();
                    consumeStockMutation.mutate({
                      productId: product.product_id,
                      qty: 1,
                      unit: 'container',
                      productName: product.name,
                    });
                  };

                  const isPulsing = pulsingProductIds.has(product.product_id);
                  return (
                    <div
                      key={product.product_id}
                      data-testid={`inv-product-${product.product_id}`}
                      data-pulsing={isPulsing ? 'true' : undefined}
                      className={`relative ${idx < filteredGrouped.length - 1 ? 'border-b border-border-light' : ''} ${isZeroStock && !isPickedUp ? 'opacity-50' : ''} ${isPulsing ? 'animate-realtime-pulse' : ''}`}
                    >
                      {/* Collapsed row — always visible, clickable to toggle.
                          Inline ±-quick-edit buttons (below) sit ABOVE this
                          button via z-index + an end-padding to reserve room,
                          so a tap on a quick-edit button never bubbles to
                          the row toggle. Removes the modal-open requirement
                          for the common "+1 / -1 ctn" case (audit's #2 highest
                          impact change). */}
                      <button
                        type="button"
                        className={`grid grid-cols-[24px_1fr_80px] sm:grid-cols-[24px_1fr_100px_80px] gap-0 px-3 py-2.5 pr-[100px] items-center text-sm w-full text-left bg-transparent border-none cursor-pointer hover:bg-surface-hover transition-colors ${isExpanded ? 'bg-surface-hover' : ''}`}
                        onClick={() => setExpandedProductId(isExpanded ? null : product.product_id)}
                        aria-expanded={isExpanded}
                        data-testid={`inv-row-toggle-${product.product_id}`}
                      >
                        {/* Chevron indicator */}
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-text-tertiary" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-text-tertiary" />
                        )}

                        {/* Product name + stock dot + source pill */}
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${stockDotColor(totalStock, Number(product.min_stock_amount))}`}
                          />
                          <span className="font-semibold sm:whitespace-nowrap sm:overflow-hidden sm:text-ellipsis">
                            {product.name}
                          </span>
                          {/* Certified — per-product. ``products.certified``
                            flips true once the product completes calibration
                            (LiveTrack enrollment / scale tare capture) and is
                            ready for shelf events. Independent of On Scale +
                            In Flight; a certified product can sit on a shelf
                            (unpaired) just fine. */}
                          {product.certified === true && (
                            <span
                              data-testid={`certified-badge-${product.product_id}`}
                              title="Certified — calibrated and ready for live shelf tracking"
                              className="inline-flex items-center gap-1 shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 border border-emerald-200"
                              aria-label="Certified"
                            >
                              <CheckCircle2 className="w-2.5 h-2.5" aria-hidden="true" />
                              Certified
                            </span>
                          )}
                          {/* On Scale — per-product roll-up of any qty>0 lot
                            that is paired AND not in-flight. Independent of
                            In Flight: a lot in flight pulls "on scale" off
                            because the bottle is physically elsewhere. */}
                          {anyLotOnScale && (
                            <span
                              data-testid={`on-scale-badge-${product.product_id}`}
                              title="On Scale — a lot of this product is currently sitting on a paired live scale"
                              className="inline-flex items-center gap-1 shrink-0 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 border border-sky-200"
                              aria-label="On Scale"
                            >
                              <Scale className="w-2.5 h-2.5" aria-hidden="true" />
                              On Scale
                            </span>
                          )}
                          {/* Source pill — informational about the most-recent
                            automated source (live_shelf / live_scale / catch_all).
                            Kept for continuity; the dedicated On Scale badge
                            above is the precise paired-state signal now. */}
                          {latestSource && (
                            <span
                              data-testid={`source-pill-${product.product_id}`}
                              className={`inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sourcePillCls(latestSource)}`}
                            >
                              {sourceLabel[latestSource]}
                            </span>
                          )}
                          {/* In Flight — per-product, lights when ANY lot is
                            currently in-flight. Independent of On Scale +
                            Certified; the bottle is physically off the
                            shelf right now. Clickable: opens the close-out
                            modal scoped to the EARLIEST in-flight lot of
                            this product (matches the inFlightSince
                            timestamp shown). The grouped view uses
                            earliest-pickup-wins for the badge timestamp,
                            so we resolve the same lot here for the modal. */}
                          {inFlightSince &&
                            (() => {
                              const productLot = lots.find(
                                (l) => l.product_id === product.product_id && l.in_flight_since === inFlightSince,
                              );
                              // Note: the wrapping row is a <button>, so this
                              // affordance is rendered as a span with role
                              // ``button`` to avoid nested-button DOM nesting
                              // (invalid HTML — would cause hydration warnings
                              // and inconsistent click handling). Pointer events
                              // stop-propagation so clicking the badge does NOT
                              // also toggle the row's expand/collapse.
                              const openCloseOut = () => {
                                if (productLot) {
                                  handleOpenCloseModal(productLot.lot_id, product.name, productLot.in_flight_since);
                                }
                              };
                              return (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  data-testid="inflight-badge"
                                  title={`In Flight — picked up at ${new Date(inFlightSince).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}. Click to close out.`}
                                  className="inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200 cursor-pointer hover:bg-amber-200 transition-colors"
                                  aria-label="In Flight — click to close out"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openCloseOut();
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      openCloseOut();
                                    }
                                  }}
                                >
                                  <Activity className="w-2.5 h-2.5" aria-hidden="true" />
                                  In Flight
                                </span>
                              );
                            })()}
                        </div>

                        {/* Stock — "(picked up)" replaces the "0.0 ctn" numeric
                          when the product is zero-stock BUT in-flight. Keeps
                          the user from thinking the system lost the item.
                          The hand emoji + title explain that the stock is
                          off-shelf, not lost — addresses the audit finding
                          that the bare label looks like an error. */}
                        <span data-testid={`stock-badge-${product.product_id}`} className="font-semibold text-sm">
                          {isPickedUp ? (
                            <span
                              className="text-amber-800 italic"
                              title="Off-shelf right now — open the In Flight badge to close out (return / consume / discard)."
                            >
                              <span aria-hidden="true">✋ </span>(picked up)
                            </span>
                          ) : (
                            formatQuantityWithVisual({
                              quantity: totalStock,
                              unit: 'container',
                              visualUnitLabel: product.visual_unit_label ?? null,
                              visualUnitsPerServing:
                                product.visual_units_per_serving != null
                                  ? Number(product.visual_units_per_serving)
                                  : null,
                              servingsPerContainer: Number(product.servings_per_container) || 1,
                              canonicalDecimals: 1,
                            })
                          )}
                        </span>

                        {/* Expiry (hidden on small screens) */}
                        <span
                          data-testid={`expiry-${product.product_id}`}
                          className="text-[13px] text-text-secondary hidden sm:block"
                        >
                          {expiryLabel}
                        </span>
                      </button>

                      {/* Inline ±-quick-edit. Absolutely positioned over the
                          row's right edge — siblings of the <button> so they
                          don't create invalid nested-button DOM. The toggle
                          button reserves space via its right-padding so the
                          icons don't overlap content. Default qty is 1 ctn;
                          modal still opens via the chevron expand for an
                          explicit expiry. */}
                      <div
                        className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1"
                        data-testid={`quick-edit-${product.product_id}`}
                      >
                        <button
                          type="button"
                          onClick={onQuickSub}
                          disabled={isPickedUp || consumeStockMutation.isPending || isZeroStock}
                          aria-label={`Remove one container of ${product.name}`}
                          title="Remove 1 container"
                          data-testid={`quick-sub-${product.product_id}`}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border-strong bg-surface text-danger-text hover:bg-danger-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <Minus className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={onQuickAdd}
                          disabled={addStockMutation.isPending || !locationId}
                          aria-label={`Add one container of ${product.name}`}
                          title="Add 1 container"
                          data-testid={`quick-add-${product.product_id}`}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-emerald-300 bg-success-subtle text-emerald-700 hover:bg-emerald-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>

                      {/* Expanded detail panel was here — replaced by the
                          top-level <ProductActionModal>, which renders the
                          same action buttons inside a popup instead of
                          expanding the row in place. See user feedback:
                          "edit product should be a popup not expand in
                          place". The popup opens whenever
                          ``expandedProductId === product.product_id`` so
                          the row toggle (above) still drives the same
                          state machine — only the render location moved.
                          Same data-testids preserved on the buttons. */}
                    </div>
                  );
                },
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================== */}
      {/*  LOTS VIEW                                                   */}
      {/* ========================================================== */}
      {viewMode === 'lots' && (
        <div data-testid="lots-view">
          {filteredSortedLots.length === 0 && <p data-testid="no-lots">No stock lots.</p>}

          {filteredSortedLots.length > 0 && (
            <>
              {/* Mobile card list */}
              <div className="sm:hidden flex flex-col gap-2 mt-3" data-testid="lots-table">
                {filteredSortedLots.map((lot) => (
                  <div
                    key={lot.lot_id}
                    data-testid={`lot-row-${lot.lot_id}`}
                    className="bg-surface border border-border rounded-lg p-3"
                  >
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-semibold text-sm text-text">{lot.productName}</span>
                      {/* [MEAL] sentinel flag */}
                      {lot.isMealLot && (
                        <span
                          data-testid={`lot-meal-badge-${lot.lot_id}`}
                          className="inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-purple-100 text-purple-800 border border-purple-200"
                        >
                          [MEAL]
                        </span>
                      )}
                      {/* ✓ Certified — per-product. */}
                      {lot.productCertified && (
                        <span
                          data-testid={`lot-certified-badge-${lot.lot_id}`}
                          title="Certified — calibrated and ready for live shelf tracking"
                          className="inline-flex items-center gap-1 shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 border border-emerald-200"
                          aria-label="Certified"
                        >
                          <CheckCircle2 className="w-2.5 h-2.5" aria-hidden="true" />
                          Certified
                        </span>
                      )}
                      {/* ⚖ On Scale — per-lot, paired AND not in-flight. */}
                      {isLotOnScale(lot, pairedLotIds) && (
                        <span
                          data-testid={`lot-on-scale-badge-${lot.lot_id}`}
                          title="On Scale — this lot is currently sitting on a paired live scale"
                          className="inline-flex items-center gap-1 shrink-0 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 border border-sky-200"
                          aria-label="On Scale"
                        >
                          <Scale className="w-2.5 h-2.5" aria-hidden="true" />
                          On Scale
                        </span>
                      )}
                      {/* Source pill — informational about last automated source. */}
                      {shouldShowLotSourcePill(lot.last_update_source, lot.product_id, liveScalePairedProductIds) && (
                        <span
                          data-testid={`lot-source-pill-${lot.lot_id}`}
                          className={`inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sourcePillCls(lot.last_update_source as NonNullable<GroupedProduct['latestSource']>)}`}
                        >
                          {sourceLabel[lot.last_update_source as NonNullable<GroupedProduct['latestSource']>]}
                        </span>
                      )}
                      {/* ✋ In Flight — per-lot, off the shelf right now.
                        Clickable: opens close-out modal scoped to this lot. */}
                      {lot.in_flight_since && (
                        <button
                          type="button"
                          data-testid={`lot-inflight-badge-${lot.lot_id}`}
                          title={`In Flight — picked up at ${new Date(lot.in_flight_since).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}. Click to close out.`}
                          className="inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200 cursor-pointer hover:bg-amber-200 transition-colors"
                          aria-label="In Flight — click to close out"
                          onClick={() => handleOpenCloseModal(lot.lot_id, lot.productName, lot.in_flight_since)}
                        >
                          <Activity className="w-2.5 h-2.5" aria-hidden="true" />
                          In Flight
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-secondary">
                      <span data-testid={`lot-qty-${lot.lot_id}`}>
                        {Number(lot.qty_containers) <= 0 && lot.in_flight_since !== null ? (
                          <span
                            className="text-amber-800 italic"
                            title="Off-shelf right now — close out via the In Flight badge."
                          >
                            <span aria-hidden="true">✋ </span>(picked up)
                          </span>
                        ) : (
                          (() => {
                            const visualSet =
                              lot.visualUnitLabel != null &&
                              lot.visualUnitsPerServing != null &&
                              lot.visualUnitsPerServing > 0;
                            const visualHalf = visualSet
                              ? formatQuantityWithVisual({
                                  quantity: Number(lot.qty_containers),
                                  unit: 'container',
                                  visualUnitLabel: lot.visualUnitLabel,
                                  visualUnitsPerServing: lot.visualUnitsPerServing,
                                  servingsPerContainer: lot.servingsPerContainer,
                                })
                              : `${lot.qtyServings.toFixed(1)} svg`;
                            return `${Number(lot.qty_containers).toFixed(1)} ctn (${visualHalf})`;
                          })()
                        )}
                      </span>
                      {lot.last_observed_weight_g != null && (
                        <span title={lot.last_observed_at ?? undefined}>
                          On scale: {Number(lot.last_observed_weight_g).toFixed(1)}g
                        </span>
                      )}
                      <span>{lot.locations?.name ?? '\u2014'}</span>
                      <span>Expires: {lot.expires_on ?? '\u2014'}</span>
                      <span
                        data-testid={`lot-id-short-${lot.lot_id}`}
                        className="font-mono text-text-tertiary"
                        title={lot.lot_id}
                      >
                        #{lot.lot_id.slice(0, 8)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto rounded-lg border border-border mt-3">
                <table className="w-full border-collapse" data-testid="lots-table-desktop">
                  <thead>
                    <tr className="bg-surface-sunken border-b-2 border-border">
                      <th className="p-3 text-left font-semibold">Product</th>
                      <th className="p-3 text-left font-semibold">Location</th>
                      <th className="p-3 text-right font-semibold">Qty (ctn / svg)</th>
                      <th className="p-3 text-left font-semibold">Expires</th>
                      <th className="p-3 text-left font-semibold text-text-tertiary font-mono">Lot ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSortedLots.map((lot) => (
                      <tr
                        key={lot.lot_id}
                        data-testid={`lot-row-${lot.lot_id}`}
                        className="border-b border-border-light"
                      >
                        <td className="p-3">
                          <span className="inline-flex items-center gap-2 flex-wrap">
                            {lot.productName}
                            {/* [MEAL] sentinel flag */}
                            {lot.isMealLot && (
                              <span
                                data-testid={`lot-meal-badge-${lot.lot_id}`}
                                className="inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-purple-100 text-purple-800 border border-purple-200"
                              >
                                [MEAL]
                              </span>
                            )}
                            {/* ✓ Certified */}
                            {lot.productCertified && (
                              <span
                                data-testid={`lot-certified-badge-${lot.lot_id}`}
                                title="Certified — calibrated and ready for live shelf tracking"
                                className="inline-flex items-center gap-1 shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 border border-emerald-200"
                                aria-label="Certified"
                              >
                                <CheckCircle2 className="w-2.5 h-2.5" aria-hidden="true" />
                                Certified
                              </span>
                            )}
                            {/* ⚖ On Scale (per-lot) */}
                            {isLotOnScale(lot, pairedLotIds) && (
                              <span
                                data-testid={`lot-on-scale-badge-${lot.lot_id}`}
                                title="On Scale — this lot is currently sitting on a paired live scale"
                                className="inline-flex items-center gap-1 shrink-0 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 border border-sky-200"
                                aria-label="On Scale"
                              >
                                <Scale className="w-2.5 h-2.5" aria-hidden="true" />
                                On Scale
                              </span>
                            )}
                            {shouldShowLotSourcePill(
                              lot.last_update_source,
                              lot.product_id,
                              liveScalePairedProductIds,
                            ) && (
                              <span
                                data-testid={`lot-source-pill-${lot.lot_id}`}
                                className={`inline-flex items-center shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sourcePillCls(lot.last_update_source as NonNullable<GroupedProduct['latestSource']>)}`}
                              >
                                {sourceLabel[lot.last_update_source as NonNullable<GroupedProduct['latestSource']>]}
                              </span>
                            )}
                            {/* ✋ In Flight (per-lot) — clickable, opens
                              close-out modal scoped to this lot. */}
                            {lot.in_flight_since && (
                              <button
                                type="button"
                                data-testid={`lot-inflight-badge-${lot.lot_id}`}
                                title={`In Flight — picked up at ${new Date(lot.in_flight_since).toLocaleTimeString(
                                  [],
                                  {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  },
                                )}. Click to close out.`}
                                className="inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200 cursor-pointer hover:bg-amber-200 transition-colors"
                                aria-label="In Flight — click to close out"
                                onClick={() => handleOpenCloseModal(lot.lot_id, lot.productName, lot.in_flight_since)}
                              >
                                <Activity className="w-2.5 h-2.5" aria-hidden="true" />
                                In Flight
                              </button>
                            )}
                          </span>
                        </td>
                        <td className="p-3">{lot.locations?.name ?? '\u2014'}</td>
                        <td className="text-right p-3" data-testid={`lot-qty-${lot.lot_id}`}>
                          {Number(lot.qty_containers) <= 0 && lot.in_flight_since !== null ? (
                            <span
                              className="text-amber-800 italic"
                              title="Off-shelf right now — close out via the In Flight badge."
                            >
                              <span aria-hidden="true">✋ </span>(picked up)
                            </span>
                          ) : (
                            (() => {
                              const visualSet =
                                lot.visualUnitLabel != null &&
                                lot.visualUnitsPerServing != null &&
                                lot.visualUnitsPerServing > 0;
                              const visualHalf = visualSet
                                ? formatQuantityWithVisual({
                                    quantity: Number(lot.qty_containers),
                                    unit: 'container',
                                    visualUnitLabel: lot.visualUnitLabel,
                                    visualUnitsPerServing: lot.visualUnitsPerServing,
                                    servingsPerContainer: lot.servingsPerContainer,
                                  })
                                : `${lot.qtyServings.toFixed(1)} svg`;
                              return `${Number(lot.qty_containers).toFixed(1)} ctn (${visualHalf})`;
                            })()
                          )}
                        </td>
                        <td className="p-3">{lot.expires_on ?? '\u2014'}</td>
                        <td
                          className="p-3 font-mono text-xs text-text-tertiary"
                          data-testid={`lot-id-short-${lot.lot_id}`}
                          title={lot.lot_id}
                        >
                          #{lot.lot_id.slice(0, 8)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ========================================================== */}
      {/*  ADD STOCK MODAL                                              */}
      {/* ========================================================== */}
      <ModalOverlay
        isOpen={addingStockFor !== null}
        onClose={closeAddStockModal}
        title={`Add Stock \u2014 ${products.find((p) => p.product_id === addingStockFor)?.name ?? ''}`}
        testId="add-stock-modal"
      >
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-[0.85em] text-text-tertiary block mb-1">Quantity (containers)</label>
            <input
              type="number"
              aria-label="Quantity in containers"
              value={addStockQty}
              min={0.001}
              step={0.1}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) setAddStockQty(val);
              }}
              data-testid="add-stock-qty"
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-[0.85em] text-text-tertiary block mb-1">Expiry Date (optional)</label>
            <input
              type="date"
              aria-label="Expiry date"
              value={addStockExpiry}
              onChange={(e) => setAddStockExpiry(e.target.value)}
              data-testid="add-stock-expiry"
              className={inputCls}
            />
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <button
              className="bg-transparent text-text-secondary border-none px-4 py-1.5 rounded-md cursor-pointer hover:text-text"
              onClick={closeAddStockModal}
              data-testid="add-stock-cancel"
            >
              Cancel
            </button>
            <button
              className={`text-white border-none px-4 py-1.5 rounded-md cursor-pointer font-semibold ${
                addStockQty <= 0 ? 'bg-border cursor-not-allowed' : 'bg-success hover:bg-success-hover'
              }`}
              onClick={confirmAddStock}
              disabled={addStockQty <= 0}
              data-testid="add-stock-confirm"
            >
              Add
            </button>
          </div>
        </div>
      </ModalOverlay>

      <ConfirmModal
        open={confirmState.open}
        onConfirm={confirmState.action}
        onCancel={closeConfirm}
        title="Consume All Stock"
        message="Are you sure you want to consume all remaining stock for this product?"
        confirmLabel="Consume All"
      />

      {/* ========================================================== */}
      {/*  CLOSE IN-FLIGHT MODAL                                       */}
      {/* ========================================================== */}
      {/* `key` on lot_id forces a fresh component instance per lot — the
        modal's internal note/busy/error state resets without needing a
        useEffect-driven reset (which would trip the react-hooks
        cascading-render warning). When closeModalLot is null we still
        need a stable key, so we fall back to 'closed'. */}
      <CloseInFlightModal
        key={closeModalLot?.lotId ?? 'closed'}
        isOpen={closeModalLot !== null}
        lotId={closeModalLot?.lotId ?? null}
        productName={closeModalLot?.productName ?? null}
        pickupTs={closeModalLot?.pickupTs ?? null}
        onClose={() => setCloseModalLot(null)}
        onResolve={handleResolveClose}
      />

      {/* ========================================================== */}
      {/*  PRODUCT ACTION MODAL                                        */}
      {/* ========================================================== */}
      {/* Replaces the prior "expand the row in place" affordance with a
          modal popup. Drives off the same `expandedProductId` state the
          row toggle already manipulates — clicking the row opens the
          modal, clicking it again (or hitting Escape, or clicking the
          backdrop) closes it. Action button data-testids match the prior
          inline panel exactly so existing e2e + unit tests keep passing
          without rework. */}
      {(() => {
        const active = expandedProductId ? grouped.find((g) => g.product.product_id === expandedProductId) : null;
        if (!active) {
          return (
            <ProductActionModal
              isOpen={false}
              product={null}
              totalStock={0}
              servingsTotal={0}
              expiryLabel="—"
              isPickedUp={false}
              onClose={() => setExpandedProductId(null)}
              onOpenAddStock={openAddStockModal}
              onConsume={(args) => consumeStockMutation.mutate(args)}
              onConsumeAll={handleConsumeAll}
            />
          );
        }
        const isPickedUpActive = active.totalStock <= 0 && active.inFlightSince !== null;
        const servingsTotalActive = active.totalStock * Number(active.product.servings_per_container);
        const expiryLabelActive = active.nearestExpiry
          ? new Date(active.nearestExpiry + 'T00:00:00').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })
          : '—';
        return (
          <ProductActionModal
            isOpen={true}
            product={active.product}
            totalStock={active.totalStock}
            servingsTotal={servingsTotalActive}
            expiryLabel={expiryLabelActive}
            isPickedUp={isPickedUpActive}
            onClose={() => setExpandedProductId(null)}
            onOpenAddStock={openAddStockModal}
            onConsume={(args) => consumeStockMutation.mutate(args)}
            onConsumeAll={handleConsumeAll}
          />
        );
      })()}
    </ChefLayout>
  );
}
