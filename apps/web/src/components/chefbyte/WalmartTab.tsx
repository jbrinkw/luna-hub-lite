import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/shared/auth/AuthProvider';
import { supabase, chefbyte } from '@/shared/supabase';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WalmartOption {
  url: string;
  title: string | null;
  price: number | null;
  image_url: string | null;
}

interface ProductWithOptions {
  product_id: string;
  name: string;
  barcode: string | null;
  options: WalmartOption[];
  selectedOption: WalmartOption | null;
  customUrl: string;
  notWalmart: boolean;
  loading: boolean;
  error: string | null;
}

interface MissingPriceProduct {
  product_id: string;
  name: string;
  walmart_link: string;
}

interface PriceResult {
  product_id: string;
  name: string;
  price: number | null;
  source: string | null; // title of matched result
  saved: boolean;
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
/*  WalmartTab                                                         */
/* ================================================================== */

export function WalmartTab() {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [missingLinksCount, setMissingLinksCount] = useState<number>(0);
  const [missingPricesCount, setMissingPricesCount] = useState<number>(0);
  const [products, setProducts] = useState<ProductWithOptions[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [priceFinding, setPriceFinding] = useState(false);
  const [priceResults, setPriceResults] = useState<PriceResult[]>([]);
  const [priceProgress, setPriceProgress] = useState('');

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  const loadData = useCallback(async () => {
    if (!userId) return;

    // Count products missing Walmart links (not placeholders)
    const { count: noLinkCount } = await chefbyte()
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_placeholder', false)
      .is('walmart_link', null);

    setMissingLinksCount(noLinkCount ?? 0);

    // Missing Prices: products WITH a walmart_link but NO price
    const { count: noPriceCount } = await chefbyte()
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('price', null)
      .not('walmart_link', 'is', null)
      .neq('walmart_link', 'NOT_ON_WALMART');

    setMissingPricesCount(noPriceCount ?? 0);

    setLoading(false);
  }, [userId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const [error, setError] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Load Next 5 Products + Search                                    */
  /* ---------------------------------------------------------------- */

  const loadNext5Products = async () => {
    if (!userId) return;
    setSearchLoading(true);
    setProducts([]);
    setError(null);

    try {
      // Get up to 5 products missing walmart links
      const { data: rawProducts } = await chefbyte()
        .from('products')
        .select('product_id, name, barcode')
        .eq('user_id', userId)
        .eq('is_placeholder', false)
        .is('walmart_link', null)
        .limit(5);

      if (!rawProducts || rawProducts.length === 0) {
        setSearchLoading(false);
        return;
      }

      // Initialize with loading state
      const initial: ProductWithOptions[] = rawProducts.map((p: any) => ({
        product_id: p.product_id,
        name: p.name,
        barcode: p.barcode,
        options: [],
        selectedOption: null,
        customUrl: '',
        notWalmart: false,
        loading: true,
        error: null,
      }));
      setProducts(initial);

      // Fetch search results for each product in parallel via edge function
      const enriched = await Promise.all(
        initial.map(async (p) => {
          try {
            const { data, error: fnError } = await supabase.functions.invoke('walmart-scrape', {
              body: { search_term: p.name },
            });

            if (fnError) throw new Error(fnError.message || 'Search failed');

            const raw = data?.results || [];
            // Deduplicate by URL — SerpApi can return the same product twice
            const seen = new Set<string>();
            const results = raw.filter((r: WalmartOption) => {
              if (!r.url || seen.has(r.url)) return false;
              seen.add(r.url);
              return true;
            });
            return {
              ...p,
              options: results,
              loading: false,
              error: results.length === 0 ? 'No results found' : null,
            };
          } catch (err: any) {
            return {
              ...p,
              loading: false,
              error: err.message || 'Search failed',
            };
          }
        }),
      );

      setProducts(enriched);
    } catch {
      setError('Failed to load products');
    } finally {
      setSearchLoading(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Selection handlers                                               */
  /* ---------------------------------------------------------------- */

  const selectOption = (productId: string, option: WalmartOption) => {
    setProducts((prev) =>
      prev.map((p) =>
        p.product_id === productId ? { ...p, selectedOption: option, customUrl: '', notWalmart: false } : p,
      ),
    );
  };

  const handleCustomUrlChange = (productId: string, url: string) => {
    setProducts((prev) =>
      prev.map((p) =>
        p.product_id === productId ? { ...p, customUrl: url, selectedOption: null, notWalmart: false } : p,
      ),
    );
  };

  const handleNotWalmartChange = (productId: string, checked: boolean) => {
    setProducts((prev) =>
      prev.map((p) =>
        p.product_id === productId ? { ...p, notWalmart: checked, selectedOption: null, customUrl: '' } : p,
      ),
    );
  };

  const hasSelections = products.some((p) => p.selectedOption || p.customUrl.trim() || p.notWalmart);

  /* ---------------------------------------------------------------- */
  /*  URL cleaning                                                     */
  /* ---------------------------------------------------------------- */

  const cleanWalmartUrl = (raw: string): string => {
    try {
      const match = raw.match(/^(https?:\/\/(?:www\.)?walmart\.com\/ip\/[^/]+\/\d+)/);
      return match ? match[1] : new URL(raw).origin + new URL(raw).pathname;
    } catch {
      return raw.trim();
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Complete & Update Selected                                       */
  /* ---------------------------------------------------------------- */

  const completeUpdates = async () => {
    if (!userId) return;
    setSaving(true);
    setError(null);

    try {
      for (const product of products) {
        if (product.notWalmart) {
          // Mark as NOT_ON_WALMART sentinel
          await chefbyte()
            .from('products')
            .update({ walmart_link: 'NOT_ON_WALMART' })
            .eq('product_id', product.product_id)
            .eq('user_id', userId);
        } else if (product.selectedOption) {
          // Save selected option's URL + price
          const updates: Record<string, any> = {
            walmart_link: cleanWalmartUrl(product.selectedOption.url),
          };
          if (product.selectedOption.price != null) {
            updates.price = product.selectedOption.price;
          }
          await chefbyte().from('products').update(updates).eq('product_id', product.product_id).eq('user_id', userId);
        } else if (product.customUrl.trim()) {
          // Save custom URL without price
          await chefbyte()
            .from('products')
            .update({ walmart_link: cleanWalmartUrl(product.customUrl) })
            .eq('product_id', product.product_id)
            .eq('user_id', userId);
        }
      }

      // Clear batch and refresh counts
      setProducts([]);
      await loadData();
    } catch {
      setError('Failed to save updates');
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Find Missing Prices                                              */
  /* ---------------------------------------------------------------- */

  const findMissingPrices = async () => {
    if (!userId) return;
    setPriceFinding(true);
    setPriceResults([]);
    setPriceProgress('');
    setError(null);

    try {
      // Fetch products with walmart_link but no price
      const { data: noPrices } = await chefbyte()
        .from('products')
        .select('product_id, name, walmart_link')
        .eq('user_id', userId)
        .is('price', null)
        .not('walmart_link', 'is', null)
        .neq('walmart_link', 'NOT_ON_WALMART');

      const toFind = (noPrices ?? []) as MissingPriceProduct[];

      if (toFind.length === 0) {
        setPriceFinding(false);
        return;
      }

      const results: PriceResult[] = [];
      let done = 0;

      for (const p of toFind) {
        setPriceProgress(`${done + 1}/${toFind.length}`);

        try {
          const { data, error: fnError } = await supabase.functions.invoke('walmart-scrape', {
            body: { search_term: p.name },
          });

          if (!fnError && data?.results?.length > 0) {
            // Try to match the stored walmart_link first, fall back to first result
            const match = data.results.find(
              (r: { url: string }) =>
                r.url && p.walmart_link && r.url.replace(/\?.*$/, '') === p.walmart_link.replace(/\?.*$/, ''),
            );
            const best = match || data.results[0];
            const price = best?.price ?? null;

            if (price != null) {
              await chefbyte().from('products').update({ price }).eq('product_id', p.product_id).eq('user_id', userId);
            }

            results.push({
              product_id: p.product_id,
              name: p.name,
              price,
              source: best?.title || null,
              saved: price != null,
            });
          } else {
            results.push({
              product_id: p.product_id,
              name: p.name,
              price: null,
              source: null,
              saved: false,
            });
          }
        } catch {
          results.push({
            product_id: p.product_id,
            name: p.name,
            price: null,
            source: null,
            saved: false,
          });
        }

        done++;
        setPriceResults([...results]);
      }

      await loadData();
    } catch {
      setError('Failed to find prices');
    } finally {
      setPriceFinding(false);
      setPriceProgress('');
    }
  };

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
      const { data: linked } = await chefbyte()
        .from('products')
        .select('product_id, name, walmart_link')
        .eq('user_id', userId)
        .not('walmart_link', 'is', null)
        .neq('walmart_link', 'NOT_ON_WALMART');

      const toRefresh = (linked ?? []) as Array<{
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

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <div data-testid="walmart-loading" style={{ padding: '20px', color: '#666' }}>
        Loading...
      </div>
    );
  }

  return (
    <>
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
      {/*  SEARCH & PICK — MISSING WALMART LINKS                       */}
      {/* ============================================================ */}
      <div className="card" style={{ padding: '20px', marginBottom: '24px' }}>
        <div data-testid="missing-links-section">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>
              Missing Walmart Links ({missingLinksCount})
            </h2>
            <button
              className="primary-btn"
              onClick={loadNext5Products}
              disabled={searchLoading || saving}
              data-testid="load-next-5-btn"
              style={{ background: '#1e66f5', whiteSpace: 'nowrap' }}
            >
              {searchLoading ? 'Searching Walmart...' : 'Load Next 5 Products'}
            </button>
          </div>

          {/* Loading indicator */}
          {searchLoading && (
            <div
              style={{
                padding: '40px 20px',
                textAlign: 'center',
                backgroundColor: '#e3f2fd',
                borderRadius: '8px',
                margin: '12px 0',
              }}
            >
              <div style={{ fontSize: '16px', fontWeight: 600, color: '#1976d2' }}>Searching Walmart...</div>
              <div style={{ fontSize: '14px', color: '#666', marginTop: '8px' }}>
                Fetching search results for {products.filter((p) => p.loading).length} products
              </div>
            </div>
          )}

          {/* Empty state */}
          {products.length === 0 && !searchLoading && missingLinksCount === 0 && (
            <p
              data-testid="no-missing-links"
              style={{ color: '#666', fontStyle: 'italic', padding: '20px 0', textAlign: 'center' }}
            >
              All products have Walmart links
            </p>
          )}

          {products.length === 0 && !searchLoading && missingLinksCount > 0 && (
            <p style={{ color: '#666', textAlign: 'center', padding: '20px' }}>
              Click "Load Next 5 Products" to start linking products to Walmart
            </p>
          )}

          {/* Product cards with search results */}
          {products.map((product) => (
            <div key={product.product_id} data-testid={`link-item-${product.product_id}`} style={cardStyle}>
              {/* Product header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  marginBottom: '12px',
                  flexWrap: 'wrap',
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
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '14px',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={product.notWalmart}
                    onChange={(e) => handleNotWalmartChange(product.product_id, e.target.checked)}
                    data-testid={`not-on-walmart-${product.product_id}`}
                  />
                  Not on Walmart
                </label>
              </div>

              {/* Loading state for individual product */}
              {product.loading && (
                <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>Loading options...</div>
              )}

              {/* Error state */}
              {product.error && !product.loading && (
                <div style={{ padding: '10px', color: '#d32f2f', fontSize: '14px' }}>{product.error}</div>
              )}

              {/* Options grid */}
              {!product.loading && product.options.length > 0 && !product.notWalmart && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                    gap: '12px',
                    marginBottom: '12px',
                  }}
                  data-testid={`options-grid-${product.product_id}`}
                >
                  {product.options.map((option, index) => (
                    <div
                      key={index}
                      onClick={() => selectOption(product.product_id, option)}
                      data-testid={`option-${product.product_id}-${index}`}
                      style={{
                        border: product.selectedOption?.url === option.url ? '3px solid #4caf50' : '1px solid #ddd',
                        borderRadius: '8px',
                        padding: '12px',
                        cursor: 'pointer',
                        backgroundColor: product.selectedOption?.url === option.url ? '#f0fff0' : '#fafafa',
                        transition: 'all 0.2s',
                      }}
                    >
                      {/* Radio indicator */}
                      <div
                        style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '50%',
                          border: '2px solid #4caf50',
                          marginBottom: '8px',
                          backgroundColor: product.selectedOption?.url === option.url ? '#4caf50' : 'transparent',
                        }}
                      />

                      {/* Product image */}
                      <div
                        style={{
                          width: '100%',
                          height: '100px',
                          backgroundColor: '#f5f5f5',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginBottom: '8px',
                          overflow: 'hidden',
                        }}
                      >
                        {option.image_url ? (
                          <img
                            src={option.image_url}
                            alt={option.title || 'Product'}
                            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <span style={{ color: '#999', fontSize: '12px' }}>No image</span>
                        )}
                      </div>

                      {/* Product name */}
                      <div
                        style={{
                          fontSize: '12px',
                          lineHeight: '1.3',
                          marginBottom: '6px',
                          maxHeight: '40px',
                          overflow: 'hidden',
                        }}
                      >
                        {option.title || 'Unknown Product'}
                      </div>

                      {/* Price as link */}
                      <a
                        href={option.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          color: '#2e7d32',
                          fontWeight: 600,
                          fontSize: '14px',
                          textDecoration: 'none',
                        }}
                      >
                        {option.price ? `$${option.price.toFixed(2)}` : 'Price N/A'}
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {/* Custom URL fallback */}
              {!product.notWalmart && !product.loading && (
                <div
                  style={{
                    borderTop: product.options.length > 0 ? '1px solid #eee' : 'none',
                    paddingTop: product.options.length > 0 ? '12px' : '0',
                  }}
                >
                  <label style={{ fontSize: '13px', color: '#666', display: 'block', marginBottom: '6px' }}>
                    Or paste a custom Walmart link:
                  </label>
                  <input
                    type="text"
                    value={product.customUrl}
                    onChange={(e) => handleCustomUrlChange(product.product_id, e.target.value)}
                    placeholder="https://www.walmart.com/ip/..."
                    style={{ ...inputStyle }}
                    data-testid={`url-input-${product.product_id}`}
                  />
                </div>
              )}
            </div>
          ))}

          {/* Complete & Update Selected button */}
          {hasSelections && (
            <button
              className="primary-btn"
              onClick={completeUpdates}
              disabled={saving}
              data-testid="complete-updates-btn"
              style={{
                width: '100%',
                padding: '14px',
                backgroundColor: '#4caf50',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '16px',
                fontWeight: 600,
                cursor: 'pointer',
                marginTop: '12px',
              }}
            >
              {saving ? 'Updating...' : 'Complete & Update Selected'}
            </button>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/*  MISSING PRICES                                               */}
      {/* ============================================================ */}
      <div className="card" style={{ padding: '20px', marginBottom: '24px' }}>
        <div data-testid="missing-prices-section">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px',
              flexWrap: 'wrap',
              gap: '12px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>Missing Prices ({missingPricesCount})</h2>
            <button
              className="primary-btn"
              onClick={findMissingPrices}
              disabled={priceFinding || missingPricesCount === 0}
              data-testid="find-missing-prices-btn"
              style={{ background: '#1e66f5', whiteSpace: 'nowrap' }}
            >
              {priceFinding ? `Searching ${priceProgress}...` : 'Find Missing Prices'}
            </button>
          </div>

          {missingPricesCount === 0 && priceResults.length === 0 && (
            <p
              data-testid="no-missing-prices"
              style={{ color: '#666', fontStyle: 'italic', padding: '20px 0', textAlign: 'center' }}
            >
              All linked products have prices
            </p>
          )}

          {/* Progress bar */}
          {priceFinding && priceProgress && (
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
                      const parts = priceProgress.split('/');
                      const current = parseInt(parts[0] || '0');
                      const total = parseInt(parts[1] || '1');
                      return total > 0 ? (current / total) * 100 : 0;
                    })()}%`,
                    backgroundColor: '#4caf50',
                    transition: 'width 0.3s',
                  }}
                />
              </div>
              <div style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>Progress: {priceProgress}</div>
            </div>
          )}

          {/* Results display */}
          {priceResults.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {priceResults.map((r) => (
                <div
                  key={r.product_id}
                  data-testid={`price-result-${r.product_id}`}
                  style={{
                    ...cardStyle,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '12px',
                    marginBottom: 0,
                    borderLeft: r.saved ? '4px solid #4caf50' : '4px solid #f44336',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{r.name}</div>
                    {r.source && (
                      <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>Matched: {r.source}</div>
                    )}
                  </div>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '16px',
                      color: r.saved ? '#2e7d32' : '#d32f2f',
                    }}
                  >
                    {r.price != null ? `$${r.price.toFixed(2)}` : 'Not found'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/*  REFRESH ALL PRICES                                           */}
      {/* ============================================================ */}
      <div className="card" style={{ padding: '20px' }}>
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
          className="primary-btn"
          data-testid="refresh-all-btn"
          onClick={refreshAllPrices}
          disabled={refreshing}
          style={{ background: '#1e66f5', padding: '12px 20px', fontSize: '15px' }}
        >
          {refreshing ? `Refreshing ${refreshProgress}...` : 'Start Price Update'}
        </button>
      </div>
    </>
  );
}
