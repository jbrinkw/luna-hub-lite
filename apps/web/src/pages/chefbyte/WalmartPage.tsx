import { useEffect, useState, useCallback } from 'react';
import { ChefLayout } from '@/components/chefbyte/ChefLayout';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase, chefbyte } from '@/shared/supabase';

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

/* ------------------------------------------------------------------ */
/*  Shared styles                                                      */
/* ------------------------------------------------------------------ */

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '14px',
  boxSizing: 'border-box',
};

const cardStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: '8px',
  padding: '16px',
  marginBottom: '16px',
  background: '#fff',
};

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
      ((noLinks ?? []) as any[]).map((p) => ({
        product_id: p.product_id,
        name: p.name,
        barcode: p.barcode,
        notOnWalmart: false,
      })),
    );

    // 2. Missing Prices: products with NO walmart_link that need manual price entry
    const { data: noPrices } = await chefbyte()
      .from('products')
      .select('product_id, name, walmart_link, price')
      .eq('user_id', userId)
      .is('price', null)
      .is('walmart_link', null);

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
    // Async data fetching with setState is the standard pattern for this use case

    loadData();
  }, [loadData]);

  const [error, setError] = useState<string | null>(null);

  /* ---- Per-product Walmart URL inputs ---- */
  const [urlInputs, setUrlInputs] = useState<Record<string, string>>({});

  /* ---------------------------------------------------------------- */
  /*  Refresh All Prices                                               */
  /* ---------------------------------------------------------------- */

  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState('');

  const refreshAllPrices = async () => {
    if (!userId) return;
    setRefreshing(true);
    setError(null);

    try {
      // Fetch all products with a walmart_link (excluding NOT_ON_WALMART sentinel)
      const { data: products } = await chefbyte()
        .from('products')
        .select('product_id, name, walmart_link')
        .eq('user_id', userId)
        .not('walmart_link', 'is', null)
        .neq('walmart_link', 'NOT_ON_WALMART');

      const toRefresh = (products ?? []) as Array<{
        product_id: string;
        name: string;
        walmart_link: string;
      }>;

      if (toRefresh.length === 0) {
        setRefreshing(false);
        return;
      }

      let done = 0;
      for (const p of toRefresh) {
        setRefreshProgress(`${done + 1}/${toRefresh.length}`);

        const { data, error: fnError } = await supabase.functions.invoke('walmart-scrape', {
          body: { search_term: p.name },
        });

        if (!fnError && data?.results?.length > 0) {
          // Try to find a result matching the stored walmart_link
          const match = data.results.find(
            (r: { url: string }) =>
              r.url && p.walmart_link && r.url.replace(/\?.*$/, '') === p.walmart_link.replace(/\?.*$/, ''),
          );
          const price = match?.price ?? data.results[0]?.price;

          if (price != null) {
            await chefbyte().from('products').update({ price }).eq('product_id', p.product_id).eq('user_id', userId);
          }
        }
        done++;
      }

      await loadData();
    } catch {
      setError('Failed to refresh prices');
    } finally {
      setRefreshing(false);
      setRefreshProgress('');
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  const markNotOnWalmart = async (productId: string) => {
    if (!user) return;
    setError(null);
    const { error: err } = await chefbyte()
      .from('products')
      .update({ walmart_link: 'NOT_ON_WALMART' })
      .eq('product_id', productId)
      .eq('user_id', user.id);
    if (err) {
      setError(err.message);
      return;
    }
    await loadData();
  };

  const savePrice = async (productId: string) => {
    if (!user) return;
    setError(null);
    const price = parseFloat(priceInputs[productId] ?? '');
    if (isNaN(price)) return;
    const { error: err } = await chefbyte()
      .from('products')
      .update({ price })
      .eq('product_id', productId)
      .eq('user_id', user.id);
    if (err) {
      setError(err.message);
      return;
    }
    await loadData();
  };

  /* ---------------------------------------------------------------- */
  /*  Save custom Walmart URL                                          */
  /* ---------------------------------------------------------------- */

  const cleanWalmartUrl = (raw: string): string => {
    // Strip query params and hash, normalize
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      // If not a valid URL, return as-is (trimmed)
      return raw.trim();
    }
  };

  const saveWalmartUrl = async (productId: string) => {
    if (!user) return;
    setError(null);
    const raw = (urlInputs[productId] ?? '').trim();
    if (!raw) return;

    const cleaned = cleanWalmartUrl(raw);
    const { error: err } = await chefbyte()
      .from('products')
      .update({ walmart_link: cleaned })
      .eq('product_id', productId)
      .eq('user_id', user.id);
    if (err) {
      setError(err.message);
      return;
    }
    setUrlInputs((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
    await loadData();
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <ChefLayout title="Walmart">
        <div data-testid="walmart-loading" style={{ padding: '20px', color: '#666' }}>
          Loading...
        </div>
      </ChefLayout>
    );
  }

  return (
    <ChefLayout title="Walmart">
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 700, color: '#1a1a2e' }}>Walmart Price Manager</h1>
        <p style={{ margin: '8px 0 0', color: '#666', fontSize: '14px' }}>
          Link products to Walmart and manage pricing
        </p>
      </div>

      {error && (
        <p
          style={{
            color: '#d33',
            background: '#fef2f2',
            padding: '10px 14px',
            borderRadius: '6px',
            border: '1px solid #fecaca',
            marginBottom: '16px',
          }}
        >
          {error}
        </p>
      )}

      {/* ============================================================ */}
      {/*  MISSING WALMART LINKS                                        */}
      {/* ============================================================ */}
      <div className="cb-card" style={{ padding: '20px', marginBottom: '24px' }}>
        <div data-testid="missing-links-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>
              Missing Walmart Links ({missingLinks.length})
            </h2>
          </div>

          {missingLinks.length === 0 ? (
            <p
              data-testid="no-missing-links"
              style={{ color: '#666', fontStyle: 'italic', padding: '20px 0', textAlign: 'center' }}
            >
              All products have Walmart links
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {missingLinks.map((product) => (
                <div key={product.product_id} data-testid={`link-item-${product.product_id}`} style={cardStyle}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '12px',
                      flexWrap: 'wrap',
                      gap: '8px',
                    }}
                  >
                    <span style={{ flex: 1, fontWeight: 600, fontSize: '16px' }}>{product.name}</span>
                    {product.barcode && <span style={{ fontSize: '13px', color: '#666' }}>({product.barcode})</span>}
                    <a
                      href={`https://www.walmart.com/search?q=${encodeURIComponent(product.name)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#1976d2', textDecoration: 'none', fontSize: '14px' }}
                    >
                      Search Walmart
                    </a>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: '8px',
                      alignItems: 'center',
                      marginBottom: '8px',
                    }}
                  >
                    <input
                      placeholder="Paste Walmart URL..."
                      value={urlInputs[product.product_id] ?? ''}
                      onChange={(e) =>
                        setUrlInputs((prev) => ({
                          ...prev,
                          [product.product_id]: e.target.value,
                        }))
                      }
                      style={{ ...inputStyle, flex: 1 }}
                      data-testid={`url-input-${product.product_id}`}
                    />
                    <button
                      className="cb-primary-btn"
                      onClick={() => saveWalmartUrl(product.product_id)}
                      disabled={!(urlInputs[product.product_id] ?? '').trim()}
                      data-testid={`save-url-${product.product_id}`}
                      style={{ background: '#1e66f5', whiteSpace: 'nowrap' }}
                    >
                      Save URL
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="cb-primary-btn"
                      onClick={() => markNotOnWalmart(product.product_id)}
                      data-testid={`not-on-walmart-${product.product_id}`}
                      style={{ background: '#6b7280', fontSize: '13px', padding: '6px 12px' }}
                    >
                      Not on Walmart
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/*  MISSING PRICES                                               */}
      {/* ============================================================ */}
      <div className="cb-card" style={{ padding: '20px', marginBottom: '24px' }}>
        <div data-testid="missing-prices-section">
          <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 700 }}>
            Missing Prices ({missingPrices.length})
          </h2>

          {missingPrices.length === 0 ? (
            <p
              data-testid="no-missing-prices"
              style={{ color: '#666', fontStyle: 'italic', padding: '20px 0', textAlign: 'center' }}
            >
              All linked products have prices
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {missingPrices.map((product) => (
                <div
                  key={product.product_id}
                  data-testid={`price-item-${product.product_id}`}
                  style={{
                    ...cardStyle,
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr auto',
                    alignItems: 'center',
                    gap: '12px',
                    marginBottom: 0,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{product.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ color: '#666' }}>$</span>
                    <input
                      type="number"
                      min="0"
                      aria-label={`Price for ${product.name}`}
                      value={priceInputs[product.product_id] ?? ''}
                      onChange={(e) => {
                        setPriceInputs((prev) => ({
                          ...prev,
                          [product.product_id]: e.target.value,
                        }));
                      }}
                      style={{ ...inputStyle, width: '100px' }}
                      data-testid={`price-input-${product.product_id}`}
                      placeholder="0.00"
                    />
                  </div>
                  <button
                    className="cb-primary-btn"
                    onClick={() => savePrice(product.product_id)}
                    data-testid={`save-price-${product.product_id}`}
                    style={{ background: '#1e66f5', whiteSpace: 'nowrap' }}
                  >
                    Save Price
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/*  REFRESH ALL PRICES                                           */}
      {/* ============================================================ */}
      <div className="cb-card" style={{ padding: '20px' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 700 }}>Refresh All Prices</h2>
        <p style={{ color: '#666', fontSize: '14px', margin: '0 0 16px' }}>
          Update prices for all products with Walmart links
        </p>

        {refreshing && refreshProgress && (
          <div style={{ marginBottom: '16px' }}>
            <div
              style={{
                height: '8px',
                backgroundColor: '#e0e0e0',
                borderRadius: '4px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(() => {
                    const parts = refreshProgress.split('/');
                    const current = parseInt(parts[0] || '0');
                    const total = parseInt(parts[1] || '1');
                    return total > 0 ? (current / total) * 100 : 0;
                  })()}%`,
                  backgroundColor: '#4caf50',
                  transition: 'width 0.3s',
                }}
              />
            </div>
            <div style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>Progress: {refreshProgress}</div>
          </div>
        )}

        <button
          className="cb-primary-btn"
          data-testid="refresh-all-btn"
          onClick={refreshAllPrices}
          disabled={refreshing}
          style={{ background: '#1e66f5', padding: '12px 20px', fontSize: '15px' }}
        >
          {refreshing ? `Refreshing ${refreshProgress}...` : 'Start Price Update'}
        </button>
      </div>
    </ChefLayout>
  );
}
