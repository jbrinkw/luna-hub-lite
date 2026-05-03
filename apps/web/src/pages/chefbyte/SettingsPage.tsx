import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { WalmartTab } from '@/components/chefbyte/WalmartTab';
import { ScalesTab } from '@/components/chefbyte/ScalesTab';
import { BackupTab } from '@/components/chefbyte/BackupTab';
import { ClassifierTab } from '@/components/chefbyte/ClassifierTab';
import { EventViewerPage } from '@/pages/chefbyte/EventViewerPage';
import { ScannerTab } from './ScannerTab';
import { ScannerTransactionsTab } from './ScannerTransactionsTab';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { useChefbyteProducts, type ChefbyteProduct } from '@/shared/useChefbyteProducts';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

// Product type comes from the shared hook — re-export a local alias so
// the rest of this file can keep using the short name.
type Product = ChefbyteProduct & { default_expiry_days?: number | null };

// LiquidTrack retired 2026-04-21 — replaced by LiveTrack (live_scale kind
// under Scales tab + LiveTrack Import wizard). See
// supabase/migrations/20260421060000_retire_liquidtrack.sql for the DB drop.
type Tab =
  | 'products'
  | 'walmart'
  | 'scales'
  | 'scanner'
  | 'scanner-transactions'
  | 'locations'
  | 'classifier'
  | 'backup'
  | 'events';

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'products', label: 'Products', icon: '\uD83D\uDCE6' },
  { id: 'walmart', label: 'Walmart', icon: '\uD83C\uDFEA' },
  { id: 'scales', label: 'Scales', icon: '\u2696\uFE0F' },
  { id: 'scanner', label: 'Scanner', icon: '\uD83D\uDCF7' },
  { id: 'scanner-transactions', label: 'Scanner Txns', icon: '\uD83D\uDCCB' },
  { id: 'locations', label: 'Locations', icon: '\uD83D\uDCCD' },
  { id: 'classifier', label: 'Classifier', icon: '\uD83E\uDD16' },
  { id: 'events', label: 'Events', icon: '\uD83D\uDCDC' },
  { id: 'backup', label: 'Backup', icon: '\uD83D\uDCBE' },
];

/* ------------------------------------------------------------------ */
/*  Reusable Tailwind class strings                                    */
/* ------------------------------------------------------------------ */

const inputCls =
  'w-full px-3 py-2.5 border border-border-strong rounded-md text-sm box-border bg-surface text-text focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary';
const labelCls = 'block mb-1 font-semibold text-[13px] text-text-secondary';
const cardCls = 'border border-border rounded-lg p-3 mb-2 bg-surface';
const productCardCls = 'border border-border rounded-lg p-4 bg-surface min-h-[180px] flex flex-col';

/* ------------------------------------------------------------------ */
/*  Blank-product template for Add Product form                       */
/* ------------------------------------------------------------------ */

const blankProduct = (): Omit<Product, 'product_id' | 'user_id'> => ({
  name: '',
  barcode: null,
  description: null,
  servings_per_container: 1,
  calories_per_serving: 0,
  carbs_per_serving: 0,
  protein_per_serving: 0,
  fat_per_serving: 0,
  min_stock_amount: 0,
  is_placeholder: false,
  walmart_link: null,
  price: null,
  net_weight_g: null,
  is_distinct_unit_item: false,
  default_recipe_unit: null,
  tare_weight_g: null,
  measured_full_at: null,
  certified: null,
  default_expiry_days: null,
  visual_unit_label: null,
  visual_units_per_serving: null,
  display_by_weight: false,
});

/* ================================================================== */
/*  SettingsPage                                                       */
/* ================================================================== */

