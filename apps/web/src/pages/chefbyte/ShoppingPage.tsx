import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte, supabase, escapeIlike } from '@/shared/supabase';

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
  products: { name: string; barcode: string | null; price: number | null } | null;
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
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ShoppingItem[]>([]);

  const [error, setError] = useState<string | null>(null);

  /* ---- Add item form state ---- */
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<ProductSearchResult[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [addQty, setAddQty] = useState(1);
  const [showDropdown, setShowDropdown] = useState(false);

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadItems = useCallback(async () => {
    if (!user) return;
    const { data } = await chefbyte()
      .from('shopping_list')
      .select('*, products:product_id(name, barcode, price)')
      .eq('user_id', user.id)
      .order('created_at');
    setItems((data ?? []) as ShoppingItem[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    // Async data fetching with setState is the standard pattern for this use case
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadItems();
  }, [loadItems]);

  /* ---------------------------------------------------------------- */
  /*  Realtime subscriptions                                           */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('shopping-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'chefbyte',
          table: 'shopping_list',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          loadItems();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

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
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

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
    await loadItems();
  };

  const togglePurchased = async (item: ShoppingItem) => {
    setError(null);
    const { error: updateErr } = await chefbyte()
      .from('shopping_list')
      .update({ purchased: !item.purchased })
      .eq('cart_item_id', item.cart_item_id);
    if (updateErr) {
      setError(updateErr.message);
      return;
    }
    await loadItems();
  };

  const removeItem = async (cartItemId: string) => {
    setError(null);
    const { error: deleteErr } = await chefbyte().from('shopping_list').delete().eq('cart_item_id', cartItemId);
    if (deleteErr) {
      setError(deleteErr.message);
      return;
    }
    await loadItems();
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
    const locationId = locs?.[0]?.location_id;
    if (!locationId) return;

    // Batch insert stock lots for all purchased items
    const stockRows = purchased.map((item) => ({
      user_id: user.id,
      product_id: item.product_id,
      location_id: locationId,
      qty_containers: item.qty_containers,
      expires_on: null,
    }));
    const { error: stockErr } = await chefbyte().from('stock_lots').insert(stockRows);
    if (stockErr) {
      setError(stockErr.message);
      return;
    }

    // Delete purchased items from shopping list
    const ids = purchased.map((i) => i.cart_item_id);
    const { error: delErr } = await chefbyte().from('shopping_list').delete().in('cart_item_id', ids);
    if (delErr) {
      setError(delErr.message);
      return;
    }

    await loadItems();
  };

  const autoAddBelowMinStock = async () => {
    if (!user) return;
    setError(null);

    // Get all products with min_stock_amount
    const { data: products } = await chefbyte()
      .from('products')
      .select('product_id, name, min_stock_amount')
      .eq('user_id', user.id)
      .not('name', 'ilike', '[MEAL]%')
      .gt('min_stock_amount', 0);

    if (!products || products.length === 0) return;

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

    // Fetch fresh shopping list to avoid stale-state duplicates
    const { data: freshShoppingItems } = await chefbyte()
      .from('shopping_list')
      .select('product_id, qty_containers')
      .eq('user_id', user.id);

    // Sum already-listed quantities per product
    const listedByProduct = new Map<string, number>();
    for (const si of freshShoppingItems ?? []) {
      const current = listedByProduct.get(si.product_id) ?? 0;
      listedByProduct.set(si.product_id, current + Number(si.qty_containers));
    }

    // Collect deficient products, subtracting already-listed qty
    const rowsToInsert: Array<{ user_id: string; product_id: string; qty_containers: number }> = [];
    for (const product of products) {
      const currentStock = stockByProduct.get(product.product_id) ?? 0;
      const minStock = Number(product.min_stock_amount);
      if (currentStock < minStock) {
        const deficit = minStock - currentStock;
        const alreadyListed = listedByProduct.get(product.product_id) ?? 0;
        const qtyNeeded = Math.ceil(deficit - alreadyListed);
        if (qtyNeeded > 0) {
          rowsToInsert.push({
            user_id: user.id,
            product_id: product.product_id,
            qty_containers: qtyNeeded,
          });
        }
      }
    }
    if (rowsToInsert.length > 0) {
      const { error: batchErr } = await chefbyte().from('shopping_list').insert(rowsToInsert);
      if (batchErr) {
        setError(batchErr.message);
        return;
      }
    }

    await loadItems();
  };

  const clearAll = async () => {
    if (!user || items.length === 0) return;
    setError(null);
    const { error: delErr } = await chefbyte().from('shopping_list').delete().eq('user_id', user.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadItems();
  };

  const handleClearAll = () => {
    if (window.confirm('Are you sure you want to remove all items from the shopping list?')) {
      clearAll();
    }
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

  if (loading) {
    return (
      <ChefLayout title="Shopping">
        <div style={{ padding: '20px' }} data-testid="shopping-loading">
          Loading shopping list...
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Shopping">
      <div style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1 style={{ margin: 0 }}>Shopping List</h1>
          <button
            onClick={autoAddBelowMinStock}
            data-testid="auto-add-btn"
            style={{
              padding: '10px 16px',
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 600,
            }}
          >
            Auto-Add Below Min Stock
          </button>
        </div>

        {error && <div style={{ color: '#d33', fontSize: '14px', padding: '8px' }}>{error}</div>}

        {/* ============================================================ */}
        {/*  ADD ITEM FORM                                                */}
        {/* ============================================================ */}
        <div
          data-testid="add-item-form"
          style={{
            background: '#f7f7f9',
            padding: '16px',
            borderRadius: '8px',
            marginBottom: '20px',
            display: 'flex',
            gap: '12px',
          }}
        >
          <div style={{ flex: 1, position: 'relative' }}>
            <input
              type="text"
              placeholder="Item name"
              value={searchText}
              onChange={(e) => handleSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addItem()}
              data-testid="add-item-name"
              style={{
                width: '100%',
                padding: '10px',
                border: '1px solid #ddd',
                borderRadius: '6px',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
            {/* Autocomplete dropdown */}
            {showDropdown && (
              <div
                data-testid="product-dropdown"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  background: '#fff',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  zIndex: 10,
                  maxHeight: '200px',
                  overflow: 'auto',
                }}
              >
                {searchResults.map((p) => (
                  <div
                    key={p.product_id}
                    onClick={() => selectProduct(p)}
                    data-testid={`dropdown-item-${p.product_id}`}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                    }}
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
            style={{
              width: '100px',
              padding: '10px',
              border: '1px solid #ddd',
              borderRadius: '6px',
              fontSize: '14px',
            }}
          />
          <button
            onClick={addItem}
            disabled={!searchText.trim()}
            data-testid="add-item-btn"
            style={{
              padding: '10px 20px',
              background: '#1e66f5',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Add
          </button>
        </div>

        {/* ============================================================ */}
        {/*  TO BUY SECTION                                               */}
        {/* ============================================================ */}
        <div
          data-testid="to-buy-section"
          style={{
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '16px',
            marginBottom: '20px',
          }}
        >
          <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: 600 }}>To Buy ({toBuy.length})</h3>
          {toBuy.length === 0 ? (
            <div data-testid="no-to-buy" style={{ textAlign: 'center', color: '#999', padding: '20px' }}>
              No items to buy.
            </div>
          ) : (
            <div data-testid="to-buy-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {toBuy.map((item) => (
                <div
                  key={item.cart_item_id}
                  data-testid={`item-${item.cart_item_id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px',
                    background: '#f7f7f9',
                    borderRadius: '6px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={item.purchased}
                    onChange={() => togglePurchased(item)}
                    aria-label={`Mark ${item.products?.name ?? 'Unknown Product'} as purchased`}
                    data-testid={`check-${item.cart_item_id}`}
                    style={{ cursor: 'pointer', width: '18px', height: '18px' }}
                  />
                  <div style={{ flex: 1 }}>
                    <strong>{item.products?.name ?? 'Unknown Product'}</strong>
                    <span style={{ marginLeft: '12px', color: '#666' }}>{formatQty(item.qty_containers)}</span>
                  </div>
                  <button
                    onClick={() => removeItem(item.cart_item_id)}
                    data-testid={`remove-${item.cart_item_id}`}
                    style={{
                      padding: '4px 12px',
                      background: 'transparent',
                      color: '#888',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ============================================================ */}
        {/*  PURCHASED SECTION                                            */}
        {/* ============================================================ */}
        <div
          data-testid="purchased-section"
          style={{
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '16px',
            marginBottom: '20px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#666' }}>
              Purchased ({purchased.length})
            </h3>
            {purchased.length > 0 && (
              <button
                onClick={importToInventory}
                data-testid="import-inventory-btn"
                style={{
                  padding: '6px 12px',
                  background: '#2f9e44',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 600,
                }}
              >
                Import to Inventory
              </button>
            )}
          </div>
          {purchased.length === 0 ? (
            <div data-testid="no-purchased" style={{ textAlign: 'center', color: '#999', padding: '20px' }}>
              No purchased items.
            </div>
          ) : (
            <div data-testid="purchased-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {purchased.map((item) => (
                <div
                  key={item.cart_item_id}
                  data-testid={`item-${item.cart_item_id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px',
                    background: '#f0f0f0',
                    borderRadius: '6px',
                    opacity: 0.7,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={() => togglePurchased(item)}
                    aria-label={`Unmark ${item.products?.name ?? 'Unknown Product'} as purchased`}
                    data-testid={`check-${item.cart_item_id}`}
                    style={{ cursor: 'pointer', width: '18px', height: '18px' }}
                  />
                  <div style={{ flex: 1, textDecoration: 'line-through', color: '#666' }}>
                    <strong>{item.products?.name ?? 'Unknown Product'}</strong>
                    <span style={{ marginLeft: '12px' }}>{formatQty(item.qty_containers)}</span>
                  </div>
                  <button
                    onClick={() => removeItem(item.cart_item_id)}
                    data-testid={`remove-${item.cart_item_id}`}
                    style={{
                      padding: '4px 12px',
                      background: 'transparent',
                      color: '#888',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                    }}
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
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={handleClearAll}
            disabled={items.length === 0}
            data-testid="clear-all-btn"
            style={{
              padding: '10px 16px',
              background: '#d33',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: items.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              fontWeight: 600,
              opacity: items.length === 0 ? 0.5 : 1,
            }}
          >
            Clear All
          </button>
        </div>
      </div>
    </ChefLayout>
  );
}
