import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, escapeIlike } from '@/shared/supabase';
import { queryKeys } from '@/shared/queryKeys';
import { useRealtimeInvalidation } from '@/shared/useRealtimeInvalidation';
import { generateWalmartCartLink } from '@/lib/walmart';
import { PackageSearch } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ShoppingItem {
  cart_item_id: string;
  user_id: string;
  product_id: string;
  qty_containers: number;
  purchased: boolean;
  created_at: string;
  products: {
    name: string;
    barcode: string | null;
    price: number | null;
    walmart_link: string | null;
    is_placeholder: boolean;
  } | null;
}

interface ProductSearchResult {
  product_id: string;
  name: string;
}

/* ================================================================== */
/*  ShoppingPage                                                       */
/* ================================================================== */

export function ShoppingPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);

  /* ---- Add item form state ---- */
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<ProductSearchResult[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [addQty, setAddQty] = useState(1);
  const [showDropdown, setShowDropdown] = useState(false);

  /* ---- Confirm modal state ---- */
  /* ---- Purchase animation state ---- */
  const [justPurchasedIds, setJustPurchasedIds] = useState<Set<string>>(new Set());

  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    action: () => void;
  }>({ open: false, title: '', message: '', confirmLabel: 'Confirm', action: () => {} });

  const closeConfirm = () => setConfirmState((prev) => ({ ...prev, open: false }));

  /* ---------------------------------------------------------------- */
  /*  Data loading via TanStack Query                                  */
  /* ---------------------------------------------------------------- */

  const { data: items = [], isLoading } = useQuery({
    queryKey: queryKeys.shoppingList(user!.id),
    queryFn: async () => {
      const { data, error: loadErr } = await chefbyte()
        .from('shopping_list')
        .select('*, products:product_id(name, barcode, price, walmart_link, is_placeholder)')
        .eq('user_id', user!.id)
        .order('created_at');
      if (loadErr) throw loadErr;
      return (data ?? []) as ShoppingItem[];
    },
    enabled: !!user,
  });

  /* ---------------------------------------------------------------- */
  /*  Realtime subscriptions                                           */
  /* ---------------------------------------------------------------- */

  useRealtimeInvalidation('shopping-changes', [
    { schema: 'chefbyte', table: 'shopping_list', queryKeys: [queryKeys.shoppingList(user!.id)] },
  ]);

  /* ---------------------------------------------------------------- */
  /*  Derived state                                                    */
  /* ---------------------------------------------------------------- */

  const toBuy = useMemo(() => items.filter((i) => !i.purchased), [items]);
  const purchased = useMemo(() => items.filter((i) => i.purchased), [items]);

  /* ---------------------------------------------------------------- */
  /*  Product search (server-side ilike + 300ms debounce)              */
  /* ---------------------------------------------------------------- */

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const searchProducts = useCallback(
    async (text: string) => {
      if (!user || text.trim().length < 1) {
        setSearchResults([]);
        setShowDropdown(false);
        return;
      }
      const { data } = await chefbyte()
        .from('products')
        .select('product_id, name')
        .eq('user_id', user.id)
        .not('name', 'ilike', '[MEAL]%')
        .ilike('name', `%${escapeIlike(text)}%`)
        .order('name');

      const results = (data ?? []) as ProductSearchResult[];
      setSearchResults(results);
      setShowDropdown(results.length > 0);
    },
    [user],
  );

  const handleSearchInput = (value: string) => {
    setSearchText(value);
    setSelectedProductId(null);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => searchProducts(value), 300);
  };

  const selectProduct = (product: ProductSearchResult) => {
    setSearchText(product.name);
    setSelectedProductId(product.product_id);
    setShowDropdown(false);
    setSearchResults([]);
  };

  /* ---------------------------------------------------------------- */
  /*  Mutations                                                        */
  /* ---------------------------------------------------------------- */

  const invalidateShoppingList = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList(user!.id) });
  };

  const toggleMutation = useMutation({
    mutationFn: async (item: ShoppingItem) => {
      const { error: updateErr } = await chefbyte()
        .from('shopping_list')
        .update({ purchased: !item.purchased })
        .eq('cart_item_id', item.cart_item_id);
      if (updateErr) throw updateErr;
    },
    onMutate: async (item) => {
      const key = queryKeys.shoppingList(user!.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (old: ShoppingItem[] | undefined) =>
        old?.map((i) => (i.cart_item_id === item.cart_item_id ? { ...i, purchased: !i.purchased } : i)),
      );
      return { previous };
    },
    onError: (err: any, _item, context) => {
      queryClient.setQueryData(queryKeys.shoppingList(user!.id), context?.previous);
      setError(err.message ?? String(err));
    },
    onSettled: () => {
      invalidateShoppingList();
    },
  });

  const togglePurchased = (item: ShoppingItem) => {
    setError(null);

    // Trigger green flash animation when marking as purchased
    if (!item.purchased) {
      setJustPurchasedIds((prev) => new Set(prev).add(item.cart_item_id));
      setTimeout(() => {
        setJustPurchasedIds((prev) => {
          const next = new Set(prev);
          next.delete(item.cart_item_id);
          return next;
        });
      }, 600);
    }

    toggleMutation.mutate(item);
  };

  const removeMutation = useMutation({
    mutationFn: async (cartItemId: string) => {
      const { error: deleteErr } = await chefbyte().from('shopping_list').delete().eq('cart_item_id', cartItemId);
      if (deleteErr) throw deleteErr;
    },
    onMutate: async (cartItemId) => {
      const key = queryKeys.shoppingList(user!.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, (old: ShoppingItem[] | undefined) =>
        old?.filter((i) => i.cart_item_id !== cartItemId),
      );
      return { previous };
    },
    onError: (err: any, _id, context) => {
      queryClient.setQueryData(queryKeys.shoppingList(user!.id), context?.previous);
      setError(err.message ?? String(err));
    },
    onSettled: () => {
      invalidateShoppingList();
    },
  });

  const addItem = async () => {
    if (!user || !searchText.trim()) return;
    setError(null);

    let productId = selectedProductId;

    // If no product selected, create a placeholder
    if (!productId) {
      const { data: newProduct, error: createErr } = await chefbyte()
        .from('products')
        .insert({
          user_id: user.id,
          name: searchText.trim(),
          is_placeholder: true,
        })
        .select('product_id')
        .single();
      if (createErr) {
        setError(createErr.message);
        return;
      }
      productId = newProduct?.product_id;
    }

    if (!productId) return;

    // Check if product already exists on the list — if so, increment quantity
    const existing = items.find((i) => i.product_id === productId);
    if (existing) {
      const { error: updateErr } = await chefbyte()
        .from('shopping_list')
        .update({ qty_containers: Number(existing.qty_containers) + addQty })
        .eq('cart_item_id', existing.cart_item_id);
      if (updateErr) {
        setError(updateErr.message);
        return;
      }
    } else {
      const { error: insertErr } = await chefbyte().from('shopping_list').insert({
        user_id: user.id,
        product_id: productId,
        qty_containers: addQty,
      });
      if (insertErr) {
        setError(insertErr.message);
        return;
      }
    }

    setSearchText('');
    setSelectedProductId(null);
    setAddQty(1);
    invalidateShoppingList();
  };

  const importToInventory = async () => {
    if (!user || purchased.length === 0) return;

    // Get user's first location
    const { data: locs } = await chefbyte()
      .from('locations')
      .select('location_id')
      .eq('user_id', user.id)
      .order('created_at')
      .limit(1);
    const locId = locs?.[0]?.location_id;
    if (!locId) return;

    // Merge stock lots: check for existing lot per item, increment qty or insert new
    for (const item of purchased) {
      const { data: existingLot } = await chefbyte()
        .from('stock_lots')
        .select('lot_id, qty_containers')
        .eq('user_id', user.id)
        .eq('product_id', item.product_id)
        .eq('location_id', locId)
        .is('expires_on', null)
        .single();

      if (existingLot) {
        const { error: updateErr } = await chefbyte()
          .from('stock_lots')
          .update({ qty_containers: Number((existingLot as any).qty_containers) + Number(item.qty_containers) })
          .eq('lot_id', (existingLot as any).lot_id);
        if (updateErr) {
          setError(updateErr.message);
          return;
        }
      } else {
        const { error: insertErr } = await chefbyte().from('stock_lots').insert({
          user_id: user.id,
          product_id: item.product_id,
          location_id: locId,
          qty_containers: item.qty_containers,
        });
        if (insertErr) {
          setError(insertErr.message);
          return;
        }
      }
    }

    // Delete purchased items from shopping list
    const ids = purchased.map((i) => i.cart_item_id);
    const { error: delErr } = await chefbyte().from('shopping_list').delete().in('cart_item_id', ids);
    if (delErr) {
      setError(delErr.message);
      return;
    }

    invalidateShoppingList();
  };

  const autoAddBelowMinStock = async () => {
    if (!user) return;
    setError(null);

    // Get all products with min_stock_amount
    const { data: prods } = await chefbyte()
      .from('products')
      .select('product_id, name, min_stock_amount')
      .eq('user_id', user.id)
      .not('name', 'ilike', '[MEAL]%')
      .gt('min_stock_amount', 0);

    if (!prods || prods.length === 0) return;

    // Get all stock lots to calculate current stock
    const { data: stockLots } = await chefbyte()
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', user.id);

    // Calculate current stock per product
    const stockByProduct = new Map<string, number>();
    for (const lot of stockLots ?? []) {
      const current = stockByProduct.get(lot.product_id) ?? 0;
      stockByProduct.set(lot.product_id, current + Number(lot.qty_containers));
    }

    // Collect deficient products — upsert sets qty to full deficit
    const rowsToUpsert: Array<{ user_id: string; product_id: string; qty_containers: number }> = [];
    for (const product of prods) {
      const currentStock = stockByProduct.get(product.product_id) ?? 0;
      const minStock = Number(product.min_stock_amount);
      if (currentStock < minStock) {
        const deficit = Math.ceil(minStock - currentStock);
        if (deficit > 0) {
          rowsToUpsert.push({
            user_id: user.id,
            product_id: product.product_id,
            qty_containers: deficit,
          });
        }
      }
    }
    if (rowsToUpsert.length > 0) {
      const { error: batchErr } = await chefbyte()
        .from('shopping_list')
        .upsert(rowsToUpsert, { onConflict: 'user_id,product_id' });
      if (batchErr) {
        setError(batchErr.message);
        return;
      }
    }

    invalidateShoppingList();
  };

  const clearAll = async () => {
    if (!user || items.length === 0) return;
    setError(null);
    const { error: delErr } = await chefbyte().from('shopping_list').delete().eq('user_id', user.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    invalidateShoppingList();
  };

  const handleClearAll = () => {
    setConfirmState({
      open: true,
      title: 'Clear Shopping List',
      message: 'Are you sure you want to remove all items from the shopping list?',
      confirmLabel: 'Clear All',
      action: () => {
        closeConfirm();
        clearAll();
      },
    });
  };

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const formatQty = (qty: number): string => {
    const rounded = Math.ceil(qty);
    return `${rounded} container${rounded !== 1 ? 's' : ''}`;
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (isLoading) {
    return (
      <ChefLayout title="Shopping">
        <div className="p-5" data-testid="shopping-loading">
          <ListSkeleton count={5} />
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Shopping">
      <div>
        <div className="flex justify-between items-center flex-wrap gap-2 mb-5">
          <h1 className="m-0 text-2xl font-bold text-slate-900">Shopping List</h1>
          <button
            onClick={() => {
              const missingLink = toBuy.filter(
                (i) =>
                  !i.products?.is_placeholder &&
                  !i.products?.walmart_link &&
                  i.products?.walmart_link !== 'NOT_ON_WALMART',
              );
              const link = generateWalmartCartLink(toBuy);
              if (!link) {
                alert('No items with Walmart links found.');
                return;
              }
              if (missingLink.length > 0) {
                const names = missingLink.map((i) => i.products?.name ?? 'Unknown').join(', ');
                setConfirmState({
                  open: true,
                  title: 'Missing Walmart Links',
                  message: `${missingLink.length} item${missingLink.length > 1 ? 's' : ''} missing Walmart links and won't be in the cart: ${names}. Continue?`,
                  confirmLabel: 'Continue',
                  action: () => {
                    closeConfirm();
                    window.open(link, '_blank');
                  },
                });
                return;
              }
              window.open(link, '_blank');
            }}
            disabled={toBuy.length === 0}
            data-testid="walmart-cart-btn"
            className="px-4 py-2.5 bg-[#0071ce] text-white border-none rounded-md cursor-pointer text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Open in Walmart
          </button>
        </div>

        {/* Auto-Add Below Min Stock CTA */}
        <button
          onClick={autoAddBelowMinStock}
          data-testid="auto-add-btn"
          className="w-full mb-5 flex items-center gap-3 px-5 py-4 bg-emerald-50 border-2 border-dashed border-emerald-300 rounded-xl cursor-pointer hover:bg-emerald-100 hover:border-emerald-400 transition-colors text-left"
        >
          <PackageSearch className="w-7 h-7 text-emerald-600 shrink-0" />
          <div>
            <span className="block text-base font-bold text-emerald-700">Auto-Add Below Min Stock</span>
            <span className="block text-sm text-emerald-600/80 mt-0.5">
              Add items that are below your minimum stock levels
            </span>
          </div>
        </button>

        {error && <div className="text-red-600 text-sm p-2">{error}</div>}

        {/* ============================================================ */}
        {/*  ADD ITEM FORM                                                */}
        {/* ============================================================ */}
        <div data-testid="add-item-form" className="bg-slate-50 p-4 rounded-lg mb-5 flex gap-3 flex-wrap">
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder="Item name"
              value={searchText}
              onChange={(e) => handleSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addItem()}
              data-testid="add-item-name"
              className="w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm box-border focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
            {/* Autocomplete dropdown */}
            {showDropdown && (
              <div
                data-testid="product-dropdown"
                className="absolute top-full left-0 right-0 bg-white border border-slate-300 rounded z-10 max-h-[200px] overflow-auto shadow-md"
              >
                {searchResults.map((p) => (
                  <div
                    key={p.product_id}
                    onClick={() => selectProduct(p)}
                    data-testid={`dropdown-item-${p.product_id}`}
                    className="px-3 py-2 cursor-pointer hover:bg-slate-50"
                  >
                    {p.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <input
            type="number"
            placeholder="Qty"
            min="0"
            value={addQty}
            onChange={(e) => setAddQty(Number(e.target.value) || 1)}
            data-testid="add-item-qty"
            className="w-[100px] px-3 py-2.5 border border-slate-300 rounded-md text-sm"
          />
          <button
            onClick={addItem}
            disabled={!searchText.trim()}
            data-testid="add-item-btn"
            className="px-5 py-2.5 bg-emerald-600 text-white border-none rounded-md cursor-pointer font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>

        {/* ============================================================ */}
        {/*  TO BUY SECTION                                               */}
        {/* ============================================================ */}
        <div data-testid="to-buy-section" className="bg-white border border-slate-200 rounded-lg p-4 mb-5">
          <h3 className="m-0 mb-3 text-base font-semibold">To Buy ({toBuy.length})</h3>
          {toBuy.length === 0 ? (
            <div data-testid="no-to-buy" className="text-center text-slate-400 py-5">
              Your shopping list is empty. Scan items or auto-add low-stock products.
            </div>
          ) : (
            <div data-testid="to-buy-list" className="flex flex-col gap-2">
              {toBuy.map((item) => {
                const justPurchased = justPurchasedIds.has(item.cart_item_id);
                return (
                  <div
                    key={item.cart_item_id}
                    data-testid={`item-${item.cart_item_id}`}
                    className={[
                      'flex items-center gap-3 p-2.5 rounded-md transition-colors duration-500',
                      justPurchased ? 'bg-green-100' : 'bg-slate-50',
                    ].join(' ')}
                  >
                    <div className="relative flex items-center justify-center w-[28px] h-[28px]">
                      <input
                        type="checkbox"
                        checked={item.purchased}
                        onChange={() => togglePurchased(item)}
                        aria-label={`Mark ${item.products?.name ?? 'Unknown Product'} as purchased`}
                        data-testid={`check-${item.cart_item_id}`}
                        className="cursor-pointer w-5 h-5 accent-green-600"
                      />
                      {justPurchased && (
                        <span className="absolute inset-0 flex items-center justify-center pointer-events-none animate-ping text-green-600 text-sm">
                          &#10003;
                        </span>
                      )}
                    </div>
                    <div className="flex-1">
                      <strong>{item.products?.name ?? 'Unknown Product'}</strong>
                      <span className="ml-3 text-slate-500">{formatQty(item.qty_containers)}</span>
                    </div>
                    <button
                      onClick={() => removeMutation.mutate(item.cart_item_id)}
                      data-testid={`remove-${item.cart_item_id}`}
                      className="px-3 py-1 bg-transparent text-slate-500 border border-slate-200 rounded cursor-pointer text-xs hover:bg-slate-100"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/*  PURCHASED SECTION                                            */}
        {/* ============================================================ */}
        <div data-testid="purchased-section" className="bg-white border border-slate-200 rounded-lg p-4 mb-5">
          <div className="flex justify-between items-center mb-3">
            <h3 className="m-0 text-base font-semibold text-slate-500">Purchased ({purchased.length})</h3>
            {purchased.length > 0 && (
              <button
                onClick={importToInventory}
                data-testid="import-inventory-btn"
                className="px-3 py-1.5 bg-green-600 text-white border-none rounded cursor-pointer text-[13px] font-semibold hover:bg-green-700"
              >
                Import to Inventory
              </button>
            )}
          </div>
          {purchased.length === 0 ? (
            <div data-testid="no-purchased" className="text-center text-slate-400 py-5">
              No purchased items.
            </div>
          ) : (
            <div data-testid="purchased-list" className="flex flex-col gap-2">
              {purchased.map((item) => (
                <div
                  key={item.cart_item_id}
                  data-testid={`item-${item.cart_item_id}`}
                  className="flex items-center gap-3 p-2.5 bg-slate-100 rounded-md opacity-70"
                >
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={() => togglePurchased(item)}
                    aria-label={`Unmark ${item.products?.name ?? 'Unknown Product'} as purchased`}
                    data-testid={`check-${item.cart_item_id}`}
                    className="cursor-pointer w-[18px] h-[18px]"
                  />
                  <div className="flex-1 line-through text-slate-500">
                    <strong>{item.products?.name ?? 'Unknown Product'}</strong>
                    <span className="ml-3">{formatQty(item.qty_containers)}</span>
                  </div>
                  <button
                    onClick={() => removeMutation.mutate(item.cart_item_id)}
                    data-testid={`remove-${item.cart_item_id}`}
                    className="px-3 py-1 bg-transparent text-slate-500 border border-slate-200 rounded cursor-pointer text-xs hover:bg-slate-100"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/*  CLEAR ALL BUTTON                                             */}
        {/* ============================================================ */}
        <div className="flex justify-end">
          <button
            onClick={handleClearAll}
            disabled={items.length === 0}
            data-testid="clear-all-btn"
            className="px-4 py-2.5 bg-red-600 text-white border-none rounded-md cursor-pointer text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-red-700"
          >
            Clear All
          </button>
        </div>
        <ConfirmModal
          open={confirmState.open}
          onConfirm={confirmState.action}
          onCancel={closeConfirm}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
        />
      </div>
    </ChefLayout>
  );
}
