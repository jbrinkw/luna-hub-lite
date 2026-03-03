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
} from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

// Cast needed: chefbyte schema types not yet generated
const chefbyte = () => supabase.schema('chefbyte') as any;

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

  const [products, setProducts] = useState<Product[]>([]);
  const [lots, setLots] = useState<StockLot[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [consumeAllTarget, setConsumeAllTarget] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadData = useCallback(async () => {
    if (!user) return;

    const { data: prods } = await chefbyte()
      .from('products')
      .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
      .eq('user_id', user.id)
      .order('name');

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
    loadData();
  }, [loadData]);

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

    return products.map(product => {
      const productLots = lotsByProduct.get(product.product_id) ?? [];
      const totalStock = productLots.reduce(
        (sum, l) => sum + Number(l.qty_containers),
        0,
      );

      // Find nearest expiry (excluding null)
      const expiries = productLots
        .map(l => l.expires_on)
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
  /*  Sorted lots for Lots view                                        */
  /* ---------------------------------------------------------------- */

  const sortedLots = useMemo(() => {
    const productMap = new Map(products.map(p => [p.product_id, p]));
    return [...lots]
      .map(lot => ({ ...lot, productName: productMap.get(lot.product_id)?.name ?? 'Unknown' }))
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

  const getLogicalDate = () => new Date().toISOString().slice(0, 10);

  const addStock = async (productId: string, qtyContainers: number) => {
    if (!user || !locationId) return;
    await chefbyte()
      .from('stock_lots')
      .insert({
        user_id: user.id,
        product_id: productId,
        location_id: locationId,
        qty_containers: qtyContainers,
        expires_on: null,
      });
    await loadData();
  };

  const consumeStock = async (productId: string, qty: number, unit: 'container' | 'serving') => {
    await (chefbyte() as any).rpc('consume_product', {
      p_product_id: productId,
      p_qty: qty,
      p_unit: unit,
      p_log_macros: false,
      p_logical_date: getLogicalDate(),
    });
    await loadData();
  };

  const consumeAll = async (productId: string) => {
    const item = grouped.find(g => g.product.product_id === productId);
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

      <IonSegment
        value={viewMode}
        onIonChange={e => setViewMode(e.detail.value as ViewMode)}
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
      {/*  GROUPED VIEW                                                */}
      {/* ========================================================== */}
      {viewMode === 'grouped' && (
        <div data-testid="grouped-view">
          {grouped.length === 0 && (
            <p data-testid="no-products">No products in inventory.</p>
          )}

          {grouped.map(({ product, totalStock, nearestExpiry, lotCount }) => (
            <IonCard key={product.product_id} data-testid={`inv-product-${product.product_id}`}>
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
                  <div>
                    <span style={{ fontSize: '0.85em', color: '#888' }}>Total Stock</span>
                    <br />
                    <IonBadge
                      color={stockBadgeColor(totalStock, Number(product.min_stock_amount))}
                      data-testid={`stock-badge-${product.product_id}`}
                    >
                      {totalStock.toFixed(1)} ctn
                    </IonBadge>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.85em', color: '#888' }}>Nearest Expiry</span>
                    <br />
                    <span data-testid={`expiry-${product.product_id}`}>
                      {nearestExpiry ?? '\u2014'}
                    </span>
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
                    onClick={() => addStock(product.product_id, 1)}
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
                    onClick={() => addStock(product.product_id, 1 / Number(product.servings_per_container))}
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
          {sortedLots.length === 0 && (
            <p data-testid="no-lots">No stock lots.</p>
          )}

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
                {sortedLots.map(lot => (
                  <tr key={lot.lot_id} data-testid={`lot-row-${lot.lot_id}`}>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{lot.productName}</td>
                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{lot.locations?.name ?? '\u2014'}</td>
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

      {/* Consume All confirmation */}
      <IonAlert
        isOpen={consumeAllTarget !== null}
        header="Consume All Stock"
        message="Are you sure you want to consume all remaining stock for this product?"
        buttons={[
          { text: 'Cancel', role: 'cancel', handler: () => setConsumeAllTarget(null) },
          { text: 'Consume All', handler: () => { if (consumeAllTarget) consumeAll(consumeAllTarget); } },
        ]}
        onDidDismiss={() => setConsumeAllTarget(null)}
      />
    </ChefLayout>
  );
}
