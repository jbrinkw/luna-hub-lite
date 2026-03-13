import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { ModalOverlay } from '@/components/shared/ModalOverlay';
import { useAuth } from '@/shared/auth/AuthProvider';
import { useAppContext } from '@/shared/AppProvider';
import { chefbyte } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
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

  /* ---------------------------------------------------------------- */
  /*  Data loading via TanStack Query                                  */
  /* ---------------------------------------------------------------- */

  const {
    data: products = [],
    isLoading: productsLoading,
    error: productsError,
  } = useQuery({
    queryKey: queryKeys.products(user!.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('products')
        .select('product_id,user_id,name,barcode,servings_per_container,min_stock_amount')
        .eq('user_id', user!.id)
        .order('name');
      if (error) throw error;
      return (data ?? []) as Product[];
    },
    enabled: !!user,
  });

  const { data: lots = [], isLoading: lotsLoading } = useQuery({
    queryKey: queryKeys.stockLots(user!.id),
    queryFn: async () => {
      const { data, error } = await chefbyte()
        .from('stock_lots')
        .select('lot_id,product_id,qty_containers,expires_on,locations:location_id(name)')
        .eq('user_id', user!.id);
      if (error) throw error;
      return (data ?? []) as StockLot[];
    },
    enabled: !!user,
  });

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
    { schema: 'chefbyte', table: 'stock_lots', queryKeys: [queryKeys.stockLots(user!.id)] },
    { schema: 'chefbyte', table: 'products', queryKeys: [queryKeys.products(user!.id)] },
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
    // Sort: in-stock items first (alphabetically), then 0-qty items at end (alphabetically)
    result.sort((a, b) => {
      const aZero = a.totalStock <= 0 ? 1 : 0;
      const bZero = b.totalStock <= 0 ? 1 : 0;
      if (aZero !== bZero) return aZero - bZero;
      return a.product.name.localeCompare(b.product.name);
    });
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
    onSuccess: () => {
      setError(null);
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
    mutationFn: async ({ productId, qty, unit }: { productId: string; qty: number; unit: 'container' | 'serving' }) => {
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
    onSuccess: () => {
      setError(null);
    },
    onSettled: () => {
      invalidateInventory();
    },
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

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  const inputCls =
    'w-full px-3 py-2.5 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary box-border';

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
      <h1 className="m-0 text-2xl font-bold text-text">Inventory</h1>
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
                    className={`${idx < filteredGrouped.length - 1 ? 'border-b border-border-light' : ''} ${isZeroStock ? 'opacity-50' : ''}`}
                  >
                    {/* Collapsed row — always visible, clickable to toggle */}
                    <button
                      type="button"
                      className={`grid grid-cols-[24px_1fr_80px] sm:grid-cols-[24px_1fr_100px_80px] gap-0 px-3 py-2.5 items-center text-sm w-full text-left bg-transparent border-none cursor-pointer hover:bg-surface-hover transition-colors ${isExpanded ? 'bg-surface-hover' : ''}`}
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

                      {/* Product name + stock dot */}
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${stockDotColor(totalStock, Number(product.min_stock_amount))}`}
                        />
                        <span className="font-semibold sm:whitespace-nowrap sm:overflow-hidden sm:text-ellipsis">
                          {product.name}
                        </span>
                      </div>

                      {/* Stock */}
                      <span data-testid={`stock-badge-${product.product_id}`} className="font-semibold text-sm">
                        {totalStock.toFixed(1)} ctn
                      </span>

                      {/* Expiry (hidden on small screens) */}
                      <span
                        data-testid={`expiry-${product.product_id}`}
                        className="text-[13px] text-text-secondary hidden sm:block"
                      >
                        {expiryLabel}
                      </span>
                    </button>

                    {/* Expanded detail panel */}
                    {isExpanded && (
                      <div
                        className="px-4 pb-4 pt-1 bg-surface-sunken/50 border-t border-border-light"
                        data-testid={`inv-detail-${product.product_id}`}
                      >
                        {/* Detail info */}
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-secondary mb-3">
                          <span data-testid={`stock-servings-${product.product_id}`}>
                            {totalStock.toFixed(1)} containers ({servingsTotal.toFixed(1)} servings)
                          </span>
                          <span data-testid={`min-stock-${product.product_id}`}>
                            Min stock: {Number(product.min_stock_amount).toFixed(1)}
                          </span>
                          <span data-testid={`detail-expiry-${product.product_id}`}>Expires: {expiryLabel}</span>
                          {product.barcode && (
                            <span data-testid={`barcode-${product.product_id}`}>Barcode: {product.barcode}</span>
                          )}
                        </div>

                        {/* Action buttons — clean grid layout */}
                        <div className="grid grid-cols-2 gap-2 max-w-sm">
                          <button
                            className="flex items-center justify-center gap-1.5 bg-success text-white border-none px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-success-hover transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddStockModal(product.product_id, 1);
                            }}
                            data-testid={`add-ctn-${product.product_id}`}
                          >
                            Add Container
                          </button>
                          <button
                            className="flex items-center justify-center gap-1.5 bg-danger text-white border-none px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-danger-hover transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              consumeStockMutation.mutate({ productId: product.product_id, qty: 1, unit: 'container' });
                            }}
                            data-testid={`sub-ctn-${product.product_id}`}
                          >
                            Remove Container
                          </button>
                          <button
                            className="flex items-center justify-center gap-1.5 bg-surface text-success-text border-2 border-success px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-success-subtle transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddStockModal(product.product_id, 1 / Number(product.servings_per_container));
                            }}
                            data-testid={`add-srv-${product.product_id}`}
                          >
                            Add Serving
                          </button>
                          <button
                            className="flex items-center justify-center gap-1.5 bg-surface text-danger-text border-2 border-danger px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-danger-subtle transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              consumeStockMutation.mutate({ productId: product.product_id, qty: 1, unit: 'serving' });
                            }}
                            data-testid={`sub-srv-${product.product_id}`}
                          >
                            Remove Serving
                          </button>
                        </div>

                        {/* Consume All — separate, text-style */}
                        <button
                          className="mt-2 bg-transparent text-text-secondary border-none px-0 py-1 cursor-pointer text-sm underline hover:text-text transition-colors"
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
            <>
              {/* Mobile card list */}
              <div className="sm:hidden flex flex-col gap-2 mt-3" data-testid="lots-table">
                {sortedLots.map((lot) => (
                  <div
                    key={lot.lot_id}
                    data-testid={`lot-row-${lot.lot_id}`}
                    className="bg-surface border border-border rounded-lg p-3"
                  >
                    <div className="font-semibold text-sm text-text mb-1">{lot.productName}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-secondary">
                      <span>{Number(lot.qty_containers).toFixed(1)} ctn</span>
                      <span>{lot.locations?.name ?? '\u2014'}</span>
                      <span>Expires: {lot.expires_on ?? '\u2014'}</span>
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
                      <th className="p-3 text-right font-semibold">Qty (ctn)</th>
                      <th className="p-3 text-left font-semibold">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLots.map((lot) => (
                      <tr
                        key={lot.lot_id}
                        data-testid={`lot-row-${lot.lot_id}`}
                        className="border-b border-border-light"
                      >
                        <td className="p-3">{lot.productName}</td>
                        <td className="p-3">{lot.locations?.name ?? '\u2014'}</td>
                        <td className="text-right p-3">{Number(lot.qty_containers).toFixed(1)}</td>
                        <td className="p-3">{lot.expires_on ?? '\u2014'}</td>
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
    </ChefLayout>
  );
}
