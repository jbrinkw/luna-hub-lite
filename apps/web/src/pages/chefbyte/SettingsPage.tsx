import { useEffect, useState, useCallback } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonButton,
  IonInput,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonAlert,
  IonText,
} from '@ionic/react';
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

type Tab = 'products' | 'liquidtrack';

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

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    /* eslint-disable react-hooks/set-state-in-effect */
    loadProducts();
    loadDevices();
  }, [loadProducts, loadDevices]);

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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
      <IonInput
        label="Name"
        value={form.name ?? ''}
        onIonInput={(e) => onChange('name', e.detail.value ?? '')}
        data-testid={`${testIdPrefix}-name`}
      />
      <IonInput
        label="Barcode"
        value={form.barcode ?? ''}
        onIonInput={(e) => onChange('barcode', e.detail.value || null)}
        data-testid={`${testIdPrefix}-barcode`}
      />
      <IonInput
        label="Servings/Container"
        type="number"
        value={form.servings_per_container ?? 1}
        onIonInput={(e) => onChange('servings_per_container', Number(e.detail.value) || 1)}
        data-testid={`${testIdPrefix}-servings`}
      />
      <IonInput
        label="Calories/Serving"
        type="number"
        value={form.calories_per_serving ?? 0}
        onIonInput={(e) => onChange('calories_per_serving', Number(e.detail.value) || 0)}
        data-testid={`${testIdPrefix}-calories`}
      />
      <IonInput
        label="Carbs/Serving"
        type="number"
        value={form.carbs_per_serving ?? 0}
        onIonInput={(e) => onChange('carbs_per_serving', Number(e.detail.value) || 0)}
        data-testid={`${testIdPrefix}-carbs`}
      />
      <IonInput
        label="Protein/Serving"
        type="number"
        value={form.protein_per_serving ?? 0}
        onIonInput={(e) => onChange('protein_per_serving', Number(e.detail.value) || 0)}
        data-testid={`${testIdPrefix}-protein`}
      />
      <IonInput
        label="Fat/Serving"
        type="number"
        value={form.fat_per_serving ?? 0}
        onIonInput={(e) => onChange('fat_per_serving', Number(e.detail.value) || 0)}
        data-testid={`${testIdPrefix}-fat`}
      />
      <IonInput
        label="Min Stock"
        type="number"
        value={form.min_stock_amount ?? 0}
        onIonInput={(e) => onChange('min_stock_amount', Number(e.detail.value) || 0)}
        data-testid={`${testIdPrefix}-min-stock`}
      />
      <IonInput
        label="Walmart Link"
        value={form.walmart_link ?? ''}
        onIonInput={(e) => onChange('walmart_link', e.detail.value || null)}
        data-testid={`${testIdPrefix}-walmart-link`}
      />
      <IonInput
        label="Price"
        type="number"
        value={form.price ?? ''}
        onIonInput={(e) => onChange('price', e.detail.value ? Number(e.detail.value) : null)}
        data-testid={`${testIdPrefix}-price`}
      />
    </div>
  );

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Settings">
        <IonSpinner data-testid="settings-loading" />
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Settings">
      <h2>SETTINGS</h2>

      {error && (
        <IonText color="danger">
          <p>{error}</p>
        </IonText>
      )}

      <IonSegment
        value={activeTab}
        onIonChange={(e) => setActiveTab(e.detail.value as Tab)}
        data-testid="settings-tabs"
      >
        <IonSegmentButton value="products">
          <IonLabel>Products</IonLabel>
        </IonSegmentButton>
        <IonSegmentButton value="liquidtrack">
          <IonLabel>LiquidTrack</IonLabel>
        </IonSegmentButton>
      </IonSegment>

      {/* ========================================================== */}
      {/*  PRODUCTS TAB                                                */}
      {/* ========================================================== */}
      {activeTab === 'products' && (
        <div data-testid="products-tab">
          {/* Search bar */}
          <IonInput
            placeholder="Search products..."
            value={searchText}
            onIonInput={(e) => setSearchText(e.detail.value ?? '')}
            data-testid="product-search"
            style={{ marginTop: '12px', marginBottom: '12px' }}
          />

          {/* Add Product */}
          <IonCard data-testid="add-product-section">
            <IonCardHeader>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <IonCardTitle>Add Product</IonCardTitle>
                <IonButton
                  size="small"
                  onClick={() => setShowAddProduct(!showAddProduct)}
                  data-testid="toggle-add-product"
                >
                  {showAddProduct ? 'Cancel' : '+ New'}
                </IonButton>
              </div>
            </IonCardHeader>
            {showAddProduct && (
              <IonCardContent data-testid="add-product-form">
                {renderProductFields(
                  addForm,
                  (field, value) => setAddForm((prev) => ({ ...prev, [field]: value })),
                  'add',
                )}
                <IonButton
                  expand="block"
                  onClick={addProduct}
                  disabled={!addForm.name.trim()}
                  data-testid="save-new-product"
                  style={{ marginTop: '12px' }}
                >
                  Save Product
                </IonButton>
              </IonCardContent>
            )}
          </IonCard>

          {/* Product list */}
          <IonList data-testid="product-list">
            {filteredProducts.map((p) => (
              <IonCard key={p.product_id} data-testid={`product-${p.product_id}`}>
                {editingId === p.product_id ? (
                  /* Editing mode */
                  <IonCardContent>
                    {renderProductFields(
                      editForm,
                      (field, value) => setEditForm((prev) => ({ ...prev, [field]: value })),
                      'edit',
                    )}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                      <IonButton onClick={saveProduct} data-testid="save-edit-product">
                        Save
                      </IonButton>
                      <IonButton fill="clear" onClick={cancelEdit} data-testid="cancel-edit-product">
                        Cancel
                      </IonButton>
                    </div>
                  </IonCardContent>
                ) : (
                  /* Display mode */
                  <>
                    <IonCardHeader>
                      <IonCardTitle>{p.name}</IonCardTitle>
                    </IonCardHeader>
                    <IonCardContent>
                      <div
                        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '0.9em' }}
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
                      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                        <IonButton
                          size="small"
                          onClick={() => startEdit(p)}
                          data-testid={`edit-product-${p.product_id}`}
                        >
                          Edit
                        </IonButton>
                        <IonButton
                          size="small"
                          color="danger"
                          fill="clear"
                          onClick={() => setDeleteTarget(p.product_id)}
                          data-testid={`delete-product-${p.product_id}`}
                        >
                          Delete
                        </IonButton>
                      </div>
                    </IonCardContent>
                  </>
                )}
              </IonCard>
            ))}
          </IonList>

          {/* Delete confirmation alert */}
          <IonAlert
            isOpen={deleteTarget !== null}
            header="Delete Product"
            message="Are you sure you want to delete this product? This cannot be undone."
            buttons={[
              { text: 'Cancel', role: 'cancel', handler: () => setDeleteTarget(null) },
              {
                text: 'Delete',
                handler: () => {
                  if (deleteTarget) deleteProduct(deleteTarget);
                },
              },
            ]}
            onDidDismiss={() => setDeleteTarget(null)}
          />
        </div>
      )}

      {/* ========================================================== */}
      {/*  LIQUIDTRACK TAB                                             */}
      {/* ========================================================== */}
      {activeTab === 'liquidtrack' && (
        <div data-testid="liquidtrack-tab">
          {/* Add Device */}
          <IonCard data-testid="add-device-section" style={{ marginTop: '12px' }}>
            <IonCardHeader>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <IonCardTitle>Add Device</IonCardTitle>
                <IonButton
                  size="small"
                  onClick={() => setShowAddDevice(!showAddDevice)}
                  data-testid="toggle-add-device"
                >
                  {showAddDevice ? 'Cancel' : '+ New'}
                </IonButton>
              </div>
            </IonCardHeader>
            {showAddDevice && (
              <IonCardContent data-testid="add-device-form">
                <IonInput
                  label="Device Name"
                  value={newDeviceName}
                  onIonInput={(e) => setNewDeviceName(e.detail.value ?? '')}
                  data-testid="device-name-input"
                />
                <IonSelect
                  label="Product"
                  value={newDeviceProductId}
                  onIonChange={(e) => setNewDeviceProductId(e.detail.value ?? '')}
                  data-testid="device-product-select"
                  placeholder="Select product (optional)"
                >
                  {products.map((p) => (
                    <IonSelectOption key={p.product_id} value={p.product_id}>
                      {p.name}
                    </IonSelectOption>
                  ))}
                </IonSelect>
                <IonButton
                  expand="block"
                  onClick={generateDevice}
                  disabled={!newDeviceName.trim()}
                  data-testid="generate-device-btn"
                  style={{ marginTop: '12px' }}
                >
                  Generate Device
                </IonButton>
              </IonCardContent>
            )}
          </IonCard>

          {/* Generated device info */}
          {generatedDevice && (
            <IonCard data-testid="generated-device-info" color="success">
              <IonCardHeader>
                <IonCardTitle>Device Created!</IonCardTitle>
              </IonCardHeader>
              <IonCardContent>
                <p>
                  <strong>Device ID:</strong> {generatedDevice.device_id}
                </p>
                <p>
                  <strong>Import Key:</strong> <code>{generatedDevice.raw_key}</code>
                </p>
                <p style={{ color: '#c00' }}>Save this key now -- you will not be able to see it again!</p>
                <IonButton size="small" onClick={() => setGeneratedDevice(null)}>
                  Dismiss
                </IonButton>
              </IonCardContent>
            </IonCard>
          )}

          {/* Device list */}
          <IonList data-testid="device-list">
            {devices.map((d) => (
              <IonCard key={d.device_id} data-testid={`device-${d.device_id}`}>
                <IonCardHeader>
                  <IonCardTitle>{d.device_name}</IonCardTitle>
                </IonCardHeader>
                <IonCardContent>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontSize: '0.9em' }}>
                    <span>Product: {d.products?.name ?? 'None'}</span>
                    <span>Status: {d.is_active ? 'Active' : 'Revoked'}</span>
                    <span>Created: {formatDate(d.created_at)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                    {d.is_active && (
                      <IonButton
                        size="small"
                        color="danger"
                        fill="clear"
                        onClick={() => setRevokeTarget(d.device_id)}
                        data-testid={`revoke-device-${d.device_id}`}
                      >
                        Revoke
                      </IonButton>
                    )}
                    <IonButton
                      size="small"
                      fill="clear"
                      onClick={() => loadDeviceEvents(d.device_id)}
                      data-testid={`toggle-events-${d.device_id}`}
                    >
                      {expandedDeviceId === d.device_id ? 'Hide Events' : 'Show Events'}
                    </IonButton>
                  </div>

                  {/* Event log for expanded device */}
                  {expandedDeviceId === d.device_id && (
                    <div data-testid={`events-${d.device_id}`} style={{ marginTop: '12px' }}>
                      {deviceEvents.length === 0 ? (
                        <p style={{ color: '#888' }}>No events recorded.</p>
                      ) : (
                        <table style={{ width: '100%', fontSize: '0.85em', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: '4px' }}>Time</th>
                              <th style={{ textAlign: 'right', padding: '4px' }}>Before</th>
                              <th style={{ textAlign: 'right', padding: '4px' }}>After</th>
                              <th style={{ textAlign: 'right', padding: '4px' }}>Consumed</th>
                              <th style={{ textAlign: 'right', padding: '4px' }}>Macros</th>
                            </tr>
                          </thead>
                          <tbody>
                            {deviceEvents.map((ev) => (
                              <tr key={ev.event_id}>
                                <td style={{ padding: '4px' }}>{formatDate(ev.created_at)}</td>
                                <td style={{ textAlign: 'right', padding: '4px' }}>
                                  {Number(ev.weight_before).toFixed(1)}
                                </td>
                                <td style={{ textAlign: 'right', padding: '4px' }}>
                                  {Number(ev.weight_after).toFixed(1)}
                                </td>
                                <td style={{ textAlign: 'right', padding: '4px' }}>
                                  {Number(ev.consumption).toFixed(1)}
                                </td>
                                <td style={{ textAlign: 'right', padding: '4px' }}>
                                  {ev.calories != null
                                    ? `${Number(ev.calories).toFixed(0)}cal ${Number(ev.protein).toFixed(0)}p ${Number(ev.carbs).toFixed(0)}c ${Number(ev.fat).toFixed(0)}f`
                                    : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </IonCardContent>
              </IonCard>
            ))}
          </IonList>

          {/* Revoke confirmation alert */}
          <IonAlert
            isOpen={revokeTarget !== null}
            header="Revoke Device"
            message="Are you sure you want to revoke this device? It will stop working immediately."
            buttons={[
              { text: 'Cancel', role: 'cancel', handler: () => setRevokeTarget(null) },
              {
                text: 'Revoke',
                handler: () => {
                  if (revokeTarget) revokeDevice(revokeTarget);
                },
              },
            ]}
            onDidDismiss={() => setRevokeTarget(null)}
          />
        </div>
      )}
    </ChefLayout>
  );
}
