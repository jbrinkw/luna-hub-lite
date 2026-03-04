import type { CSSProperties } from 'react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonButton,
  IonBadge,
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonAlert,
  IonText,
  IonInput,
} from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, supabase } from '@/shared/supabase';
import { todayStr } from '@/shared/dates';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Product {
  product_id: string;
  user_id: string;
  name: string;
  barcode: string | null;
  servings_per_container: number;
  min_stock_amount: number;
}

interface StockLot {
  lot_id: string;
  product_id: string;
  qty_containers: number;
  expires_on: string | null;
  locations: { name: string } | null;
}

interface GroupedProduct {
  product: Product;
  totalStock: number;
  nearestExpiry: string | null;
  lotCount: number;
}

type ViewMode = 'grouped' | 'lots';

/* ================================================================== */
/*  InventoryPage                                                      */
/* ================================================================== */

export function InventoryPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('grouped');

  const [loadError, setLoadError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [lots, setLots] = useState<StockLot[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [consumeAllTarget, setConsumeAllTarget] = useState<string | null>(null);

  /* ---- Search filter state ---- */
  const [searchText, setSearchText] = useState('');

  /* ---- Add-stock modal state ---- */
  const [addingStockFor, setAddingStockFor] = useState<string | null>(null);
  const [addStockQty, setAddStockQty] = useState<number>(1);
  const [addStockExpiry, setAddStockExpiry] = useState<string>('');

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadData = useCallback(async () => {
    if (!user) return;
    setLoadError(null);

    const { data: prods, error: prodsErr } = await chefbyte()
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', user.id)
      .order('name');

    if (prodsErr) {
      setLoadError(prodsErr.message);
      setLoading(false);
      return;
    }

    const { data: stockLots } = await chefbyte()
      .from('stock_lots')
      .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
      .eq('user_id', user.id);

    const { data: locs } = await chefbyte()
      .from('locations')
      .select('location_id')
      .eq('user_id', user.id)
      .order('created_at')
      .limit(1);

    setProducts((prods ?? []) as Product[]);
    setLots((stockLots ?? []) as StockLot[]);
    setLocationId(locs?.[0]?.location_id ?? null);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

  /* ---------------------------------------------------------------- */
  /*  Realtime subscriptions                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('inventory-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'chefbyte',
          table: 'stock_lots',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          loadData();
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'chefbyte',
          table: 'products',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          loadData();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

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

      return {
        product,
        totalStock,
        nearestExpiry,
        lotCount: productLots.length,
      };
    });
  }, [products, lots]);

  /* ---------------------------------------------------------------- */
  /*  Filtered grouped (by search text)                                */
  /* ---------------------------------------------------------------- */

  const filteredGrouped = useMemo(() => {
    if (!searchText.trim()) return grouped;
    const lower = searchText.toLowerCase();
    return grouped.filter((g) => g.product.name.toLowerCase().includes(lower));
  }, [grouped, searchText]);

  /* ---------------------------------------------------------------- */
  /*  Sorted lots for Lots view                                        */
  /* ---------------------------------------------------------------- */

  const sortedLots = useMemo(() => {
    const productMap = new Map(products.map((p) => [p.product_id, p]));
    return [...lots]
      .map((lot) => ({ ...lot, productName: productMap.get(lot.product_id)?.name ?? 'Unknown' }))
      .sort((a, b) => {
        // Primary: expires_on ASC NULLS LAST
        if (!a.expires_on && !b.expires_on) return a.productName.localeCompare(b.productName);
        if (!a.expires_on) return 1;
        if (!b.expires_on) return -1;
        const dateCompare = a.expires_on.localeCompare(b.expires_on);
        if (dateCompare !== 0) return dateCompare;
        return a.productName.localeCompare(b.productName);
      });
  }, [lots, products]);

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const getLogicalDate = () => todayStr();

  const [error, setError] = useState<string | null>(null);

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

  const addStock = async (productId: string, qtyContainers: number, expiresOn?: string | null) => {
    if (!user || !locationId) return;

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
      if (err) {
        setError(err.message);
        return;
      }
    } else {
      // Create new lot
      const { error: err } = await chefbyte().from('stock_lots').insert({
        user_id: user.id,
        product_id: productId,
        location_id: locationId,
        qty_containers: qtyContainers,
        expires_on: resolvedExpiry,
      });
      if (err) {
        setError(err.message);
        return;
      }
    }

    setError(null);
    await loadData();
  };

  const confirmAddStock = async () => {
    if (!addingStockFor || addStockQty <= 0) return;
    await addStock(addingStockFor, addStockQty, addStockExpiry || null);
    closeAddStockModal();
  };

  const consumeStock = async (productId: string, qty: number, unit: 'container' | 'serving') => {
    const { error: err } = await (chefbyte() as any).rpc('consume_product', {
      p_product_id: productId,
      p_qty: qty,
      p_unit: unit,
      p_log_macros: false,
      p_logical_date: getLogicalDate(),
    });
    if (err) {
      setError(err.message);
      return;
    }
    setError(null);
    await loadData();
  };

  const consumeAll = async (productId: string) => {
    const item = grouped.find((g) => g.product.product_id === productId);
    if (!item || item.totalStock <= 0) return;
    await consumeStock(productId, item.totalStock, 'container');
    setConsumeAllTarget(null);
  };

  /* ---------------------------------------------------------------- */
  /*  Stock badge color                                                */
  /* ---------------------------------------------------------------- */

  const stockBadgeColor = (totalStock: number, minStock: number): string => {
    if (totalStock <= 0) return 'danger';
    if (totalStock < minStock) return 'warning';
    return 'success';
  };

  const stockCardStyle = (totalStock: number, minStock: number): CSSProperties => {
    if (totalStock <= 0) {
      return { borderLeft: '4px solid #eb445a', background: '#fff5f5' };
    }
    if (minStock > 0 && totalStock < minStock) {
      return { borderLeft: '4px solid #ffc409', background: '#fffbf0' };
    }
    return { borderLeft: '4px solid #2dd36f', background: '#f0faf4' };
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Inventory">
        <IonSpinner data-testid="inventory-loading" />
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Inventory">
      <h2>INVENTORY</h2>
      {loadError && (
        <IonCard color="danger" data-testid="load-error">
          <IonCardContent>
            <p>Failed to load data: {loadError}</p>
            <IonButton onClick={loadData}>Retry</IonButton>
          </IonCardContent>
        </IonCard>
      )}
      {error && (
        <IonText color="danger">
          <p>{error}</p>
        </IonText>
      )}

      <IonSegment
        value={viewMode}
        onIonChange={(e) => setViewMode(e.detail.value as ViewMode)}
        data-testid="inventory-view-toggle"
      >
        <IonSegmentButton value="grouped">
          <IonLabel>Grouped</IonLabel>
        </IonSegmentButton>
        <IonSegmentButton value="lots">
          <IonLabel>Lots</IonLabel>
        </IonSegmentButton>
      </IonSegment>

      {/* ========================================================== */}
      {/*  SEARCH FILTER                                               */}
      {/* ========================================================== */}
      <div style={{ margin: '12px 0' }}>
        <IonInput
          placeholder="Search products..."
          aria-label="Search products"
          value={searchText}
          onIonInput={(e) => setSearchText(e.detail.value ?? '')}
          data-testid="inventory-search"
        />
      </div>

      {/* ========================================================== */}
      {/*  GROUPED VIEW                                                */}
      {/* ========================================================== */}
      {viewMode === 'grouped' && (
        <div data-testid="grouped-view">
          {filteredGrouped.length === 0 && <p data-testid="no-products">No products in inventory.</p>}

          {filteredGrouped.map(({ product, totalStock, nearestExpiry, lotCount }) => (
            <IonCard
              key={product.product_id}
              data-testid={`inv-product-${product.product_id}`}
              style={stockCardStyle(totalStock, Number(product.min_stock_amount))}
            >
              <IonCardHeader>
                <IonCardTitle>{product.name}</IonCardTitle>
                {product.barcode && (
                  <span style={{ fontSize: '0.8em', color: '#888' }} data-testid={`barcode-${product.product_id}`}>
                    {product.barcode}
                  </span>
                )}
                <span style={{ fontSize: '0.85em', color: '#666' }}>
                  {Number(product.servings_per_container)} srvg/ctn
                </span>
              </IonCardHeader>
              <IonCardContent>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr 1fr',
                    gap: '8px',
                    alignItems: 'center',
                    marginBottom: '12px',
                  }}
                >
                  <div>
                    <span style={{ fontSize: '0.85em', color: '#888' }}>Total Stock</span>
                    <br />
                    <IonBadge
                      color={stockBadgeColor(totalStock, Number(product.min_stock_amount))}
                      data-testid={`stock-badge-${product.product_id}`}
                    >
                      {totalStock.toFixed(1)} ctn
                    </IonBadge>
                    <br />
                    <span
                      style={{ fontSize: '0.8em', color: '#888' }}
                      data-testid={`stock-servings-${product.product_id}`}
                    >
                      ({(totalStock * Number(product.servings_per_container)).toFixed(1)} svgs)
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.85em', color: '#888' }}>Nearest Expiry</span>
                    <br />
                    <span data-testid={`expiry-${product.product_id}`}>{nearestExpiry ?? '\u2014'}</span>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.85em', color: '#888' }}>Min Stock</span>
                    <br />
                    <span data-testid={`min-stock-${product.product_id}`}>
                      {Number(product.min_stock_amount).toFixed(1)} ctn
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.85em', color: '#888' }}>Lots</span>
                    <br />
                    <span data-testid={`lot-count-${product.product_id}`}>{lotCount}</span>
                  </div>
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  <IonButton
                    size="small"
                    color="success"
                    onClick={() => openAddStockModal(product.product_id, 1)}
                    data-testid={`add-ctn-${product.product_id}`}
                  >
                    +1 Ctn
                  </IonButton>
                  <IonButton
                    size="small"
                    color="warning"
                    onClick={() => consumeStock(product.product_id, 1, 'container')}
                    data-testid={`sub-ctn-${product.product_id}`}
                  >
                    -1 Ctn
                  </IonButton>
                  <IonButton
                    size="small"
                    color="success"
                    fill="outline"
                    onClick={() => openAddStockModal(product.product_id, 1 / Number(product.servings_per_container))}
                    data-testid={`add-srv-${product.product_id}`}
                  >
                    +1 Srv
                  </IonButton>
                  <IonButton
                    size="small"
                    color="warning"
                    fill="outline"
                    onClick={() => consumeStock(product.product_id, 1, 'serving')}
                    data-testid={`sub-srv-${product.product_id}`}
                  >
                    -1 Srv
                  </IonButton>
                  <IonButton
                    size="small"
                    color="danger"
                    fill="clear"
                    onClick={() => setConsumeAllTarget(product.product_id)}
                    data-testid={`consume-all-${product.product_id}`}
                  >
                    Consume All
                  </IonButton>
                </div>
              </IonCardContent>
            </IonCard>
          ))}
        </div>
      )}

      {/* ========================================================== */}
      {/*  LOTS VIEW                                                   */}
      {/* ========================================================== */}
      {viewMode === 'lots' && (
        <div data-testid="lots-view">
          {sortedLots.length === 0 && <p data-testid="no-lots">No stock lots.</p>}

          {sortedLots.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '12px' }} data-testid="lots-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Product</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Location</th>
                  <th style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #ddd' }}>Qty (ctn)</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #ddd' }}>Expires</th>
                </tr>
              </thead>
              <tbody>
                {sortedLots.map((lot) => (
                  <tr key={lot.lot_id} data-testid={`lot-row-${lot.lot_id}`}>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{lot.productName}</td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>
                      {lot.locations?.name ?? '\u2014'}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px', borderBottom: '1px solid #eee' }}>
                      {Number(lot.qty_containers).toFixed(1)}
                    </td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{lot.expires_on ?? '\u2014'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ========================================================== */}
      {/*  ADD STOCK MODAL                                              */}
      {/* ========================================================== */}
      <ModalOverlay
        isOpen={addingStockFor !== null}
        onClose={closeAddStockModal}
        title={`Add Stock — ${products.find((p) => p.product_id === addingStockFor)?.name ?? ''}`}
        testId="add-stock-modal"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label style={{ fontSize: '0.85em', color: '#888' }}>Quantity (containers)</label>
            <IonInput
              type="number"
              aria-label="Quantity in containers"
              value={addStockQty}
              min="0.001"
              step={'0.1'}
              onIonInput={(e) => {
                const val = parseFloat(e.detail.value ?? '');
                if (!isNaN(val)) setAddStockQty(val);
              }}
              data-testid="add-stock-qty"
            />
          </div>
          <div>
            <label style={{ fontSize: '0.85em', color: '#888' }}>Expiry Date (optional)</label>
            <IonInput
              type="date"
              aria-label="Expiry date"
              value={addStockExpiry}
              onIonInput={(e) => setAddStockExpiry(e.detail.value ?? '')}
              data-testid="add-stock-expiry"
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
            <IonButton fill="clear" onClick={closeAddStockModal} data-testid="add-stock-cancel">
              Cancel
            </IonButton>
            <IonButton onClick={confirmAddStock} disabled={addStockQty <= 0} data-testid="add-stock-confirm">
              Add
            </IonButton>
          </div>
        </div>
      </ModalOverlay>

      {/* Consume All confirmation */}
      <IonAlert
        isOpen={consumeAllTarget !== null}
        header="Consume All Stock"
        message="Are you sure you want to consume all remaining stock for this product?"
        buttons={[
          { text: 'Cancel', role: 'cancel', handler: () => setConsumeAllTarget(null) },
          {
            text: 'Consume All',
            handler: () => {
              if (consumeAllTarget) consumeAll(consumeAllTarget);
            },
          },
        ]}
        onDidDismiss={() => setConsumeAllTarget(null)}
      />
    </ChefLayout>
  );
}
