import { useEffect, useState, useCallback } from 'react';
import { IonSpinner, IonButton, IonInput } from '@ionic/react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase } from '@/shared/supabase';

const chefbyte = () => supabase.schema('chefbyte') as any;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MissingLinkProduct {
  product_id: string;
  name: string;
  barcode: string | null;
  notOnWalmart: boolean;
}

interface MissingPriceProduct {
  product_id: string;
  name: string;
  walmart_link: string | null;
  price: number | null;
}

/* ================================================================== */
/*  WalmartPage                                                        */
/* ================================================================== */

export function WalmartPage() {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [missingLinks, setMissingLinks] = useState<MissingLinkProduct[]>([]);
  const [missingPrices, setMissingPrices] = useState<MissingPriceProduct[]>([]);
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadData = useCallback(async () => {
    if (!userId) return;

    // 1. Missing Walmart Links: products where walmart_link IS NULL and is_placeholder=false
    const { data: noLinks } = await chefbyte()
      .from('products')
      .select('product_id, name, barcode')
      .eq('user_id', userId)
      .eq('is_placeholder', false)
      .is('walmart_link', null);

    setMissingLinks(
      ((noLinks ?? []) as any[]).map(p => ({
        product_id: p.product_id,
        name: p.name,
        barcode: p.barcode,
        notOnWalmart: false,
      })),
    );

    // 2. Missing Prices: products where walmart_link IS NOT NULL and price IS NULL
    const { data: noPrices } = await chefbyte()
      .from('products')
      .select('product_id, name, walmart_link, price')
      .eq('user_id', userId)
      .is('price', null)
      .neq('walmart_link', null);

    setMissingPrices((noPrices ?? []) as MissingPriceProduct[]);

    // Initialize price inputs
    const inputs: Record<string, string> = {};
    for (const p of (noPrices ?? []) as MissingPriceProduct[]) {
      inputs[p.product_id] = p.price != null ? String(p.price) : '';
    }
    setPriceInputs(inputs);

    setLoading(false);
  }, [userId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const markNotOnWalmart = async (productId: string) => {
    if (!user) return;
    await chefbyte()
      .from('products')
      .update({ walmart_link: 'NOT_ON_WALMART' })
      .eq('product_id', productId);
    await loadData();
  };

  const savePrice = async (productId: string) => {
    if (!user) return;
    const price = parseFloat(priceInputs[productId] ?? '');
    if (isNaN(price)) return;
    await chefbyte()
      .from('products')
      .update({ price })
      .eq('product_id', productId);
    await loadData();
  };

  const refreshAllPrices = async () => {
    // STUBBED — walmart-scrape Edge Function not yet available (Phase 8)
    // TODO: Call walmart-scrape for all linked products
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Walmart">
        <IonSpinner data-testid="walmart-loading" />
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Walmart">
      <h2>WALMART PRICE MANAGER</h2>

      {/* ============================================================ */}
      {/*  MISSING WALMART LINKS                                        */}
      {/* ============================================================ */}
      <div data-testid="missing-links-section" style={{ marginBottom: '24px' }}>
        <h3>Missing Walmart Links ({missingLinks.length})</h3>

        {missingLinks.length === 0 ? (
          <p data-testid="no-missing-links" style={{ color: '#666', fontStyle: 'italic' }}>
            All products have Walmart links
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {missingLinks.map(product => (
              <div
                key={product.product_id}
                data-testid={`link-item-${product.product_id}`}
                style={{
                  padding: '12px',
                  border: '1px solid #eee',
                  borderRadius: '6px',
                  background: '#f7f7f9',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontWeight: 600 }}>{product.name}</span>
                  {product.barcode && (
                    <span style={{ fontSize: '0.8em', color: '#666' }}>({product.barcode})</span>
                  )}
                </div>
                <div style={{ padding: '12px', background: '#fff', borderRadius: '4px', marginBottom: '8px', color: '#666', fontStyle: 'italic' }}>
                  Search results will appear when Walmart integration is enabled
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <IonButton
                    size="small"
                    fill="outline"
                    disabled
                    data-testid={`link-selected-${product.product_id}`}
                  >
                    Link Selected
                  </IonButton>
                  <IonButton
                    size="small"
                    color="medium"
                    onClick={() => markNotOnWalmart(product.product_id)}
                    data-testid={`not-on-walmart-${product.product_id}`}
                  >
                    Not on Walmart
                  </IonButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/*  MISSING PRICES                                               */}
      {/* ============================================================ */}
      <div data-testid="missing-prices-section" style={{ marginBottom: '24px' }}>
        <h3>Missing Prices ({missingPrices.length})</h3>

        {missingPrices.length === 0 ? (
          <p data-testid="no-missing-prices" style={{ color: '#666', fontStyle: 'italic' }}>
            All linked products have prices
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {missingPrices.map(product => (
              <div
                key={product.product_id}
                data-testid={`price-item-${product.product_id}`}
                style={{
                  padding: '12px',
                  border: '1px solid #eee',
                  borderRadius: '6px',
                  background: '#f7f7f9',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                <span style={{ fontWeight: 600, flex: 1 }}>{product.name}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>$</span>
                  <IonInput
                    type="number"
                    value={priceInputs[product.product_id] ?? ''}
                    onIonInput={e => {
                      setPriceInputs(prev => ({
                        ...prev,
                        [product.product_id]: e.detail.value ?? '',
                      }));
                    }}
                    style={{ width: '100px' }}
                    data-testid={`price-input-${product.product_id}`}
                  />
                  <IonButton
                    size="small"
                    onClick={() => savePrice(product.product_id)}
                    data-testid={`save-price-${product.product_id}`}
                  >
                    Save Price
                  </IonButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/*  REFRESH ALL PRICES                                           */}
      {/* ============================================================ */}
      <IonButton
        data-testid="refresh-all-btn"
        onClick={refreshAllPrices}
      >
        Refresh All Prices
      </IonButton>
      <p style={{ fontSize: '0.8em', color: '#666', marginTop: '4px' }}>
        (Walmart scraping will be enabled in a future update)
      </p>
    </ChefLayout>
  );
}
