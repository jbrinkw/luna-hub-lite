import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonButton,
  IonInput,
  IonCheckbox,
  IonList,
} from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

// Cast needed: chefbyte schema types not yet generated
const chefbyte = () => supabase.schema('chefbyte') as any;

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
    loadItems();
  }, [loadItems]);

  /* ---------------------------------------------------------------- */
  /*  Derived state                                                    */
  /* ---------------------------------------------------------------- */

  const toBuy = useMemo(() => items.filter(i => !i.purchased), [items]);
  const purchased = useMemo(() => items.filter(i => i.purchased), [items]);

  /* ---------------------------------------------------------------- */
  /*  Product search                                                   */
  /* ---------------------------------------------------------------- */

  const searchProducts = useCallback(async (text: string) => {
    if (!user || text.trim().length < 1) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    const { data } = await chefbyte()
      .from('products')
      .select('product_id, name')
      .eq('user_id', user.id)
      .order('name');
    // Client-side filter since ilike may not work with schema cast
    const filtered = ((data ?? []) as ProductSearchResult[]).filter(p =>
      p.name.toLowerCase().includes(text.toLowerCase()),
    );
    setSearchResults(filtered);
    setShowDropdown(filtered.length > 0);
  }, [user]);

  const handleSearchInput = (value: string) => {
    setSearchText(value);
    setSelectedProductId(null);
    searchProducts(value);
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

    let productId = selectedProductId;

    // If no product selected, create a placeholder
    if (!productId) {
      const { data: newProduct } = await chefbyte()
        .from('products')
        .insert({
          user_id: user.id,
          name: searchText.trim(),
          is_placeholder: true,
        })
        .select('product_id')
        .single();
      productId = newProduct?.product_id;
    }

    if (!productId) return;

    await chefbyte().from('shopping_list').insert({
      user_id: user.id,
      product_id: productId,
      qty_containers: addQty,
    });

    setSearchText('');
    setSelectedProductId(null);
    setAddQty(1);
    await loadItems();
  };

  const togglePurchased = async (item: ShoppingItem) => {
    await chefbyte()
      .from('shopping_list')
      .update({ purchased: !item.purchased })
      .eq('cart_item_id', item.cart_item_id);
    await loadItems();
  };

  const removeItem = async (cartItemId: string) => {
    await chefbyte()
      .from('shopping_list')
      .delete()
      .eq('cart_item_id', cartItemId);
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

    // Insert stock lots for each purchased item
    for (const item of purchased) {
      await chefbyte().from('stock_lots').insert({
        user_id: user.id,
        product_id: item.product_id,
        location_id: locationId,
        qty_containers: item.qty_containers,
        expires_on: null,
      });
    }

    // Delete purchased items from shopping list
    const ids = purchased.map(i => i.cart_item_id);
    await chefbyte().from('shopping_list').delete().in('cart_item_id', ids);

    await loadItems();
  };

  const autoAddBelowMinStock = async () => {
    if (!user) return;

    // Get all products with min_stock_amount
    const { data: products } = await chefbyte()
      .from('products')
      .select('product_id, name, min_stock_amount')
      .eq('user_id', user.id)
      .gt('min_stock_amount', 0);

    if (!products || products.length === 0) return;

    // Get all stock lots to calculate current stock
    const { data: stockLots } = await chefbyte()
      .from('stock_lots')
      .select('product_id, qty_containers')
      .eq('user_id', user.id);

    // Calculate current stock per product
    const stockByProduct = new Map<string, number>();
    for (const lot of (stockLots ?? [])) {
      const current = stockByProduct.get(lot.product_id) ?? 0;
      stockByProduct.set(lot.product_id, current + Number(lot.qty_containers));
    }

    // Find products already on the shopping list
    const existingProductIds = new Set(items.map(i => i.product_id));

    // Insert deficient products
    for (const product of products) {
      if (existingProductIds.has(product.product_id)) continue;
      const currentStock = stockByProduct.get(product.product_id) ?? 0;
      const minStock = Number(product.min_stock_amount);
      if (currentStock < minStock) {
        const qtyNeeded = Math.ceil(minStock - currentStock);
        await chefbyte().from('shopping_list').insert({
          user_id: user.id,
          product_id: product.product_id,
          qty_containers: qtyNeeded,
        });
      }
    }

    await loadItems();
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
        <IonSpinner data-testid="shopping-loading" />
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Shopping">
      <h2>SHOPPING LIST</h2>

      {/* ============================================================ */}
      {/*  ADD ITEM FORM                                                */}
      {/* ============================================================ */}
      <IonCard data-testid="add-item-form">
        <IonCardHeader>
          <IonCardTitle>Add Item</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', position: 'relative' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <IonInput
                label="Item name"
                value={searchText}
                onIonInput={e => handleSearchInput(e.detail.value ?? '')}
                data-testid="add-item-name"
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
                  {searchResults.map(p => (
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
            <div style={{ width: '80px' }}>
              <IonInput
                label="Qty"
                type="number"
                value={addQty}
                onIonInput={e => setAddQty(Number(e.detail.value) || 1)}
                data-testid="add-item-qty"
              />
            </div>
            <IonButton
              onClick={addItem}
              disabled={!searchText.trim()}
              data-testid="add-item-btn"
            >
              Add
            </IonButton>
          </div>
        </IonCardContent>
      </IonCard>

      {/* ============================================================ */}
      {/*  AUTO-ADD BUTTON                                              */}
      {/* ============================================================ */}
      <div style={{ margin: '12px 0' }}>
        <IonButton
          expand="block"
          fill="outline"
          onClick={autoAddBelowMinStock}
          data-testid="auto-add-btn"
        >
          Auto-Add Below Min Stock
        </IonButton>
      </div>

      {/* ============================================================ */}
      {/*  TO BUY SECTION                                               */}
      {/* ============================================================ */}
      <IonCard data-testid="to-buy-section">
        <IonCardHeader>
          <IonCardTitle>To Buy ({toBuy.length})</IonCardTitle>
        </IonCardHeader>
        <IonCardContent>
          {toBuy.length === 0 ? (
            <p data-testid="no-to-buy">No items to buy.</p>
          ) : (
            <IonList data-testid="to-buy-list">
              {toBuy.map(item => (
                <div
                  key={item.cart_item_id}
                  data-testid={`item-${item.cart_item_id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '8px 0',
                    borderBottom: '1px solid #eee',
                  }}
                >
                  <IonCheckbox
                    checked={item.purchased}
                    onIonChange={() => togglePurchased(item)}
                    data-testid={`check-${item.cart_item_id}`}
                  />
                  <span style={{ flex: 1 }}>
                    {item.products?.name ?? 'Unknown Product'}
                  </span>
                  <span style={{ color: '#666', fontSize: '0.9em' }}>
                    {formatQty(item.qty_containers)}
                  </span>
                  <IonButton
                    size="small"
                    color="danger"
                    fill="clear"
                    onClick={() => removeItem(item.cart_item_id)}
                    data-testid={`remove-${item.cart_item_id}`}
                  >
                    Remove
                  </IonButton>
                </div>
              ))}
            </IonList>
          )}
        </IonCardContent>
      </IonCard>

      {/* ============================================================ */}
      {/*  PURCHASED SECTION                                            */}
      {/* ============================================================ */}
      <IonCard data-testid="purchased-section">
        <IonCardHeader>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <IonCardTitle>Purchased ({purchased.length})</IonCardTitle>
            {purchased.length > 0 && (
              <IonButton
                size="small"
                onClick={importToInventory}
                data-testid="import-inventory-btn"
              >
                Import to Inventory
              </IonButton>
            )}
          </div>
        </IonCardHeader>
        <IonCardContent>
          {purchased.length === 0 ? (
            <p data-testid="no-purchased">No purchased items.</p>
          ) : (
            <IonList data-testid="purchased-list">
              {purchased.map(item => (
                <div
                  key={item.cart_item_id}
                  data-testid={`item-${item.cart_item_id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '8px 0',
                    borderBottom: '1px solid #eee',
                  }}
                >
                  <IonCheckbox
                    checked={true}
                    onIonChange={() => togglePurchased(item)}
                    data-testid={`check-${item.cart_item_id}`}
                  />
                  <span style={{ flex: 1, textDecoration: 'line-through', color: '#888' }}>
                    {item.products?.name ?? 'Unknown Product'}
                  </span>
                  <span style={{ color: '#999', fontSize: '0.9em' }}>
                    {formatQty(item.qty_containers)}
                  </span>
                  <IonButton
                    size="small"
                    color="danger"
                    fill="clear"
                    onClick={() => removeItem(item.cart_item_id)}
                    data-testid={`remove-${item.cart_item_id}`}
                  >
                    Remove
                  </IonButton>
                </div>
              ))}
            </IonList>
          )}
        </IonCardContent>
      </IonCard>
    </ChefLayout>
  );
}
