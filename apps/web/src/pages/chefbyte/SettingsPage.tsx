import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { WalmartTab } from '@/components/chefbyte/WalmartTab';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { Copy, Check } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Product {
  product_id: string;
  user_id: string;
  name: string;
  barcode: string | null;
  description: string | null;
  servings_per_container: number;
  calories_per_serving: number;
  carbs_per_serving: number;
  protein_per_serving: number;
  fat_per_serving: number;
  min_stock_amount: number;
  is_placeholder: boolean;
  walmart_link: string | null;
  price: number | null;
}

interface LiquidTrackDevice {
  device_id: string;
  user_id: string;
  device_name: string;
  product_id: string | null;
  import_key_hash: string;
  is_active: boolean;
  created_at: string;
  products: { name: string } | null;
}

interface LiquidTrackEvent {
  event_id: string;
  created_at: string;
  weight_before: number;
  weight_after: number;
  consumption: number;
  calories: number | null;
  carbs: number | null;
  protein: number | null;
  fat: number | null;
  is_refill: boolean;
}

type Tab = 'products' | 'walmart' | 'liquidtrack' | 'locations';

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'products', label: 'Products', icon: '\uD83D\uDCE6' },
  { id: 'walmart', label: 'Walmart', icon: '\uD83C\uDFEA' },
  { id: 'liquidtrack', label: 'LiquidTrack', icon: '\uD83E\uDD64' },
  { id: 'locations', label: 'Locations', icon: '\uD83D\uDCCD' },
];

/* ------------------------------------------------------------------ */
/*  Reusable Tailwind class strings                                    */
/* ------------------------------------------------------------------ */

