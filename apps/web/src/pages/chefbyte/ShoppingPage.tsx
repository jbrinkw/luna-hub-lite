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
import { useToast } from '@/components/shared/Toast';

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
  /**
   * Set by chefbyte.import_shopping_to_inventory RPC when the row is
   * copied into a stock_lot. Null = still in the active cart. The UI
   * defaults to filtering active rows (imported_at IS NULL); the
   * "Show imported" toggle surfaces recent imports for audit.
   */
  imported_at: string | null;
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
  const toast = useToast();

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

  /* ---- "Show imported" toggle (default off) ---- */
  /* When off, the active cart hides rows where imported_at is set.
     When on, we additionally fetch rows imported in the last 7 days
     for audit. Hidden behind a small checkbox so casual users never
     see stale imports. */
  const [showImported, setShowImported] = useState(false);

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
    queryKey: [...queryKeys.shoppingList(user!.id), { showImported }],
    queryFn: async () => {
      // Active cart = imported_at IS NULL.
      // With "Show imported" on, also fetch rows imported in the last 7 days
      // for audit. Going further back would pollute the view with noise.
      let query = chefbyte()
        .from('shopping_list')
        .select('*, products:product_id(name, barcode, price, walmart_link, is_placeholder)')
        .eq('user_id', user!.id);

      if (!showImported) {
        query = query.is('imported_at', null);
      } else {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        // imported_at IS NULL OR imported_at >= 7 days ago
        query = query.or(`imported_at.is.null,imported_at.gte.${sevenDaysAgo}`);
      }

      const { data, error: loadErr } = await query.order('created_at');
      if (loadErr) throw loadErr;
      return (data ?? []) as ShoppingItem[];
    },
    enabled: !!user,
  });

  /* ---------------------------------------------------------------- */
  /*  Walmart quota — R2 audit #7                                      */
  /* ---------------------------------------------------------------- */
  // Audit asked for an X/100 Walmart-search counter visible on Shopping
  // when there's at least one Walmart-deeplinkable item, so the user
  // sees their daily budget BEFORE clicking "Open in Walmart" or kicking
  // off a price refresh from the Walmart tab. Reads the user's own row
  // (RLS allows authenticated SELECT). Stale time 60s — this is a
  // glanceable status, not a live counter.
  const walmartTodayUtc = new Date().toISOString().slice(0, 10);
  const { data: walmartQuota } = useQuery({
    queryKey: ['walmart_quota', user?.id],
    queryFn: async () => {
      const { data: row } = await chefbyte()
        .from('walmart_quota')
        .select('used, quota_date')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (!row) return { used: 0, limit: 100 };
      const used = (row as any).quota_date === walmartTodayUtc ? Number((row as any).used) : 0;
      return { used, limit: 100 };
    },
    enabled: !!user,
    staleTime: 60 * 1000,
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

  // Active cart sections: imported rows NEVER count toward To Buy / Purchased
  // totals, even with "Show imported" on (they're surfaced in their own
  // section below so the counts match what you can actually act on).
  const toBuy = useMemo(() => items.filter((i) => !i.purchased && !i.imported_at), [items]);
  const purchased = useMemo(() => items.filter((i) => i.purchased && !i.imported_at), [items]);
  const importedItems = useMemo(() => items.filter((i) => !!i.imported_at), [items]);

  // R2 audit #7: only render the Walmart-quota chip when the user has at
  // least one item that COULD be sent to Walmart. Otherwise the counter
  // would be visual noise on an all-placeholder cart.
  const hasWalmartDeeplinkable = useMemo(
    () =>
      items.some(
        (i) =>
          i.products &&
          !i.products.is_placeholder &&
          i.products.walmart_link &&
          i.products.walmart_link !== 'NOT_ON_WALMART',
      ),
    [items],
  );

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
      const previous = queryClient.getQueriesData<ShoppingItem[]>({ queryKey: key });
      queryClient.setQueriesData<ShoppingItem[]>({ queryKey: key }, (old) =>
        old?.map((i) => (i.cart_item_id === item.cart_item_id ? { ...i, purchased: !i.purchased } : i)),
      );
      return { previous };
    },
    onError: (err: any, _item, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
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
      const previous = queryClient.getQueriesData<ShoppingItem[]>({ queryKey: key });
      queryClient.setQueriesData<ShoppingItem[]>({ queryKey: key }, (old) =>
        old?.filter((i) => i.cart_item_id !== cartItemId),
      );
      return { previous };
    },
    onError: (err: any, _id, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
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

    // If no product selected, create a placeholder (name-only, no barcode).
    // New columns default to false / null — user can refine via Settings or
    // the AI matcher on next scan.
    if (!productId) {
      const { data: newProduct, error: createErr } = await chefbyte()
        .from('products')
        .insert({
          user_id: user.id,
          name: searchText.trim(),
          is_placeholder: true,
          is_distinct_unit_item: false,
          default_recipe_unit: null,
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

    // Look up ANY existing shopping_list row for this product — active or
    // imported. The UNIQUE(user_id, product_id) constraint means we must
    // update in place rather than insert a duplicate. If it's an imported
    // row, re-activate it by clearing imported_at and resetting qty to the
    // new addQty (the prior qty has already left the cart via import).
    const { data: anyExisting } = await chefbyte()
      .from('shopping_list')
      .select('cart_item_id, qty_containers, imported_at, purchased')
      .eq('user_id', user.id)
      .eq('product_id', productId)
      .limit(1)
      .maybeSingle();

    if (anyExisting) {
      const wasImported = !!(anyExisting as any).imported_at;
      const newQty = wasImported ? addQty : Number((anyExisting as any).qty_containers) + addQty;
      const { error: updateErr } = await chefbyte()
        .from('shopping_list')
        .update({
          qty_containers: newQty,
          imported_at: null,
          purchased: wasImported ? false : (anyExisting as any).purchased,
        })
        .eq('cart_item_id', (anyExisting as any).cart_item_id);
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

    // Single-call RPC handles location resolution, stock_lot merge/insert,
    // and imported_at stamping atomically. Prevents double-imports and
    // orphaned stock_lots if a step mid-batch fails.
    const importedCount = purchased.length;
    const { data: importResult, error: rpcErr } = await (chefbyte() as any).rpc('import_shopping_to_inventory', {
      p_location_id: null,
    });
    if (rpcErr) {
      setError(rpcErr.message);
      toast.show(`Import failed: ${rpcErr.message}`, { variant: 'error' });
      return;
    }
    // Audit FLAGS #31: surface success feedback. The RPC returns
    // { lots_processed, ... } — we prefer that count when present, fall
    // back to the local purchased[] length (since the cache may have
    // re-fetched between click and response).
    const lotsProcessed =
      typeof importResult?.lots_processed === 'number' ? Number(importResult.lots_processed) : importedCount;
    toast.show(`Imported ${lotsProcessed} item${lotsProcessed === 1 ? '' : 's'} to inventory.`, {
      variant: 'success',
    });

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

    // R2 audit #11: also load the existing shopping_list rows so we can
    // preserve `purchased=true` on any below-min-stock row already
    // checked off. The prior version unconditionally set purchased=false
    // which silently un-checked items the user had just toggled. We
    // still reset imported_at on conflict so an imported row revives in
    // place (UNIQUE(user_id, product_id) means there's only ever one).
    const { data: existing } = await chefbyte()
      .from('shopping_list')
      .select('product_id, purchased, imported_at')
      .eq('user_id', user.id);
    const existingByProduct = new Map<string, { purchased: boolean; imported: boolean }>();
    for (const row of (existing ?? []) as Array<{
      product_id: string;
      purchased: boolean;
      imported_at: string | null;
    }>) {
      existingByProduct.set(row.product_id, {
        purchased: !!row.purchased,
        imported: !!row.imported_at,
      });
    }

    const rowsToUpsert: Array<{
      user_id: string;
      product_id: string;
      qty_containers: number;
      imported_at: null;
      purchased: boolean;
    }> = [];
    for (const product of prods) {
      const currentStock = stockByProduct.get(product.product_id) ?? 0;
      const minStock = Number(product.min_stock_amount);
      if (currentStock < minStock) {
        const deficit = Math.ceil(minStock - currentStock);
        if (deficit > 0) {
          const prev = existingByProduct.get(product.product_id);
          // If the row was previously imported, the lot has already left
          // the cart — re-activating it as unpurchased is the correct
          // behavior. Otherwise preserve the user's purchased flag.
          const preservedPurchased = prev && !prev.imported ? prev.purchased : false;
          rowsToUpsert.push({
            user_id: user.id,
            product_id: product.product_id,
            qty_containers: deficit,
            imported_at: null,
            purchased: preservedPurchased,
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
        toast.show(`Auto-add failed: ${batchErr.message}`, { variant: 'error' });
        return;
      }
      toast.show(`Auto-added ${rowsToUpsert.length} item${rowsToUpsert.length === 1 ? '' : 's'} to To Buy.`, {
        variant: 'success',
      });
    } else {
      toast.show('Nothing below minimum stock — all caught up.', { variant: 'info' });
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

  /**
   * Clear all `purchased=true` non-imported rows in one shot. Distinct from
   * "Import to Inventory" (which moves them to stock_lots) — this is the
   * "I bought it but I don't want to track this lot" exit path. Optimistic
   * update prunes from cache immediately; failure rolls back.
   *
   * Safe to call when `purchased.length === 0` — early-returns. The
   * confirmation modal is gated on `purchased.length > 0` at the call site
   * so users never get an empty confirm.
   */
  const clearPurchased = async () => {
    if (!user || purchased.length === 0) return;
    setError(null);

    const purchasedIds = new Set(purchased.map((p) => p.cart_item_id));
    const key = queryKeys.shoppingList(user.id);
    // The actual query key includes a `{ showImported }` suffix so we use
    // setQueriesData to update both filtered/unfiltered cached views.
    const previous = queryClient.getQueriesData<ShoppingItem[]>({ queryKey: key });

    queryClient.setQueriesData<ShoppingItem[]>({ queryKey: key }, (old) =>
      (old ?? []).filter((i) => !purchasedIds.has(i.cart_item_id)),
    );

    const { error: delErr } = await chefbyte()
      .from('shopping_list')
      .delete()
      .eq('user_id', user.id)
      .eq('purchased', true)
      .is('imported_at', null);
    if (delErr) {
      // Rollback all cached views on failure
      previous.forEach(([k, data]) => queryClient.setQueryData(k, data));
      setError(delErr.message);
      toast.show(`Clear purchased failed: ${delErr.message}`, { variant: 'error' });
      return;
    }

    toast.show(`Cleared ${purchasedIds.size} purchased item${purchasedIds.size === 1 ? '' : 's'}.`, {
      variant: 'success',
    });
    invalidateShoppingList();
  };

  const handleClearPurchased = () => {
    if (purchased.length === 0) return;
    setConfirmState({
      open: true,
      title: 'Clear Purchased Items',
      message: `Remove all ${purchased.length} purchased item${
        purchased.length === 1 ? '' : 's'
      } from the shopping list? This does not import them to inventory.`,
      confirmLabel: 'Clear Purchased',
      action: () => {
        closeConfirm();
        clearPurchased();
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
          <h1 className="m-0 text-2xl font-bold text-text">Shopping List</h1>
          {/* R2 audit #7: surface Walmart quota counter when the cart has
             deeplinkable items. Lets the user see how much of today's
             100-call budget is left BEFORE clicking "Open in Walmart" or
             going to the Walmart tab to refresh prices. */}
          {hasWalmartDeeplinkable && walmartQuota && (
            <span
              data-testid="shopping-walmart-quota"
              className={[
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold border',
                walmartQuota.used >= walmartQuota.limit
                  ? 'bg-danger-subtle text-danger-text border-danger'
                  : 'bg-surface text-text-secondary border-border',
              ].join(' ')}
              title="Walmart searches used today (resets at midnight UTC)"
            >
              {walmartQuota.used} / {walmartQuota.limit} Walmart searches today
            </span>
          )}
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
                // Audit: native alert() broke the design system. Replaced
                // with the same ConfirmModal pattern used elsewhere on the
                // page so the message renders inside the app shell.
                setConfirmState({
                  open: true,
                  title: 'No Walmart Links',
                  message:
                    'None of the items in your To Buy list have a Walmart link yet. Add Walmart links from Settings → Walmart, then try again.',
                  confirmLabel: 'OK',
                  action: () => closeConfirm(),
                });
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

        {/* Auto-Add Below Min Stock CTA — re-ranked per audit.
           Previous version was a 64px-tall billboard with dashed border + giant
           icon, drowning out the daily action (toggle items as you walk aisles).
           Audit notes this is a once-a-week click; collapsed to a thin
           secondary button so the high-frequency cart actions own the visual
           hierarchy. */}
        <button
          onClick={autoAddBelowMinStock}
          data-testid="auto-add-btn"
          className="mb-5 inline-flex items-center gap-2 px-3 py-2 bg-surface border border-emerald-300 rounded-md cursor-pointer hover:bg-success-subtle transition-colors text-left text-sm"
        >
          <PackageSearch className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-semibold text-emerald-700">Auto-Add Below Min Stock</span>
        </button>

        {error && <div className="text-danger-text text-sm p-2">{error}</div>}

        {/* ============================================================ */}
        {/*  ADD ITEM FORM                                                */}
        {/* ============================================================ */}
        <div data-testid="add-item-form" className="bg-surface-sunken p-4 rounded-lg mb-5 flex gap-3 flex-wrap">
          <div className="flex-1 relative">
            <input
              type="text"
              placeholder="Item name"
              value={searchText}
              onChange={(e) => handleSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addItem()}
              data-testid="add-item-name"
              className="w-full px-3 py-2.5 border border-border-strong rounded-md text-sm box-border focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary"
            />
            {/* Autocomplete dropdown */}
            {showDropdown && (
              <div
                data-testid="product-dropdown"
                className="absolute top-full left-0 right-0 bg-surface border border-border-strong rounded z-10 max-h-[200px] overflow-auto shadow-md"
              >
                {searchResults.map((p) => (
                  <div
                    key={p.product_id}
                    onClick={() => selectProduct(p)}
                    data-testid={`dropdown-item-${p.product_id}`}
                    className="px-3 py-2 cursor-pointer hover:bg-surface-hover"
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
            className="w-[100px] px-3 py-2.5 border border-border-strong rounded-md text-sm"
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
        <div data-testid="to-buy-section" className="bg-surface border border-border rounded-lg p-4 mb-5">
          <h3 className="m-0 mb-3 text-base font-semibold">To Buy ({toBuy.length})</h3>
          {toBuy.length === 0 ? (
            <div data-testid="no-to-buy" className="text-center text-text-tertiary py-5">
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
                      justPurchased ? 'bg-success-subtle' : 'bg-surface-sunken',
                    ].join(' ')}
                  >
                    {/* 44x44 touch target wrapper around the visible 28px
                       checkbox — meets the 44px Apple/Material guideline for
                       phone-side use without changing the visual size of the
                       control. Audit flagged the prior 20px box as a thumb-
                       miss in noisy stores. */}
                    <label
                      htmlFor={`check-${item.cart_item_id}`}
                      className="relative flex items-center justify-center min-w-[44px] min-h-[44px] cursor-pointer"
                    >
                      <input
                        id={`check-${item.cart_item_id}`}
                        type="checkbox"
                        checked={item.purchased}
                        onChange={() => togglePurchased(item)}
                        aria-label={`Mark ${item.products?.name ?? 'Unknown Product'} as purchased`}
                        data-testid={`check-${item.cart_item_id}`}
                        className="cursor-pointer w-7 h-7 accent-green-600"
                      />
                      {justPurchased && (
                        <span className="absolute inset-0 flex items-center justify-center pointer-events-none animate-ping text-success-text text-sm">
                          &#10003;
                        </span>
                      )}
                    </label>
                    <div className="flex-1">
                      <strong>{item.products?.name ?? 'Unknown Product'}</strong>
                      <span className="ml-3 text-text-secondary">{formatQty(item.qty_containers)}</span>
                      {/* FLAGS: per-row Walmart price + computed line total
                         when product has both price + walmart_link. Falls
                         back silently if either is missing — keeps the
                         layout uncluttered for the placeholder/no-price
                         case. */}
                      {item.products?.price != null &&
                        item.products?.walmart_link &&
                        item.products.walmart_link !== 'NOT_ON_WALMART' && (
                          <span
                            data-testid={`walmart-price-${item.cart_item_id}`}
                            className="ml-3 text-xs text-text-tertiary tabular-nums"
                          >
                            ${Number(item.products.price).toFixed(2)} × {Math.ceil(Number(item.qty_containers))} = $
                            {(Number(item.products.price) * Math.ceil(Number(item.qty_containers))).toFixed(2)}
                          </span>
                        )}
                    </div>
                    <button
                      onClick={() => removeMutation.mutate(item.cart_item_id)}
                      data-testid={`remove-${item.cart_item_id}`}
                      className="px-3 py-1 bg-transparent text-text-secondary border border-border rounded cursor-pointer text-xs hover:bg-surface-hover"
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
        <div data-testid="purchased-section" className="bg-surface border border-border rounded-lg p-4 mb-5">
          <div className="flex justify-between items-center mb-3 gap-2 flex-wrap">
            <h3 className="m-0 text-base font-semibold text-text-secondary">Purchased ({purchased.length})</h3>
            {purchased.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleClearPurchased}
                  data-testid="clear-purchased-btn"
                  className="px-3 py-1.5 bg-transparent text-text-secondary border border-border rounded cursor-pointer text-[13px] font-semibold hover:bg-surface-hover"
                  title="Remove all purchased items from the shopping list (does NOT import to inventory)"
                >
                  Clear Purchased
                </button>
                <button
                  onClick={importToInventory}
                  data-testid="import-inventory-btn"
                  className="px-3 py-1.5 bg-green-600 text-white border-none rounded cursor-pointer text-[13px] font-semibold hover:bg-green-700"
                >
                  Import to Inventory
                </button>
              </div>
            )}
          </div>
          {purchased.length === 0 ? (
            <div data-testid="no-purchased" className="text-center text-text-tertiary py-5">
              No purchased items.
            </div>
          ) : (
            <div data-testid="purchased-list" className="flex flex-col gap-2">
              {purchased.map((item) => (
                <div
                  key={item.cart_item_id}
                  data-testid={`item-${item.cart_item_id}`}
                  className="flex items-center gap-3 p-2.5 bg-surface-hover rounded-md opacity-70"
                >
                  <label
                    htmlFor={`check-${item.cart_item_id}`}
                    className="flex items-center justify-center min-w-[44px] min-h-[44px] cursor-pointer"
                  >
                    <input
                      id={`check-${item.cart_item_id}`}
                      type="checkbox"
                      checked={true}
                      onChange={() => togglePurchased(item)}
                      aria-label={`Unmark ${item.products?.name ?? 'Unknown Product'} as purchased`}
                      data-testid={`check-${item.cart_item_id}`}
                      className="cursor-pointer w-7 h-7 accent-green-600"
                    />
                  </label>
                  <div className="flex-1 line-through text-text-secondary">
                    <strong>{item.products?.name ?? 'Unknown Product'}</strong>
                    <span className="ml-3">{formatQty(item.qty_containers)}</span>
                  </div>
                  <button
                    onClick={() => removeMutation.mutate(item.cart_item_id)}
                    data-testid={`remove-${item.cart_item_id}`}
                    className="px-3 py-1 bg-transparent text-text-secondary border border-border rounded cursor-pointer text-xs hover:bg-surface-hover"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/*  SHOW IMPORTED TOGGLE + SECTION                              */}
        {/* ============================================================ */}
        <div className="flex items-center gap-2 mb-3">
          <label className="inline-flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={showImported}
              onChange={(e) => setShowImported(e.target.checked)}
              data-testid="show-imported-toggle"
              className="cursor-pointer"
            />
            Show imported items (last 7 days)
          </label>
        </div>
        {showImported && (
          <div data-testid="imported-section" className="bg-surface border border-border rounded-lg p-4 mb-5">
            <h3 className="m-0 mb-3 text-base font-semibold text-text-secondary">Imported ({importedItems.length})</h3>
            {importedItems.length === 0 ? (
              <div data-testid="no-imported" className="text-center text-text-tertiary py-5">
                No items imported in the last 7 days.
              </div>
            ) : (
              <div data-testid="imported-list" className="flex flex-col gap-2">
                {importedItems.map((item) => (
                  <div
                    key={item.cart_item_id}
                    data-testid={`imported-item-${item.cart_item_id}`}
                    className="flex items-center gap-3 p-2.5 bg-surface-hover rounded-md opacity-70"
                  >
                    <div className="flex-1 line-through text-text-secondary">
                      <strong>{item.products?.name ?? 'Unknown Product'}</strong>
                      <span className="ml-3">{formatQty(item.qty_containers)}</span>
                      <span
                        data-testid={`imported-badge-${item.cart_item_id}`}
                        className="ml-3 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-success-subtle text-success-text border border-emerald-200"
                      >
                        Imported
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
