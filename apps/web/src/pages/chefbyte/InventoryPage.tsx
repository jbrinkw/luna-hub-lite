import { useEffect, useState, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
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
  const { dayStartHour } = useAppContext();
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('grouped');

  const [loadError, setLoadError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [lots, setLots] = useState<StockLot[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
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
  }, [user, loadData]);

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
    let result = grouped.filter((g) => g.totalStock > 0 || Number(g.product.min_stock_amount) > 0);
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((g) => g.product.name.toLowerCase().includes(lower));
    }
    return result;
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

  const getLogicalDate = () => todayStr(dayStartHour);

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
      p_log_macros: true,
      p_logical_date: getLogicalDate(),
    });
    if (err) {
      setError(err.message);
      return;
    }
    setError(null);
    await loadData();
  };

  const handleConsumeAll = (productId: string) => {
    const item = grouped.find((g) => g.product.product_id === productId);
    if (!item || item.totalStock <= 0) return;
    setConfirmState({
      open: true,
      action: () => {
        closeConfirm();
        consumeStock(productId, item.totalStock, 'container');
      },
    });
  };

  /* ---------------------------------------------------------------- */
  /*  Stock badge color                                                */
  /* ---------------------------------------------------------------- */

  const stockDotColor = (totalStock: number, minStock: number): string => {
    if (totalStock <= 0) return 'bg-red-600';
    if (totalStock < minStock) return 'bg-amber-500';
    return 'bg-green-600';
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  const inputCls =
    'w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 box-border';

  if (loading) {
    return (
      <ChefLayout title="Inventory">
        <div className="p-5" data-testid="inventory-loading">
          Loading inventory...
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Inventory">
      <h1 className="m-0 text-2xl font-bold text-slate-900">Inventory</h1>
      {loadError && (
        <div data-testid="load-error" className="bg-red-50 border border-red-600 rounded-lg p-3 mb-3">
          <p className="text-red-600 m-0 mb-2">Failed to load data: {loadError}</p>
          <button
            className="bg-emerald-600 text-white border-none px-4 py-1.5 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700"
            onClick={loadData}
          >
            Retry
          </button>
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}

      {/* View toggle */}
      <div className="flex gap-2 mb-4" data-testid="inventory-view-toggle">
        <button
          className={`px-4 py-1.5 rounded-md cursor-pointer font-semibold border text-sm ${
            viewMode === 'grouped'
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-slate-600 border-slate-200'
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
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-slate-600 border-slate-200'
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

      {/* ========================================================== */}
      {/*  GROUPED VIEW                                                */}
      {/* ========================================================== */}
      {viewMode === 'grouped' && (
        <div data-testid="grouped-view">
          {filteredGrouped.length === 0 && (
            <p data-testid="no-products" className="text-slate-500">
              No products in inventory. Scan a barcode or add products in Settings to get started.
            </p>
          )}

          {filteredGrouped.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              {/* Table header */}
              <div className="grid grid-cols-[24px_1fr_100px_80px] gap-0 px-3 py-2 bg-slate-50 border-b-2 border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <span />
                <span>Product</span>
                <span>Stock</span>
                <span>Expiry</span>
              </div>

              {/* Product rows */}
              {filteredGrouped.map(({ product, totalStock, nearestExpiry }, idx) => {
                const isZeroStock = totalStock <= 0;
                const servingsTotal = totalStock * Number(product.servings_per_container);
                const isExpanded = expandedProductId === product.product_id;
                const expiryLabel = nearestExpiry
                  ? new Date(nearestExpiry + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })
                  : '\u2014';

                return (
                  <div
                    key={product.product_id}
                    data-testid={`inv-product-${product.product_id}`}
                    className={`${idx < filteredGrouped.length - 1 ? 'border-b border-slate-100' : ''} ${isZeroStock ? 'opacity-50' : ''}`}
                  >
                    {/* Collapsed row — always visible, clickable to toggle */}
                    <button
                      type="button"
                      className={`grid grid-cols-[24px_1fr_100px_80px] gap-0 px-3 py-2.5 items-center text-sm w-full text-left bg-transparent border-none cursor-pointer hover:bg-slate-50 transition-colors ${isExpanded ? 'bg-slate-50' : ''}`}
                      onClick={() => setExpandedProductId(isExpanded ? null : product.product_id)}
                      aria-expanded={isExpanded}
                      data-testid={`inv-row-toggle-${product.product_id}`}
                    >
                      {/* Chevron indicator */}
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-slate-400" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-400" />
                      )}

                      {/* Product name + stock dot */}
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${stockDotColor(totalStock, Number(product.min_stock_amount))}`}
                        />
                        <span className="font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
                          {product.name}
                        </span>
                      </div>

                      {/* Stock */}
                      <span data-testid={`stock-badge-${product.product_id}`} className="font-semibold text-sm">
                        {totalStock.toFixed(1)} ctn
                      </span>

                      {/* Expiry */}
                      <span data-testid={`expiry-${product.product_id}`} className="text-[13px] text-slate-600">
                        {expiryLabel}
                      </span>
                    </button>

                    {/* Expanded detail panel */}
                    {isExpanded && (
                      <div
                        className="px-4 pb-4 pt-1 bg-slate-50/50 border-t border-slate-100"
                        data-testid={`inv-detail-${product.product_id}`}
                      >
                        {/* Detail info */}
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 mb-3">
                          <span data-testid={`stock-servings-${product.product_id}`}>
                            {totalStock.toFixed(1)} containers ({servingsTotal.toFixed(1)} servings)
                          </span>
                          <span data-testid={`min-stock-${product.product_id}`}>
                            Min stock: {Number(product.min_stock_amount).toFixed(1)}
                          </span>
                          {product.barcode && (
                            <span data-testid={`barcode-${product.product_id}`}>Barcode: {product.barcode}</span>
                          )}
                        </div>

                        {/* Action buttons — clean grid layout */}
                        <div className="grid grid-cols-2 gap-2 max-w-sm">
                          <button
                            className="flex items-center justify-center gap-1.5 bg-green-600 text-white border-none px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-green-700 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddStockModal(product.product_id, 1);
                            }}
                            data-testid={`add-ctn-${product.product_id}`}
                          >
                            Add Container
                          </button>
                          <button
                            className="flex items-center justify-center gap-1.5 bg-red-600 text-white border-none px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-red-700 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              consumeStock(product.product_id, 1, 'container');
                            }}
                            data-testid={`sub-ctn-${product.product_id}`}
                          >
                            Remove Container
                          </button>
                          <button
                            className="flex items-center justify-center gap-1.5 bg-white text-green-600 border-2 border-green-600 px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-green-50 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddStockModal(product.product_id, 1 / Number(product.servings_per_container));
                            }}
                            data-testid={`add-srv-${product.product_id}`}
                          >
                            Add Serving
                          </button>
                          <button
                            className="flex items-center justify-center gap-1.5 bg-white text-red-600 border-2 border-red-600 px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-red-50 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              consumeStock(product.product_id, 1, 'serving');
                            }}
                            data-testid={`sub-srv-${product.product_id}`}
                          >
                            Remove Serving
                          </button>
                        </div>

                        {/* Consume All — separate, text-style */}
                        <button
                          className="mt-2 bg-transparent text-slate-500 border-none px-0 py-1 cursor-pointer text-sm underline hover:text-slate-700 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConsumeAll(product.product_id);
                          }}
                          data-testid={`consume-all-${product.product_id}`}
                        >
                          Consume All
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================================== */}
      {/*  LOTS VIEW                                                   */}
      {/* ========================================================== */}
      {viewMode === 'lots' && (
        <div data-testid="lots-view">
          {sortedLots.length === 0 && <p data-testid="no-lots">No stock lots.</p>}

          {sortedLots.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-slate-200 mt-3">
              <table className="w-full border-collapse" data-testid="lots-table">
                <thead>
                  <tr className="bg-slate-50 border-b-2 border-slate-200">
                    <th className="p-3 text-left font-semibold">Product</th>
                    <th className="p-3 text-left font-semibold">Location</th>
                    <th className="p-3 text-right font-semibold">Qty (ctn)</th>
                    <th className="p-3 text-left font-semibold">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLots.map((lot) => (
                    <tr key={lot.lot_id} data-testid={`lot-row-${lot.lot_id}`} className="border-b border-slate-100">
                      <td className="p-3">{lot.productName}</td>
                      <td className="p-3">{lot.locations?.name ?? '\u2014'}</td>
                      <td className="text-right p-3">{Number(lot.qty_containers).toFixed(1)}</td>
                      <td className="p-3">{lot.expires_on ?? '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
            <label className="text-[0.85em] text-slate-400 block mb-1">Quantity (containers)</label>
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
            <label className="text-[0.85em] text-slate-400 block mb-1">Expiry Date (optional)</label>
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
              className="bg-transparent text-slate-600 border-none px-4 py-1.5 rounded-md cursor-pointer hover:text-slate-900"
              onClick={closeAddStockModal}
              data-testid="add-stock-cancel"
            >
              Cancel
            </button>
            <button
              className={`text-white border-none px-4 py-1.5 rounded-md cursor-pointer font-semibold ${
                addStockQty <= 0 ? 'bg-slate-300 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700'
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
    </ChefLayout>
  );
}