const inputCls =
  'w-full px-3 py-2.5 border border-border-strong rounded-md text-sm box-border focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary';
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

  /* ---- LiquidTrack state ---- */
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceProductId, setNewDeviceProductId] = useState('');
  const [generatedDevice, setGeneratedDevice] = useState<{ device_id: string; raw_key: string } | null>(null);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [deviceEvents, setDeviceEvents] = useState<LiquidTrackEvent[]>([]);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ---- Clipboard copy feedback ---- */
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Fallback: no-op
    }
  };

  /* ---- Locations state ---- */
  const [newLocationName, setNewLocationName] = useState('');
  const [deleteLocationTarget, setDeleteLocationTarget] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading via TanStack Query                                  */
  /* ---------------------------------------------------------------- */

  const { data: products = [], isLoading: productsLoading } = useQuery({
    queryKey: queryKeys.chefSettings(user!.id),
    queryFn: async () => {
      const { data, error: loadErr } = await chefbyte()
        .from('products')
        .select('*')
        .eq('user_id', user!.id)
        .not('name', 'ilike', '[MEAL]%')
        .order('name');
      if (loadErr) throw loadErr;
      return (data ?? []) as Product[];
    },
    enabled: !!user,
  });

  const { data: devices = [], isLoading: devicesLoading } = useQuery({
    queryKey: queryKeys.devices(user!.id),
    queryFn: async () => {
      const { data, error: loadErr } = await chefbyte()
        .from('liquidtrack_devices')
        .select('*, products:product_id(name)')
        .eq('user_id', user!.id);
      if (loadErr) throw loadErr;
      return (data ?? []) as LiquidTrackDevice[];
    },
    enabled: !!user,
  });

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

  const loading = productsLoading || devicesLoading || locationsLoading;

  /* ---------------------------------------------------------------- */
  /*  Product CRUD mutations                                           */
  /* ---------------------------------------------------------------- */

  const saveProductMutation = useMutation({
    mutationFn: async () => {
      if (!user || !editingId) throw new Error('Missing user or editing target');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      queryClient.invalidateQueries({ queryKey: queryKeys.chefSettings(user!.id) });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.chefSettings(user!.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: async (productId: string) => {
      const { error: deleteErr } = await chefbyte().from('products').delete().eq('product_id', productId);
      if (deleteErr) throw deleteErr;
    },
    onMutate: async (productId) => {
      const key = queryKeys.chefSettings(user!.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (old: Product[] | undefined) => old?.filter((p) => p.product_id !== productId));
      return { previous };
    },
    onError: (err: any, _id, context) => {
      queryClient.setQueryData(queryKeys.chefSettings(user!.id), context?.previous);
      setError(err.message ?? String(err));
    },
    onSuccess: () => {
      setDeleteTarget(null);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chefSettings(user!.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.products(user!.id) });
    },
  });

  /* ---------------------------------------------------------------- */
  /*  LiquidTrack mutations                                            */
  /* ---------------------------------------------------------------- */

  const generateDeviceMutation = useMutation({
    mutationFn: async () => {
      if (!user || !newDeviceName.trim()) throw new Error('Missing device name');

      const deviceId = crypto.randomUUID();
      const rawKey = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

      // Hash the key with SHA-256
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const keyHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

      const { error: insertErr } = await chefbyte()
        .from('liquidtrack_devices')
        .insert({
          device_id: deviceId,
          user_id: user.id,
          device_name: newDeviceName.trim(),
          product_id: newDeviceProductId || null,
          import_key_hash: keyHash,
        });
      if (insertErr) throw insertErr;

      return { device_id: deviceId, raw_key: rawKey };
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
    },
    onSuccess: (result) => {
      setGeneratedDevice(result);
      setNewDeviceName('');
      setNewDeviceProductId('');
      setShowAddDevice(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.devices(user!.id) });
    },
  });

  const revokeDeviceMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const { error: revokeErr } = await chefbyte()
        .from('liquidtrack_devices')
        .update({ is_active: false })
        .eq('device_id', deviceId);
      if (revokeErr) throw revokeErr;
    },
    onError: (err: any) => {
      setError(err.message ?? String(err));
    },
    onSuccess: () => {
      setRevokeTarget(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.devices(user!.id) });
    },
  });

  const loadDeviceEvents = useCallback(
    async (deviceId: string) => {
      if (!user) return;
      if (expandedDeviceId === deviceId) {
        setExpandedDeviceId(null);
        setDeviceEvents([]);
        return;
      }
      const { data } = await chefbyte()
        .from('liquidtrack_events')
        .select('*')
        .eq('device_id', deviceId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      setDeviceEvents((data ?? []) as LiquidTrackEvent[]);
      setExpandedDeviceId(deviceId);
    },
    [user, expandedDeviceId],
  );

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

  const startEdit = (p: Product) => {
    setEditingId(p.product_id);
    setEditForm({ ...p });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({});
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  /* ---------------------------------------------------------------- */
  /*  Render helpers                                                   */
  /* ---------------------------------------------------------------- */

  const renderProductFields = (
    form: Record<string, any>,
    onChange: (field: string, value: any) => void,
    testIdPrefix: string,
  ) => (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      <div>
        <label className={labelCls}>Name</label>
        <input
          value={form.name ?? ''}
          onChange={(e) => onChange('name', e.target.value)}
          data-testid={`${testIdPrefix}-name`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Barcode</label>
        <input
          value={form.barcode ?? ''}
          onChange={(e) => onChange('barcode', e.target.value || null)}
          data-testid={`${testIdPrefix}-barcode`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Servings/Container</label>
        <input
          type="number"
          min="0"
          value={form.servings_per_container ?? 1}
          onChange={(e) => onChange('servings_per_container', Number(e.target.value) || 1)}
          data-testid={`${testIdPrefix}-servings`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Calories/Serving</label>
        <input
          type="number"
          min="0"
          value={form.calories_per_serving ?? 0}
          onChange={(e) => onChange('calories_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-calories`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Carbs/Serving</label>
        <input
          type="number"
          min="0"
          value={form.carbs_per_serving ?? 0}
          onChange={(e) => onChange('carbs_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-carbs`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Protein/Serving</label>
        <input
          type="number"
          min="0"
          value={form.protein_per_serving ?? 0}
          onChange={(e) => onChange('protein_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-protein`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Fat/Serving</label>
        <input
          type="number"
          min="0"
          value={form.fat_per_serving ?? 0}
          onChange={(e) => onChange('fat_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-fat`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Min Stock</label>
        <input
          type="number"
          min="0"
          value={form.min_stock_amount ?? 0}
          onChange={(e) => onChange('min_stock_amount', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-min-stock`}
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Walmart Link</label>
        <input
          value={form.walmart_link ?? ''}
          onChange={(e) => onChange('walmart_link', e.target.value || null)}
          data-testid={`${testIdPrefix}-walmart-link`}
          placeholder="https://www.walmart.com/ip/..."
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Price</label>
        <input
          type="number"
          min="0"
          value={form.price ?? ''}
          onChange={(e) => onChange('price', e.target.value ? Number(e.target.value) : null)}
          data-testid={`${testIdPrefix}-price`}
          placeholder="$0.00"
          className={inputCls}
        />
      </div>
    </div>
  );

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
          className="py-2.5 px-3 w-full rounded-lg border border-border text-sm"
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
                    disabled={!addForm.name.trim()}
                    data-testid="save-new-product"
                  >
                    Save Product
                  </button>
                </div>
              )}
            </div>

            {/* Product list */}
            <div className="mb-3 pb-2 border-b border-border-light">
              <span className="text-sm font-semibold text-text-secondary">
                {filteredProducts.length} product{filteredProducts.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div
              data-testid="product-list"
              className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-3"
            >
              {filteredProducts.map((p) => (
                <div key={p.product_id} data-testid={`product-${p.product_id}`} className={productCardCls}>
                  {editingId === p.product_id ? (
                    /* Editing mode */
                    <div>
                      {renderProductFields(
                        editForm,
                        (field, value) => setEditForm((prev) => ({ ...prev, [field]: value })),
                        'edit',
                      )}
                      <div className="flex gap-2 mt-3">
                        <button
                          className="bg-emerald-600 text-white border-none px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700"
                          onClick={() => saveProductMutation.mutate()}
                          data-testid="save-edit-product"
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
                  ) : (
                    /* Display mode */
                    <div className="flex flex-col flex-1">
                      <h4 className="m-0 mb-2 text-base font-semibold">{p.name}</h4>
                      {p.barcode && (
                        <span className="text-xs text-text-secondary mb-1.5 break-all">Barcode: {p.barcode}</span>
                      )}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 text-xs text-text-secondary flex-1">
                        <span>Srv/Ctn: {Number(p.servings_per_container)}</span>
                        <span>Cal: {Number(p.calories_per_serving)}</span>
                        <span>C: {Number(p.carbs_per_serving)}g</span>
                        <span>P: {Number(p.protein_per_serving)}g</span>
                        <span>F: {Number(p.fat_per_serving)}g</span>
                        <span>Min Stock: {Number(p.min_stock_amount)}</span>
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
                  )}
                </div>
              ))}
            </div>

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
        {/*  LIQUIDTRACK TAB                                             */}
        {/* ========================================================== */}
        {activeTab === 'liquidtrack' && (
          <div data-testid="liquidtrack-tab" className="p-5">
            {/* Section Header */}
            <div className="mb-4 pb-3 border-b border-border">
              <h2 className="m-0 text-lg font-bold text-text">LiquidTrack Devices</h2>
              <p className="m-0 mt-1 text-sm text-text-secondary">Manage IoT scale devices and view event history</p>
            </div>

            {/* Add Device */}
            <div data-testid="add-device-section" className={cardCls}>
              <div className={`flex justify-between items-center ${showAddDevice ? 'mb-4' : ''}`}>
                <h3 className="m-0 text-base font-bold text-text">Add Device</h3>
                <button
                  className={`text-white border-none rounded-md cursor-pointer font-semibold text-[13px] px-3.5 py-1.5 ${
                    showAddDevice ? 'bg-text-secondary' : 'bg-emerald-600 hover:bg-emerald-700'
                  }`}
                  onClick={() => setShowAddDevice(!showAddDevice)}
                  data-testid="toggle-add-device"
                >
                  {showAddDevice ? 'Cancel' : '+ New'}
                </button>
              </div>
              {showAddDevice && (
                <div data-testid="add-device-form" className="flex flex-col gap-3">
                  <div>
                    <label className={labelCls}>Device Name</label>
                    <input
                      value={newDeviceName}
                      onChange={(e) => setNewDeviceName(e.target.value)}
                      data-testid="device-name-input"
                      className={inputCls}
                      placeholder="e.g. Kitchen Scale"
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Product</label>
                    <select
                      value={newDeviceProductId}
                      onChange={(e) => setNewDeviceProductId(e.target.value)}
                      data-testid="device-product-select"
                      className={inputCls}
                    >
                      <option value="">Select product (optional)</option>
                      {products.map((p) => (
                        <option key={p.product_id} value={p.product_id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="bg-emerald-600 text-white border-none w-full py-3 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    onClick={() => generateDeviceMutation.mutate()}
                    disabled={!newDeviceName.trim()}
                    data-testid="generate-device-btn"
                  >
                    Generate Device
                  </button>
                </div>
              )}
            </div>

            {/* Generated device info */}
            {generatedDevice && (
              <div
                data-testid="generated-device-info"
                className="border-2 border-success rounded-lg p-3 mb-2 bg-success-subtle"
              >
                <h3 className="m-0 mb-3 text-base font-bold text-success-text">Device Created!</h3>
                <div className="flex items-center gap-2 mb-2">
                  <strong>Device ID:</strong>
                  <code className="bg-border px-1.5 py-0.5 rounded text-[13px]">{generatedDevice.device_id}</code>
                  <button
                    onClick={() => copyToClipboard(generatedDevice.device_id, 'device-id')}
                    data-testid="copy-device-id-btn"
                    className="inline-flex items-center gap-1 px-2 py-1 bg-surface border border-border-strong rounded text-xs cursor-pointer hover:bg-surface-hover transition-colors"
                  >
                    {copiedKey === 'device-id' ? (
                      <>
                        <Check className="w-3 h-3 text-success-text" />{' '}
                        <span className="text-success-text">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" /> Copy
                      </>
                    )}
                  </button>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <strong>Import Key:</strong>
                  <code className="bg-border px-1.5 py-0.5 rounded text-[13px] break-all">
                    {generatedDevice.raw_key}
                  </code>
                  <button
                    onClick={() => copyToClipboard(generatedDevice.raw_key, 'import-key')}
                    data-testid="copy-import-key-btn"
                    className="inline-flex items-center gap-1 px-2 py-1 bg-surface border border-border-strong rounded text-xs cursor-pointer hover:bg-surface-hover transition-colors shrink-0"
                  >
                    {copiedKey === 'import-key' ? (
                      <>
                        <Check className="w-3 h-3 text-success-text" />{' '}
                        <span className="text-success-text">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" /> Copy
                      </>
                    )}
                  </button>
                </div>
                <p className="text-danger-text m-0 mb-3 text-sm font-semibold">
                  Save this key now -- you will not be able to see it again!
                </p>
                <button
                  className="bg-text-secondary text-white border-none rounded-md cursor-pointer font-semibold text-[13px] px-3.5 py-1.5 hover:bg-text-tertiary"
                  onClick={() => setGeneratedDevice(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Device list */}
            {devices.length > 0 && (
              <div className="mb-3 mt-4 pb-2 border-b border-border-light">
                <span className="text-sm font-semibold text-text-secondary">
                  {devices.length} device{devices.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            <div data-testid="device-list">
              {devices.map((d) => (
                <div key={d.device_id} data-testid={`device-${d.device_id}`} className={cardCls}>
                  <h4 className="m-0 mb-2 text-base font-semibold">{d.device_name}</h4>
                  <div className="grid grid-cols-3 gap-1 text-[0.9em] text-text-secondary">
                    <span>Product: {d.products?.name ?? 'None'}</span>
                    <span>
                      Status:{' '}
                      <span className={`font-semibold ${d.is_active ? 'text-success-text' : 'text-danger-text'}`}>
                        {d.is_active ? 'Active' : 'Revoked'}
                      </span>
                    </span>
                    <span>Created: {formatDate(d.created_at)}</span>
                  </div>
                  <div className="flex gap-2 mt-3">
                    {d.is_active && (
                      <button
                        onClick={() => setRevokeTarget(d.device_id)}
                        data-testid={`revoke-device-${d.device_id}`}
                        className="bg-transparent border-none text-danger-text cursor-pointer font-semibold text-[13px] px-2 py-1 hover:text-red-700"
                      >
                        Revoke
                      </button>
                    )}
                    <button
                      onClick={() => loadDeviceEvents(d.device_id)}
                      data-testid={`toggle-events-${d.device_id}`}
                      className="bg-transparent border-none text-chef-accent cursor-pointer font-semibold text-[13px] px-2 py-1 hover:text-emerald-700"
                    >
                      {expandedDeviceId === d.device_id ? 'Hide Events' : 'Show Events'}
                    </button>
                  </div>

                  {/* Event log for expanded device */}
                  {expandedDeviceId === d.device_id && (
                    <div data-testid={`events-${d.device_id}`} className="mt-3">
                      {deviceEvents.length === 0 ? (
                        <p className="text-text-tertiary italic">No events recorded.</p>
                      ) : (
                        <div className="overflow-x-auto rounded-lg border border-border">
                          <table className="w-full text-[0.85em] border-collapse">
                            <thead>
                              <tr className="bg-surface-sunken border-b-2 border-border">
                                <th className="text-left p-2">Time</th>
                                <th className="text-right p-2">Before</th>
                                <th className="text-right p-2">After</th>
                                <th className="text-right p-2">Consumed</th>
                                <th className="text-right p-2">Macros</th>
                              </tr>
                            </thead>
                            <tbody>
                              {deviceEvents.map((ev) => (
                                <tr key={ev.event_id} className="border-b border-border-light">
                                  <td className="px-2 py-1.5">{formatDate(ev.created_at)}</td>
                                  <td className="text-right px-2 py-1.5">{Number(ev.weight_before).toFixed(1)}</td>
                                  <td className="text-right px-2 py-1.5">{Number(ev.weight_after).toFixed(1)}</td>
                                  <td className="text-right px-2 py-1.5">{Number(ev.consumption).toFixed(1)}</td>
                                  <td className="text-right px-2 py-1.5">
                                    {ev.calories != null
                                      ? `${Number(ev.calories).toFixed(0)}cal ${Number(ev.protein).toFixed(0)}p ${Number(ev.carbs).toFixed(0)}c ${Number(ev.fat).toFixed(0)}f`
                                      : '-'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Revoke confirmation dialog */}
            {revokeTarget !== null && (
              <div
                className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
                onClick={() => setRevokeTarget(null)}
              >
                <div
                  className="bg-surface rounded-xl shadow-xl p-5 max-w-sm w-full mx-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="m-0 mb-3 text-lg font-bold">Revoke Device</h3>
                  <p className="text-text-secondary m-0 mb-5">
                    Are you sure you want to revoke this device? It will stop working immediately.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      className="bg-surface text-text-secondary border border-border px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-surface-hover"
                      onClick={() => setRevokeTarget(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="bg-red-600 text-white border-none px-4 py-2 rounded-md cursor-pointer font-semibold text-sm hover:bg-red-700"
                      onClick={() => {
                        if (revokeTarget) revokeDeviceMutation.mutate(revokeTarget);
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

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
      </div>
    </ChefLayout>
  );
}
