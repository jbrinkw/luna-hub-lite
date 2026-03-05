import { useEffect, useState, useCallback } from 'react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';

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

type Tab = 'products' | 'liquidtrack' | 'locations';

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'products', label: 'Products', icon: '\uD83D\uDCE6' },
  { id: 'liquidtrack', label: 'LiquidTrack', icon: '\uD83E\uDD64' },
  { id: 'locations', label: 'Locations', icon: '\uD83D\uDCCD' },
];

/* ------------------------------------------------------------------ */
/*  Shared styles                                                      */
/* ------------------------------------------------------------------ */

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '14px',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '4px',
  fontWeight: 600,
  fontSize: '13px',
  color: '#374151',
};

const cardStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: '8px',
  padding: '16px',
  marginBottom: '16px',
  background: '#fff',
};

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
  const [activeTab, setActiveTab] = useState<Tab>('products');
  const [loading, setLoading] = useState(true);

  /* ---- Products state ---- */
  const [products, setProducts] = useState<Product[]>([]);
  const [searchText, setSearchText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Product>>({});
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [addForm, setAddForm] = useState(blankProduct());
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  /* ---- LiquidTrack state ---- */
  const [devices, setDevices] = useState<LiquidTrackDevice[]>([]);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceProductId, setNewDeviceProductId] = useState('');
  const [generatedDevice, setGeneratedDevice] = useState<{ device_id: string; raw_key: string } | null>(null);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [deviceEvents, setDeviceEvents] = useState<LiquidTrackEvent[]>([]);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ---- Locations state ---- */
  const [locations, setLocations] = useState<
    { location_id: string; user_id: string; name: string; created_at: string }[]
  >([]);
  const [newLocationName, setNewLocationName] = useState('');
  const [deleteLocationTarget, setDeleteLocationTarget] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadProducts = useCallback(async () => {
    if (!user) return;
    const { data } = await chefbyte().from('products').select('*').eq('user_id', user.id).order('name');
    setProducts((data ?? []) as Product[]);
    setLoading(false);
  }, [user]);

  const loadDevices = useCallback(async () => {
    if (!user) return;
    const { data } = await chefbyte()
      .from('liquidtrack_devices')
      .select('*, products:product_id(name)')
      .eq('user_id', user.id);
    setDevices((data ?? []) as LiquidTrackDevice[]);
  }, [user]);

  const loadLocations = useCallback(async () => {
    if (!user) return;
    const { data } = await chefbyte().from('locations').select('*').eq('user_id', user.id).order('name');
    setLocations((data ?? []) as { location_id: string; user_id: string; name: string; created_at: string }[]);
  }, [user]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    /* eslint-disable react-hooks/set-state-in-effect */
    loadProducts();
    loadDevices();
    loadLocations();
  }, [loadProducts, loadDevices, loadLocations]);

  /* ---------------------------------------------------------------- */
  /*  Product CRUD                                                     */
  /* eslint-enable react-hooks/set-state-in-effect */
  /* ---------------------------------------------------------------- */

  const saveProduct = async () => {
    if (!user || !editingId) return;
    setError(null);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { product_id: _pid, user_id: _uid, ...updates } = editForm as Product;
    const { error: updateErr } = await chefbyte().from('products').update(updates).eq('product_id', editingId);
    if (updateErr) {
      setError(updateErr.message);
      return;
    }
    setEditingId(null);
    setEditForm({});
    await loadProducts();
  };

  const addProduct = async () => {
    if (!user || !addForm.name.trim()) return;
    setError(null);
    const { error: insertErr } = await chefbyte()
      .from('products')
      .insert({ ...addForm, user_id: user.id });
    if (insertErr) {
      setError(insertErr.message);
      return;
    }
    setAddForm(blankProduct());
    setShowAddProduct(false);
    await loadProducts();
  };

  const deleteProduct = async (productId: string) => {
    setError(null);
    const { error: deleteErr } = await chefbyte().from('products').delete().eq('product_id', productId);
    if (deleteErr) {
      setError(deleteErr.message);
      return;
    }
    setDeleteTarget(null);
    await loadProducts();
  };

  /* ---------------------------------------------------------------- */
  /*  LiquidTrack actions                                              */
  /* ---------------------------------------------------------------- */

  const generateDevice = async () => {
    if (!user || !newDeviceName.trim()) return;

    const deviceId = crypto.randomUUID();
    const rawKey = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

    // Hash the key with SHA-256
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const keyHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    setError(null);
    const { error: insertErr } = await chefbyte()
      .from('liquidtrack_devices')
      .insert({
        device_id: deviceId,
        user_id: user.id,
        device_name: newDeviceName.trim(),
        product_id: newDeviceProductId || null,
        import_key_hash: keyHash,
      });
    if (insertErr) {
      setError(insertErr.message);
      return;
    }

    setGeneratedDevice({ device_id: deviceId, raw_key: rawKey });
    setNewDeviceName('');
    setNewDeviceProductId('');
    setShowAddDevice(false);
    await loadDevices();
  };

  const revokeDevice = async (deviceId: string) => {
    setError(null);
    const { error: revokeErr } = await chefbyte()
      .from('liquidtrack_devices')
      .update({ is_active: false })
      .eq('device_id', deviceId);
    if (revokeErr) {
      setError(revokeErr.message);
      return;
    }
    setRevokeTarget(null);
    await loadDevices();
  };

  const loadDeviceEvents = async (deviceId: string) => {
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
  };

  /* ---------------------------------------------------------------- */
  /*  Location actions                                                 */
  /* ---------------------------------------------------------------- */

  const addLocation = async () => {
    if (!user || !newLocationName.trim()) return;
    setError(null);
    const { error: insertErr } = await chefbyte()
      .from('locations')
      .insert({ user_id: user.id, name: newLocationName.trim() });
    if (insertErr) {
      setError(insertErr.message);
      return;
    }
    setNewLocationName('');
    await loadLocations();
  };

  const deleteLocation = async (locationId: string) => {
    setError(null);
    const { count } = await chefbyte()
      .from('stock_lots')
      .select('*', { count: 'exact', head: true })
      .eq('location_id', locationId);
    if (count && count > 0) {
      setError('Cannot delete location with existing stock. Move stock first.');
      setDeleteLocationTarget(null);
      return;
    }
    const { error: deleteErr } = await chefbyte().from('locations').delete().eq('location_id', locationId);
    if (deleteErr) {
      setError(deleteErr.message);
      setDeleteLocationTarget(null);
      return;
    }
    setDeleteLocationTarget(null);
    await loadLocations();
  };

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
    <div className="cb-form-grid">
      <div>
        <label style={labelStyle}>Name</label>
        <input
          value={form.name ?? ''}
          onChange={(e) => onChange('name', e.target.value)}
          data-testid={`${testIdPrefix}-name`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Barcode</label>
        <input
          value={form.barcode ?? ''}
          onChange={(e) => onChange('barcode', e.target.value || null)}
          data-testid={`${testIdPrefix}-barcode`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Servings/Container</label>
        <input
          type="number"
          min="0"
          value={form.servings_per_container ?? 1}
          onChange={(e) => onChange('servings_per_container', Number(e.target.value) || 1)}
          data-testid={`${testIdPrefix}-servings`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Calories/Serving</label>
        <input
          type="number"
          min="0"
          value={form.calories_per_serving ?? 0}
          onChange={(e) => onChange('calories_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-calories`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Carbs/Serving</label>
        <input
          type="number"
          min="0"
          value={form.carbs_per_serving ?? 0}
          onChange={(e) => onChange('carbs_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-carbs`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Protein/Serving</label>
        <input
          type="number"
          min="0"
          value={form.protein_per_serving ?? 0}
          onChange={(e) => onChange('protein_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-protein`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Fat/Serving</label>
        <input
          type="number"
          min="0"
          value={form.fat_per_serving ?? 0}
          onChange={(e) => onChange('fat_per_serving', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-fat`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Min Stock</label>
        <input
          type="number"
          min="0"
          value={form.min_stock_amount ?? 0}
          onChange={(e) => onChange('min_stock_amount', Number(e.target.value) || 0)}
          data-testid={`${testIdPrefix}-min-stock`}
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Walmart Link</label>
        <input
          value={form.walmart_link ?? ''}
          onChange={(e) => onChange('walmart_link', e.target.value || null)}
          data-testid={`${testIdPrefix}-walmart-link`}
          placeholder="https://www.walmart.com/ip/..."
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>Price</label>
        <input
          type="number"
          min="0"
          value={form.price ?? ''}
          onChange={(e) => onChange('price', e.target.value ? Number(e.target.value) : null)}
          data-testid={`${testIdPrefix}-price`}
          placeholder="$0.00"
          style={inputStyle}
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
        <div data-testid="settings-loading" style={{ padding: '20px', color: '#666' }}>
          Loading...
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Settings">
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 700, color: '#1a1a2e' }}>Settings</h1>
        <p style={{ margin: '8px 0 0', color: '#666', fontSize: '14px' }}>Manage your products, devices, and data</p>
      </div>

      {error && (
        <p
          style={{
            color: '#d33',
            background: '#fef2f2',
            padding: '10px 14px',
            borderRadius: '6px',
            border: '1px solid #fecaca',
            marginBottom: '16px',
          }}
        >
          {error}
        </p>
      )}

      {/* Mobile tab select */}
      <div className="cb-mobile-only" style={{ marginBottom: '12px' }}>
        <select
          value={activeTab}
          onChange={(e) => setActiveTab(e.target.value as Tab)}
          data-testid="settings-tabs"
          style={{ padding: '10px', width: '100%', borderRadius: '8px', border: '1px solid #ddd', fontSize: '14px' }}
        >
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.icon} {tab.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop Tabs */}
      <div className="cb-tab-bar cb-desktop-only" data-testid="settings-tabs">
        {tabs.map((tab) => (
          <button
            className={`cb-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            key={tab.id}
          >
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content Container */}
      <div
        style={{
          background: '#fff',
          borderRadius: '12px',
          border: '1px solid #e0e0e0',
          minHeight: '400px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        }}
      >
        {/* ========================================================== */}
        {/*  PRODUCTS TAB                                                */}
        {/* ========================================================== */}
        {activeTab === 'products' && (
          <div data-testid="products-tab" style={{ padding: '20px' }}>
            {/* Search bar */}
            <input
              placeholder="Search products..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              data-testid="product-search"
              style={{ ...inputStyle, marginBottom: '16px' }}
            />

            {/* Add Product */}
            <div data-testid="add-product-section" style={{ ...cardStyle, marginBottom: '20px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: showAddProduct ? '16px' : 0,
                }}
              >
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#1a1a2e' }}>Add Product</h3>
                <button
                  className="cb-primary-btn"
                  onClick={() => setShowAddProduct(!showAddProduct)}
                  data-testid="toggle-add-product"
                  style={{ background: showAddProduct ? '#6b7280' : '#2f9e44', fontSize: '13px', padding: '6px 14px' }}
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
                    className="cb-primary-btn"
                    onClick={addProduct}
                    disabled={!addForm.name.trim()}
                    data-testid="save-new-product"
                    style={{ marginTop: '12px', background: '#2f9e44', width: '100%', padding: '12px' }}
                  >
                    Save Product
                  </button>
                </div>
              )}
            </div>

            {/* Product list */}
            <div data-testid="product-list">
              {filteredProducts.map((p) => (
                <div key={p.product_id} data-testid={`product-${p.product_id}`} style={cardStyle}>
                  {editingId === p.product_id ? (
                    /* Editing mode */
                    <div>
                      {renderProductFields(
                        editForm,
                        (field, value) => setEditForm((prev) => ({ ...prev, [field]: value })),
                        'edit',
                      )}
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        <button
                          className="cb-primary-btn"
                          onClick={saveProduct}
                          data-testid="save-edit-product"
                          style={{ background: '#2f9e44' }}
                        >
                          Save
                        </button>
                        <button
                          className="cb-primary-btn"
                          onClick={cancelEdit}
                          data-testid="cancel-edit-product"
                          style={{ background: '#fff', border: '1px solid #ddd', color: '#4b5563' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Display mode */
                    <div>
                      <h4 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 600 }}>{p.name}</h4>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr 1fr',
                          gap: '4px',
                          fontSize: '0.9em',
                          color: '#555',
                        }}
                      >
                        {p.barcode && <span>Barcode: {p.barcode}</span>}
                        <span>Servings/Container: {Number(p.servings_per_container)}</span>
                        <span>Cal: {Number(p.calories_per_serving)}</span>
                        <span>C: {Number(p.carbs_per_serving)}g</span>
                        <span>P: {Number(p.protein_per_serving)}g</span>
                        <span>F: {Number(p.fat_per_serving)}g</span>
                        <span>Min Stock: {Number(p.min_stock_amount)}</span>
                        {p.price != null && <span>Price: ${Number(p.price).toFixed(2)}</span>}
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        <button
                          className="cb-primary-btn"
                          onClick={() => startEdit(p)}
                          data-testid={`edit-product-${p.product_id}`}
                          style={{ background: '#1e66f5', fontSize: '13px', padding: '6px 14px' }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteTarget(p.product_id)}
                          data-testid={`delete-product-${p.product_id}`}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#d33',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '13px',
                            padding: '6px 14px',
                          }}
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
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: 'rgba(0,0,0,0.5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 1000,
                }}
                onClick={() => setDeleteTarget(null)}
              >
                <div className="cb-modal-panel" onClick={(e) => e.stopPropagation()}>
                  <h3 style={{ margin: '0 0 12px', fontSize: '18px', fontWeight: 700 }}>Delete Product</h3>
                  <p style={{ color: '#666', margin: '0 0 20px' }}>
                    Are you sure you want to delete this product? This cannot be undone.
                  </p>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button
                      className="cb-primary-btn"
                      onClick={() => setDeleteTarget(null)}
                      style={{ background: '#fff', border: '1px solid #ddd', color: '#4b5563' }}
                    >
                      Cancel
                    </button>
                    <button
                      className="cb-primary-btn"
                      onClick={() => {
                        if (deleteTarget) deleteProduct(deleteTarget);
                      }}
                      style={{ background: '#d33' }}
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
        {/*  LIQUIDTRACK TAB                                             */}
        {/* ========================================================== */}
        {activeTab === 'liquidtrack' && (
          <div data-testid="liquidtrack-tab" style={{ padding: '20px' }}>
            {/* Add Device */}
            <div data-testid="add-device-section" style={cardStyle}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: showAddDevice ? '16px' : 0,
                }}
              >
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#1a1a2e' }}>Add Device</h3>
                <button
                  className="cb-primary-btn"
                  onClick={() => setShowAddDevice(!showAddDevice)}
                  data-testid="toggle-add-device"
                  style={{ background: showAddDevice ? '#6b7280' : '#1e66f5', fontSize: '13px', padding: '6px 14px' }}
                >
                  {showAddDevice ? 'Cancel' : '+ New'}
                </button>
              </div>
              {showAddDevice && (
                <div data-testid="add-device-form" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={labelStyle}>Device Name</label>
                    <input
                      value={newDeviceName}
                      onChange={(e) => setNewDeviceName(e.target.value)}
                      data-testid="device-name-input"
                      style={inputStyle}
                      placeholder="e.g. Kitchen Scale"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Product</label>
                    <select
                      value={newDeviceProductId}
                      onChange={(e) => setNewDeviceProductId(e.target.value)}
                      data-testid="device-product-select"
                      style={inputStyle}
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
                    className="cb-primary-btn"
                    onClick={generateDevice}
                    disabled={!newDeviceName.trim()}
                    data-testid="generate-device-btn"
                    style={{ background: '#1e66f5', width: '100%', padding: '12px' }}
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
                style={{
                  ...cardStyle,
                  border: '2px solid #2f9e44',
                  background: '#f0fdf4',
                }}
              >
                <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: 700, color: '#2f9e44' }}>
                  Device Created!
                </h3>
                <p style={{ margin: '0 0 8px' }}>
                  <strong>Device ID:</strong> {generatedDevice.device_id}
                </p>
                <p style={{ margin: '0 0 8px' }}>
                  <strong>Import Key:</strong>{' '}
                  <code style={{ background: '#e5e7eb', padding: '2px 6px', borderRadius: '4px', fontSize: '13px' }}>
                    {generatedDevice.raw_key}
                  </code>
                </p>
                <p style={{ color: '#c00', margin: '0 0 12px', fontSize: '14px', fontWeight: 600 }}>
                  Save this key now -- you will not be able to see it again!
                </p>
                <button
                  className="cb-primary-btn"
                  onClick={() => setGeneratedDevice(null)}
                  style={{ background: '#6b7280', fontSize: '13px', padding: '6px 14px' }}
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Device list */}
            <div data-testid="device-list">
              {devices.map((d) => (
                <div key={d.device_id} data-testid={`device-${d.device_id}`} style={cardStyle}>
                  <h4 style={{ margin: '0 0 8px', fontSize: '16px', fontWeight: 600 }}>{d.device_name}</h4>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr',
                      gap: '4px',
                      fontSize: '0.9em',
                      color: '#555',
                    }}
                  >
                    <span>Product: {d.products?.name ?? 'None'}</span>
                    <span>
                      Status:{' '}
                      <span style={{ color: d.is_active ? '#2f9e44' : '#d33', fontWeight: 600 }}>
                        {d.is_active ? 'Active' : 'Revoked'}
                      </span>
                    </span>
                    <span>Created: {formatDate(d.created_at)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                    {d.is_active && (
                      <button
                        onClick={() => setRevokeTarget(d.device_id)}
                        data-testid={`revoke-device-${d.device_id}`}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#d33',
                          cursor: 'pointer',
                          fontWeight: 600,
                          fontSize: '13px',
                          padding: '4px 8px',
                        }}
                      >
                        Revoke
                      </button>
                    )}
                    <button
                      onClick={() => loadDeviceEvents(d.device_id)}
                      data-testid={`toggle-events-${d.device_id}`}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#1e66f5',
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: '13px',
                        padding: '4px 8px',
                      }}
                    >
                      {expandedDeviceId === d.device_id ? 'Hide Events' : 'Show Events'}
                    </button>
                  </div>

                  {/* Event log for expanded device */}
                  {expandedDeviceId === d.device_id && (
                    <div data-testid={`events-${d.device_id}`} style={{ marginTop: '12px' }}>
                      {deviceEvents.length === 0 ? (
                        <p style={{ color: '#888', fontStyle: 'italic' }}>No events recorded.</p>
                      ) : (
                        <div className="cb-table-responsive">
                          <table style={{ width: '100%', fontSize: '0.85em', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ background: '#f7f7f9', borderBottom: '2px solid #ddd' }}>
                                <th style={{ textAlign: 'left', padding: '8px' }}>Time</th>
                                <th style={{ textAlign: 'right', padding: '8px' }}>Before</th>
                                <th style={{ textAlign: 'right', padding: '8px' }}>After</th>
                                <th style={{ textAlign: 'right', padding: '8px' }}>Consumed</th>
                                <th style={{ textAlign: 'right', padding: '8px' }}>Macros</th>
                              </tr>
                            </thead>
                            <tbody>
                              {deviceEvents.map((ev) => (
                                <tr key={ev.event_id} style={{ borderBottom: '1px solid #eee' }}>
                                  <td style={{ padding: '6px 8px' }}>{formatDate(ev.created_at)}</td>
                                  <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                                    {Number(ev.weight_before).toFixed(1)}
                                  </td>
                                  <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                                    {Number(ev.weight_after).toFixed(1)}
                                  </td>
                                  <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                                    {Number(ev.consumption).toFixed(1)}
                                  </td>
                                  <td style={{ textAlign: 'right', padding: '6px 8px' }}>
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
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: 'rgba(0,0,0,0.5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 1000,
                }}
                onClick={() => setRevokeTarget(null)}
              >
                <div className="cb-modal-panel" onClick={(e) => e.stopPropagation()}>
                  <h3 style={{ margin: '0 0 12px', fontSize: '18px', fontWeight: 700 }}>Revoke Device</h3>
                  <p style={{ color: '#666', margin: '0 0 20px' }}>
                    Are you sure you want to revoke this device? It will stop working immediately.
                  </p>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button
                      className="cb-primary-btn"
                      onClick={() => setRevokeTarget(null)}
                      style={{ background: '#fff', border: '1px solid #ddd', color: '#4b5563' }}
                    >
                      Cancel
                    </button>
                    <button
                      className="cb-primary-btn"
                      onClick={() => {
                        if (revokeTarget) revokeDevice(revokeTarget);
                      }}
                      style={{ background: '#d33' }}
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
          <div data-testid="locations-tab" style={{ padding: '20px' }}>
            <div data-testid="locations-section" style={cardStyle}>
              <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 700, color: '#1a1a2e' }}>
                Storage Locations
              </h3>

              {/* Existing locations list */}
              {locations.length === 0 ? (
                <p style={{ color: '#888', fontStyle: 'italic' }} data-testid="no-locations-msg">
                  No locations yet. Add one below.
                </p>
              ) : (
                <div
                  data-testid="location-list"
                  style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}
                >
                  {locations.map((loc) => (
                    <div
                      key={loc.location_id}
                      data-testid={`location-${loc.location_id}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 12px',
                        border: '1px solid #eee',
                        borderRadius: '6px',
                        background: '#fafafa',
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>{loc.name}</span>
                      <button
                        onClick={() => setDeleteLocationTarget(loc.location_id)}
                        data-testid={`delete-location-${loc.location_id}`}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#d33',
                          cursor: 'pointer',
                          fontWeight: 600,
                          fontSize: '13px',
                          padding: '4px 8px',
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add location form */}
              <div
                style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' }}
                data-testid="add-location-form"
              >
                <input
                  placeholder="New location name..."
                  value={newLocationName}
                  onChange={(e) => setNewLocationName(e.target.value)}
                  data-testid="location-name-input"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  className="cb-primary-btn"
                  onClick={addLocation}
                  disabled={!newLocationName.trim()}
                  data-testid="add-location-btn"
                  style={{ background: '#1e66f5', whiteSpace: 'nowrap' }}
                >
                  Add Location
                </button>
              </div>
            </div>

            {/* Delete location confirmation dialog */}
            {deleteLocationTarget !== null && (
              <div
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: 'rgba(0,0,0,0.5)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 1000,
                }}
                onClick={() => setDeleteLocationTarget(null)}
              >
                <div className="cb-modal-panel" onClick={(e) => e.stopPropagation()}>
                  <h3 style={{ margin: '0 0 12px', fontSize: '18px', fontWeight: 700 }}>Delete Location</h3>
                  <p style={{ color: '#666', margin: '0 0 20px' }}>
                    Are you sure you want to delete this location? This cannot be undone.
                  </p>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button
                      className="cb-primary-btn"
                      onClick={() => setDeleteLocationTarget(null)}
                      style={{ background: '#fff', border: '1px solid #ddd', color: '#4b5563' }}
                    >
                      Cancel
                    </button>
                    <button
                      className="cb-primary-btn"
                      onClick={() => {
                        if (deleteLocationTarget) deleteLocation(deleteLocationTarget);
                      }}
                      style={{ background: '#d33' }}
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