export function SettingsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab) || 'products';
  const [activeTab, setActiveTab] = useState<Tab>(tabs.some((t) => t.id === initialTab) ? initialTab : 'products');

  /* ---- Products state ---- */
  const [searchText, setSearchText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Product>>({});
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [addForm, setAddForm] = useState(blankProduct());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  /* ---- Locations state ---- */
  const [newLocationName, setNewLocationName] = useState('');
  const [deleteLocationTarget, setDeleteLocationTarget] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading via TanStack Query                                  */
  /* ---------------------------------------------------------------- */

  // Use the shared hook — applies deleted_at IS NULL + [MEAL] exclusion,
  // matching InventoryPage exactly. The shared hook uses queryKeys.products
  // which is already invalidated by all mutation onSettled calls below.
  const { data: products = [], isLoading: productsLoading } = useChefbyteProducts();

  const { data: locations = [], isLoading: locationsLoading } = useQuery({
    queryKey: queryKeys.locations(user!.id),
    queryFn: async () => {
      const { data, error: loadErr } = await chefbyte()
        .from('locations')
        .select('*')
        .eq('user_id', user!.id)
        .order('name');
      if (loadErr) throw loadErr;
      return (data ?? []) as { location_id: string; user_id: string; name: string; created_at: string }[];
    },
    enabled: !!user,
  });

  // Realtime: pick up changes the scanner (or other sessions) write to
  // chefbyte.products / chefbyte.locations without requiring a manual
  // reload. Channel-per-table per the hook's contract. ScalesTab owns
  // its own realtime subscription for live_shelf_devices.
  useRealtimeInvalidation('chef-settings', [
    {
      schema: 'chefbyte',
      table: 'products',
      queryKeys: [queryKeys.products(user!.id)],
    },
    {
      schema: 'chefbyte',
      table: 'locations',
      queryKeys: [queryKeys.locations(user!.id)],
    },
  ]);

  const loading = productsLoading || locationsLoading;

  /* ---------------------------------------------------------------- */
  /*  Product CRUD mutations                                           */
  /* ---------------------------------------------------------------- */

  const saveProductMutation = useMutation({
    mutationFn: async () => {
      if (!user || !editingId) throw new Error('Missing user or editing target');

      const { product_id: _pid, user_id: _uid, ...updates } = editForm as Product;
      const { error: updateErr } = await chefbyte().from('products').update(updates).eq('product_id', editingId);
      if (updateErr) throw updateErr;
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
    },
    onSuccess: () => {
      setEditingId(null);
      setEditForm({});
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
    },
  });

  const addProductMutation = useMutation({
    mutationFn: async () => {
      if (!user || !addForm.name.trim()) throw new Error('Missing name');
      const { error: insertErr } = await chefbyte()
        .from('products')
        .insert({ ...addForm, user_id: user.id });
      if (insertErr) throw insertErr;
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
    },
    onSuccess: () => {
      setAddForm(blankProduct());
      setShowAddProduct(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: async (productId: string) => {
      // Hard delete. Earlier iterations soft-deleted (set deleted_at) so
      // historical food_logs / stock_lots stayed intact, but that left
      // tombstone rows that poisoned rescans (the unique-on-barcode index
      // matched the dead row and the scanner short-circuited on it). User
      // intent on deletion is "make it gone" — so we hard-delete and let
      // ON DELETE policies on referencing rows decide. Stock_lots cascade
      // out, food_logs.product_id is set to NULL (history rows survive
      // with their cached macros), meal_plan_entries / recipe_ingredients
      // similarly clean up via FK rules.
      const { error: deleteErr } = await chefbyte().from('products').delete().eq('product_id', productId);
      if (deleteErr) throw deleteErr;
    },
    onMutate: async (productId) => {
      // Optimistic update operates on queryKeys.products — the cache key
      // used by useChefbyteProducts (same key invalidated by all mutations).
      const key = queryKeys.products(user!.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (old: Product[] | undefined) => old?.filter((p) => p.product_id !== productId));
      return { previous };
    },
    onError: (err: any, _id, context) => {
      queryClient.setQueryData(queryKeys.products(user!.id), context?.previous);
      setError(err.message ?? String(err));
    },
    onSuccess: () => {
      setDeleteTarget(null);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
    },
  });

  /* ---------------------------------------------------------------- */
  /*  Location mutations                                               */
  /* ---------------------------------------------------------------- */

  const addLocationMutation = useMutation({
    mutationFn: async () => {
      if (!user || !newLocationName.trim()) throw new Error('Missing location name');
      const { error: insertErr } = await chefbyte()
        .from('locations')
        .insert({ user_id: user.id, name: newLocationName.trim() });
      if (insertErr) throw insertErr;
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
    },
    onSuccess: () => {
      setNewLocationName('');
      queryClient.invalidateQueries({ queryKey: queryKeys.locations(user!.id) });
    },
  });

  const deleteLocationMutation = useMutation({
    mutationFn: async (locationId: string) => {
      const { count } = await chefbyte()
        .from('stock_lots')
        .select('*', { count: 'exact', head: true })
        .eq('location_id', locationId);
      if (count && count > 0) {
        throw new Error('Cannot delete location with existing stock. Move stock first.');
      }
      const { error: deleteErr } = await chefbyte().from('locations').delete().eq('location_id', locationId);
      if (deleteErr) throw deleteErr;
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
      setDeleteLocationTarget(null);
    },
    onSuccess: () => {
      setDeleteLocationTarget(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.locations(user!.id) });
    },
  });

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const filteredProducts = searchText
    ? products.filter((p) => p.name.toLowerCase().includes(searchText.toLowerCase()))
    : products;

  // Split into real (has barcode) vs placeholder (no barcode) so they
  // render in two separate sections in the products grid below. Per the
  // user's mental model, "placeholder" = a product entered without a
  // barcode (manually-typed or scan-fallback). The is_placeholder flag
  // is also set on these by the scanner, but barcode-null is the
  // user-facing definition.
  const realProducts = filteredProducts.filter((p) => p.barcode);
  const placeholderProducts = filteredProducts.filter((p) => !p.barcode);

  const startEdit = (p: Product) => {
    setEditingId(p.product_id);
    setEditForm({ ...p });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({});
  };

  // Card JSX shared by both the real-products grid and the placeholders
  // grid below. Closures capture startEdit / setDeleteTarget so callers
  // don't need to thread them through.
  const renderProductCard = (p: Product) => (
    <div key={p.product_id} data-testid={`product-${p.product_id}`} className={productCardCls}>
      <div className="flex flex-col flex-1">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h4 className="m-0 text-base font-semibold">{p.name}</h4>
          <div className="flex flex-wrap items-center gap-1 justify-end">
            {p.is_placeholder && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 border border-amber-200 whitespace-nowrap"
                title="Placeholder — macros are estimated. Will be promoted on barcode scan match."
                data-testid={`placeholder-badge-${p.product_id}`}
              >
                Placeholder
              </span>
            )}
            {p.tare_weight_g != null && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 border border-emerald-200 whitespace-nowrap"
                title={`LiveTrack enrolled (container tare ${Number(p.tare_weight_g).toFixed(1)} g)`}
                data-testid={`livetrack-enrolled-${p.product_id}`}
              >
                <span aria-hidden="true">✓</span>
                LiveTrack · {Number(p.tare_weight_g).toFixed(0)}g
              </span>
            )}
          </div>
        </div>
        {p.barcode && <span className="text-xs text-text-secondary mb-1.5 break-all">Barcode: {p.barcode}</span>}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 text-xs text-text-secondary flex-1">
          <span>Srv/Ctn: {Number(p.servings_per_container)}</span>
          <span>Cal: {Number(p.calories_per_serving)}</span>
          <span>C: {Number(p.carbs_per_serving)}g</span>
          <span>P: {Number(p.protein_per_serving)}g</span>
          <span>F: {Number(p.fat_per_serving)}g</span>
          <span>Min Stock: {Number(p.min_stock_amount)}</span>
          {(p as any).default_expiry_days != null && <span>Expiry: {(p as any).default_expiry_days}d</span>}
          {p.price != null && <span>Price: ${Number(p.price).toFixed(2)}</span>}
        </div>
        <div className="flex gap-2 mt-3 pt-2 border-t border-border-light">
          <button
            className="bg-emerald-600 text-white border-none px-3.5 py-1.5 rounded-md cursor-pointer font-semibold text-[13px] hover:bg-emerald-700"
            onClick={() => startEdit(p)}
            data-testid={`edit-product-${p.product_id}`}
          >
            Edit
          </button>
          <button
            onClick={() => setDeleteTarget(p.product_id)}
            data-testid={`delete-product-${p.product_id}`}
            className="bg-transparent border-none text-danger-text cursor-pointer font-semibold text-[13px] px-3.5 py-1.5 hover:text-red-700"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );

  /* ---------------------------------------------------------------- */
  /*  Render helpers                                                   */
  /* ---------------------------------------------------------------- */

  const renderProductFields = (
    form: Record<string, any>,
    onChange: (field: string, value: any) => void,
    testIdPrefix: string,
  ) => {
    const sectionHeaderCls =
      'text-[11px] font-bold uppercase tracking-wider text-text-tertiary pb-1.5 mb-2 border-b border-border-light';

    return (
      <div className="space-y-5">
        {/* Identity */}
        <div>
          <div className={sectionHeaderCls}>Identity</div>
          <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-3">
            <div>
              <label className={labelCls}>Name</label>
              <input
                value={form.name ?? ''}
                onChange={(e) => onChange('name', e.target.value)}
                data-testid={`${testIdPrefix}-name`}
                className={inputCls}
                placeholder="e.g. Great Value Chicken Breast"
              />
            </div>
            <div>
              <label className={labelCls}>Barcode</label>
              <input
                value={form.barcode ?? ''}
                onChange={(e) => onChange('barcode', e.target.value || null)}
                data-testid={`${testIdPrefix}-barcode`}
                className={inputCls}
                placeholder="UPC / EAN"
              />
            </div>
          </div>
        </div>

        {/* Nutrition */}
        <div>
          <div className={sectionHeaderCls}>
            Nutrition <span className="normal-case text-text-tertiary font-normal ml-1">· per serving</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <label className={labelCls}>Servings / container</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={form.servings_per_container ?? 1}
                onChange={(e) => onChange('servings_per_container', Number(e.target.value) || 1)}
                data-testid={`${testIdPrefix}-servings`}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                Calories <span className="text-text-tertiary font-normal">kcal · derived</span>
              </label>
              {/* Derived from C·4 + P·4 + F·9 (Atwater 4-4-9). Read-only:
                  user adjusts carbs/protein/fat and this updates live.
                  The change handlers below also push the derived value
                  back to form state so it persists on save. */}
              <input
                type="number"
                readOnly
                value={form.calories_per_serving ?? 0} // eslint-disable-line @luna/anti-lazy/no-numeric-coalesce-default -- reason: DB col NUMERIC NOT NULL DEFAULT 0; derived value resolves to 0 when all macros are 0
                data-testid={`${testIdPrefix}-calories`}
                className={`${inputCls} bg-surface-hover text-text-secondary cursor-not-allowed`}
                aria-readonly="true"
                title="Calculated from carbs × 4 + protein × 4 + fat × 9"
              />
            </div>
            <div>
              <label className={labelCls}>
                Carbs <span className="text-text-tertiary font-normal">g</span>
              </label>
              <input
                type="number"
                min="0"
                value={form.carbs_per_serving ?? 0} // eslint-disable-line @luna/anti-lazy/no-numeric-coalesce-default -- reason: DB col NUMERIC NOT NULL DEFAULT 0; zero is correct UI default for null macro
                onChange={(e) => {
                  const c = Number(e.target.value) || 0;
                  onChange('carbs_per_serving', c);
                  onChange(
                    'calories_per_serving',
                    Math.round(
                      c * 4 + (Number(form.protein_per_serving) || 0) * 4 + (Number(form.fat_per_serving) || 0) * 9,
                    ),
                  );
                }}
                data-testid={`${testIdPrefix}-carbs`}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                Protein <span className="text-text-tertiary font-normal">g</span>
              </label>
              <input
                type="number"
                min="0"
                value={form.protein_per_serving ?? 0} // eslint-disable-line @luna/anti-lazy/no-numeric-coalesce-default -- reason: DB col NUMERIC NOT NULL DEFAULT 0; zero is correct UI default for null macro
                onChange={(e) => {
                  const p = Number(e.target.value) || 0;
                  onChange('protein_per_serving', p);
                  onChange(
                    'calories_per_serving',
                    Math.round(
                      (Number(form.carbs_per_serving) || 0) * 4 + p * 4 + (Number(form.fat_per_serving) || 0) * 9,
                    ),
                  );
                }}
                data-testid={`${testIdPrefix}-protein`}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                Fat <span className="text-text-tertiary font-normal">g</span>
              </label>
              <input
                type="number"
                min="0"
                value={form.fat_per_serving ?? 0} // eslint-disable-line @luna/anti-lazy/no-numeric-coalesce-default -- reason: DB col NUMERIC NOT NULL DEFAULT 0; zero is correct UI default for null macro
                onChange={(e) => {
                  const f = Number(e.target.value) || 0;
                  onChange('fat_per_serving', f);
                  onChange(
                    'calories_per_serving',
                    Math.round(
                      (Number(form.carbs_per_serving) || 0) * 4 + (Number(form.protein_per_serving) || 0) * 4 + f * 9,
                    ),
                  );
                }}
                data-testid={`${testIdPrefix}-fat`}
                className={inputCls}
              />
            </div>
          </div>
        </div>

        {/* Inventory & Shopping */}
        <div>
          <div className={sectionHeaderCls}>Inventory &amp; Shopping</div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_2fr] gap-3">
            <div>
              <label className={labelCls}>
                Min stock <span className="text-text-tertiary font-normal">containers</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={form.min_stock_amount ?? 0} // eslint-disable-line @luna/anti-lazy/no-numeric-coalesce-default -- reason: 0 containers is the correct default minimum stock for a new product
                onChange={(e) => onChange('min_stock_amount', Number(e.target.value) || 0)}
                data-testid={`${testIdPrefix}-min-stock`}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>
                Default expiry <span className="text-text-tertiary font-normal">days</span>
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={form.default_expiry_days ?? ''}
                onChange={(e) => onChange('default_expiry_days', e.target.value ? Number(e.target.value) : null)}
                data-testid={`${testIdPrefix}-default-expiry-days`}
                placeholder="e.g. 7"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Price</label>
              <div className="relative">
                <span className="absolute inset-y-0 left-3 flex items-center text-text-tertiary pointer-events-none">
                  $
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.price ?? ''}
                  onChange={(e) => onChange('price', e.target.value ? Number(e.target.value) : null)}
                  data-testid={`${testIdPrefix}-price`}
                  placeholder="0.00"
                  className={`${inputCls} pl-6`}
                />
              </div>
            </div>
            <div>
              <label className={labelCls}>Walmart link</label>
              <input
                value={form.walmart_link ?? ''}
                onChange={(e) => onChange('walmart_link', e.target.value || null)}
                data-testid={`${testIdPrefix}-walmart-link`}
                placeholder="https://www.walmart.com/ip/..."
                className={inputCls}
              />
            </div>
          </div>
        </div>

        {/* Recipe defaults */}
        <div>
          <div className={sectionHeaderCls}>Recipe Defaults</div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr] gap-3 items-start">
            <div>
              <label className={labelCls}>
                Net weight <span className="text-text-tertiary font-normal">g</span>
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={form.net_weight_g ?? ''}
                onChange={(e) => onChange('net_weight_g', e.target.value ? Number(e.target.value) : null)}
                data-testid={`${testIdPrefix}-net-weight-g`}
                placeholder="e.g. 454"
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-text-tertiary">
                Full container mass. Required for gram-unit recipes.
              </p>
            </div>
            <div>
              <label className={labelCls}>Default recipe unit</label>
              <select
                value={form.default_recipe_unit ?? ''}
                onChange={(e) => onChange('default_recipe_unit', e.target.value === '' ? null : e.target.value)}
                data-testid={`${testIdPrefix}-default-recipe-unit`}
                className={inputCls}
              >
                <option value="">None (auto)</option>
                <option value="gram">Gram</option>
                <option value="serving">Serving</option>
                <option value="container">Container</option>
              </select>
              <p className="mt-1 text-[11px] text-text-tertiary">Initial unit when added to a recipe.</p>
              {form.default_recipe_unit === 'gram' && !(form.net_weight_g && form.net_weight_g > 0) && (
                <p
                  className="mt-1 text-[11px] text-red-600 font-semibold"
                  data-testid={`${testIdPrefix}-gram-unit-error`}
                >
                  Set net weight first
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>Item type</label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!form.is_distinct_unit_item}
                  onChange={(e) => onChange('is_distinct_unit_item', e.target.checked)}
                  data-testid={`${testIdPrefix}-distinct-unit`}
                  className="mt-0.5 h-4 w-4 accent-emerald-600"
                />
                <span className="text-sm font-semibold text-text">Distinct unit item</span>
              </label>
              <p className="text-[11px] text-text-tertiary ml-6">1 piece = 1 serving (eggs, buns, slices, bars)</p>
              <label className="flex items-start gap-2 cursor-pointer mt-1.5">
                <input
                  type="checkbox"
                  checked={!!form.display_by_weight}
                  onChange={(e) => {
                    onChange('display_by_weight', e.target.checked);
                    // Display-by-weight and visual_unit_label encode different
                    // intents; the helper resolves the conflict (weight wins),
                    // but clearing the visual fields here keeps the form
                    // truthful and prevents stale state on save.
                    if (e.target.checked) {
                      onChange('visual_unit_label', null);
                      onChange('visual_units_per_serving', null);
                    }
                  }}
                  data-testid={`${testIdPrefix}-display-by-weight`}
                  className="mt-0.5 h-4 w-4 accent-emerald-600"
                  disabled={!form.net_weight_g || form.net_weight_g <= 0}
                />
                <span className="text-sm font-semibold text-text">Display by weight</span>
              </label>
              <p className="text-[11px] text-text-tertiary ml-6">
                Render quantities in grams or ounces (per Hub unit-system preference). Requires net weight.
              </p>
            </div>
          </div>
        </div>

        {/* Visual unit (display-only) */}
        <div>
          <div className={sectionHeaderCls}>Visual Unit</div>
          <p className="m-0 mb-2 text-[11px] text-text-tertiary">
            Optional: display this product as e.g. &ldquo;2 eggs&rdquo; or &ldquo;1 slice&rdquo; instead of &ldquo;2
            svg&rdquo;. Display-only — backend math always uses canonical units.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-3">
            <div>
              <label className={labelCls}>Visual unit label</label>
              <input
                value={form.visual_unit_label ?? ''}
                onChange={(e) => onChange('visual_unit_label', e.target.value === '' ? null : e.target.value)}
                data-testid={`${testIdPrefix}-visual-unit-label`}
                placeholder="e.g. egg, slice, scoop"
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-text-tertiary">Singular noun. Pluralized automatically.</p>
            </div>
            <div>
              <label className={labelCls}>
                Visual units / serving <span className="text-text-tertiary font-normal">count</span>
              </label>
              <input
                type="number"
                min="0"
                step="any"
                value={form.visual_units_per_serving ?? ''}
                onChange={(e) =>
                  onChange('visual_units_per_serving', e.target.value === '' ? null : Number(e.target.value))
                }
                data-testid={`${testIdPrefix}-visual-units-per-serving`}
                placeholder="e.g. 1 (egg) or 0.5 (half-bagel)"
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-text-tertiary">Eggs: 1. Half-bagel-per-serving: 0.5.</p>
            </div>
          </div>
          {/* Inline pair-validation: both must be set together, value > 0 */}
          {(() => {
            const labelSet = form.visual_unit_label != null && String(form.visual_unit_label).trim() !== '';
            const countSet = form.visual_units_per_serving != null && Number(form.visual_units_per_serving) > 0;
            const partial = labelSet !== countSet;
            const zero = labelSet && countSet && Number(form.visual_units_per_serving) <= 0;
            if (partial) {
              return (
                <p
                  className="mt-1.5 text-[11px] text-amber-600 font-semibold"
                  data-testid={`${testIdPrefix}-visual-pair-error`}
                >
                  Set both label and units, or clear both.
                </p>
              );
            }
            if (zero) {
              return (
                <p
                  className="mt-1.5 text-[11px] text-red-600 font-semibold"
                  data-testid={`${testIdPrefix}-visual-units-zero`}
                >
                  Visual units must be greater than zero.
                </p>
              );
            }
            return null;
          })()}
        </div>
      </div>
    );
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Settings">
        <div data-testid="settings-loading" className="p-5">
          <ListSkeleton count={5} />
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Settings">
      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 text-2xl font-bold text-text">Settings</h1>
        <p className="mt-2 mb-0 text-text-secondary text-sm">Manage your products, devices, and data</p>
      </div>

      {error && (
        <p className="text-danger-text bg-danger-subtle px-3.5 py-2.5 rounded-md border border-danger mb-4">{error}</p>
      )}

      {/* Mobile tab select */}
      <div className="sm:hidden mb-3">
        <select
          value={activeTab}
          onChange={(e) => setActiveTab(e.target.value as Tab)}
          data-testid="settings-tabs"
          className="py-2.5 px-3 w-full rounded-lg border border-border text-sm bg-surface text-text"
        >
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.icon} {tab.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop Tabs */}
      <div className="hidden sm:flex gap-2 mb-6 bg-surface-hover p-1.5 rounded-xl w-fit" data-testid="settings-tabs">
        {tabs.map((tab) => (
          <button
            className={`px-5 py-2.5 border-none rounded-lg cursor-pointer font-semibold text-sm transition-all flex items-center gap-2 ${
              activeTab === tab.id ? 'bg-surface text-text shadow-sm' : 'bg-transparent text-text-secondary'
            }`}
            onClick={() => setActiveTab(tab.id)}
            key={tab.id}
          >
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content Container */}
      <div className="bg-surface rounded-xl border border-border min-h-[400px] shadow-sm">
        {/* ========================================================== */}
        {/*  PRODUCTS TAB                                                */}
        {/* ========================================================== */}
        {activeTab === 'products' && (
          <div data-testid="products-tab" className="p-5">
            {/* Section Header */}
            <div className="mb-4 pb-3 border-b border-border">
              <h2 className="m-0 text-lg font-bold text-text">Product Library</h2>
              <p className="m-0 mt-1 text-sm text-text-secondary">Manage your product catalog and nutritional info</p>
            </div>

            {/* Search bar */}
            <input
              placeholder="Search products..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              data-testid="product-search"
              className={`${inputCls} mb-4`}
            />

            {/* Add Product */}
            <div data-testid="add-product-section" className={`${cardCls} !mb-5`}>
              <div className={`flex justify-between items-center ${showAddProduct ? 'mb-4' : ''}`}>
                <h3 className="m-0 text-base font-bold text-text">Add Product</h3>
                <button
                  className={`text-white border-none rounded-md cursor-pointer font-semibold text-[13px] px-3.5 py-1.5 ${
                    showAddProduct ? 'bg-text-secondary' : 'bg-green-600 hover:bg-green-700'
                  }`}
                  onClick={() => setShowAddProduct(!showAddProduct)}
                  data-testid="toggle-add-product"
                >
                  {showAddProduct ? 'Cancel' : '+ New'}
                </button>
              </div>
              {showAddProduct && (
                <div data-testid="add-product-form">
                  {renderProductFields(
                    addForm,
                    (field, value) => setAddForm((prev) => ({ ...prev, [field]: value })),
                    'add',
                  )}
                  <button
                    className="mt-3 bg-emerald-600 text-white border-none w-full py-3 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    onClick={() => addProductMutation.mutate()}
                    disabled={
                      !addForm.name.trim() ||
                      (addForm.default_recipe_unit === 'gram' && !(addForm.net_weight_g && addForm.net_weight_g > 0))
                    }
                    data-testid="save-new-product"
                  >
                    Save Product
                  </button>
                </div>
              )}
            </div>

            {/* Product list — complete (have a barcode) first, then placeholders */}
            <div className="mb-3 pb-2 border-b border-border-light flex items-baseline gap-3 flex-wrap">
              <span className="text-sm font-semibold text-text-secondary">
                {filteredProducts.length} product{filteredProducts.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Complete products section (have a barcode) */}
            {realProducts.length > 0 && (
              <>
                <h3
                  className="text-[11px] font-bold uppercase tracking-wider text-text-tertiary mb-2"
                  data-testid="real-products-heading"
                >
                  Complete products ({realProducts.length})
                </h3>
                <div
                  data-testid="product-list"
                  className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-3"
                >
                  {realProducts.map((p) => renderProductCard(p))}
                </div>
              </>
            )}

            {/* Placeholder products section (no barcode — manually entered or scan-fallback) */}
            {placeholderProducts.length > 0 && (
              <>
                <h3
                  className="text-[11px] font-bold uppercase tracking-wider text-text-tertiary mt-6 mb-2"
                  data-testid="placeholder-products-heading"
                >
                  Placeholders ({placeholderProducts.length})
                  <span className="ml-2 font-normal normal-case text-text-tertiary">
                    — no barcode; will be promoted on scan match
                  </span>
                </h3>
                <div
                  data-testid="placeholder-product-list"
                  className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-3"
                >
                  {placeholderProducts.map((p) => renderProductCard(p))}
                </div>
              </>
            )}

            {/* Edit Product Modal */}
            {editingId !== null &&
              (() => {
                const editingProduct = products.find((p) => p.product_id === editingId);
                return (
                  <div
                    className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4"
                    onClick={cancelEdit}
                    data-testid="edit-product-modal-backdrop"
                  >
                    <div
                      className="bg-surface rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
                      onClick={(e) => e.stopPropagation()}
                      data-testid="edit-product-modal"
                    >
                      <div className="flex items-baseline justify-between px-5 pt-5 pb-3 border-b border-border-light">
                        <h3 className="m-0 text-lg font-bold">Edit: {editingProduct?.name}</h3>
                        <span className="text-xs text-text-tertiary">{editingProduct?.barcode ?? 'no barcode'}</span>
                      </div>
                      <div className="px-5 py-4">
                        {renderProductFields(
                          editForm,
                          (field, value) => setEditForm((prev) => ({ ...prev, [field]: value })),
                          'edit',
                        )}
                      </div>
                      <div className="flex gap-2 px-5 pb-5 pt-2 border-t border-border-light">
                        <button
                          className="bg-emerald-600 text-white border-none px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                          onClick={() => saveProductMutation.mutate()}
                          data-testid="save-edit-product"
                          disabled={
                            editForm.default_recipe_unit === 'gram' &&
                            !(editForm.net_weight_g && editForm.net_weight_g > 0)
                          }
                        >
                          Save
                        </button>
                        <button
                          className="bg-surface text-text-secondary border border-border px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-surface-hover"
                          onClick={cancelEdit}
                          data-testid="cancel-edit-product"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}

            {/* Delete confirmation dialog */}
            {deleteTarget !== null && (
              <div
                className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
                onClick={() => setDeleteTarget(null)}
              >
                <div
                  className="bg-surface rounded-xl shadow-xl p-5 max-w-sm w-full mx-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="m-0 mb-3 text-lg font-bold">Delete Product</h3>
                  <p className="text-text-secondary m-0 mb-5">
                    Are you sure you want to delete this product? This cannot be undone.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      className="bg-surface text-text-secondary border border-border px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-surface-hover"
                      onClick={() => setDeleteTarget(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="bg-red-600 text-white border-none px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-red-700"
                      onClick={() => {
                        if (deleteTarget) deleteProductMutation.mutate(deleteTarget);
                      }}
                      autoFocus
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================== */}
        {/*  WALMART TAB                                                 */}
        {/* ========================================================== */}
        {activeTab === 'walmart' && (
          <div data-testid="walmart-tab" className="p-5">
            <div className="mb-4 pb-3 border-b border-border">
              <h2 className="m-0 text-lg font-bold text-text">Walmart Price Manager</h2>
              <p className="m-0 mt-1 text-sm text-text-secondary">Track and update Walmart prices for your products</p>
            </div>
            <WalmartTab />
          </div>
        )}

        {/* ========================================================== */}
        {/*  SCALES TAB (Live Shelf Pi devices)                          */}
        {/* ========================================================== */}
        {activeTab === 'scales' && <ScalesTab />}

        {/* ========================================================== */}
        {/*  SCANNER TAB (lock-to-mode toggle)                           */}
        {/* ========================================================== */}
        {activeTab === 'scanner' && <ScannerTab />}

        {/* ========================================================== */}
        {/*  SCANNER TRANSACTIONS TAB (audit log + void)                 */}
        {/* ========================================================== */}
        {activeTab === 'scanner-transactions' && <ScannerTransactionsTab />}

        {/* ========================================================== */}
        {/*  LOCATIONS TAB                                               */}
        {/* ========================================================== */}
        {activeTab === 'locations' && (
          <div data-testid="locations-tab" className="p-5">
            <div className="mb-4 pb-3 border-b border-border">
              <h2 className="m-0 text-lg font-bold text-text">Storage Locations</h2>
              <p className="m-0 mt-1 text-sm text-text-secondary">Define where you store your inventory items</p>
            </div>
            <div data-testid="locations-section" className={cardCls}>
              <h3 className="m-0 mb-4 text-base font-bold text-text">Manage Locations</h3>

              {/* Existing locations list */}
              {locations.length === 0 ? (
                <p className="text-text-tertiary italic" data-testid="no-locations-msg">
                  No locations yet. Add one below.
                </p>
              ) : (
                <div data-testid="location-list" className="flex flex-col gap-2 mb-4">
                  {locations.map((loc) => (
                    <div
                      key={loc.location_id}
                      data-testid={`location-${loc.location_id}`}
                      className="flex justify-between items-center px-3 py-2.5 border border-border-light rounded-md bg-surface-sunken"
                    >
                      <span className="font-medium">{loc.name}</span>
                      <button
                        onClick={() => setDeleteLocationTarget(loc.location_id)}
                        data-testid={`delete-location-${loc.location_id}`}
                        className="bg-transparent border-none text-danger-text cursor-pointer font-semibold text-[13px] px-2 py-1 hover:text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add location form */}
              <div className="flex gap-2 items-center mt-3" data-testid="add-location-form">
                <input
                  placeholder="New location name..."
                  value={newLocationName}
                  onChange={(e) => setNewLocationName(e.target.value)}
                  data-testid="location-name-input"
                  className={`${inputCls} flex-1`}
                />
                <button
                  className="bg-emerald-600 text-white border-none px-4 py-2.5 rounded-md cursor-pointer font-semibold text-sm whitespace-nowrap hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={() => addLocationMutation.mutate()}
                  disabled={!newLocationName.trim()}
                  data-testid="add-location-btn"
                >
                  Add Location
                </button>
              </div>
            </div>

            {/* Delete location confirmation dialog */}
            {deleteLocationTarget !== null && (
              <div
                className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
                onClick={() => setDeleteLocationTarget(null)}
              >
                <div
                  className="bg-surface rounded-xl shadow-xl p-5 max-w-sm w-full mx-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="m-0 mb-3 text-lg font-bold">Delete Location</h3>
                  <p className="text-text-secondary m-0 mb-5">
                    Are you sure you want to delete this location? This cannot be undone.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      className="bg-surface text-text-secondary border border-border px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-surface-hover"
                      onClick={() => setDeleteLocationTarget(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="bg-red-600 text-white border-none px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-red-700"
                      onClick={() => {
                        if (deleteLocationTarget) deleteLocationMutation.mutate(deleteLocationTarget);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================== */}
        {/*  CLASSIFIER TAB                                              */}
        {/* ========================================================== */}
        {activeTab === 'classifier' && <ClassifierTab />}

        {activeTab === 'events' && <EventViewerPage embedded />}

        {/* ========================================================== */}
        {/*  BACKUP TAB                                                  */}
        {/* ========================================================== */}
        {activeTab === 'backup' && <BackupTab />}
      </div>
    </ChefLayout>
  );
}
