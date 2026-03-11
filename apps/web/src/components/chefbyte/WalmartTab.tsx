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
/*  Reusable Tailwind class strings                                    */
/* ------------------------------------------------------------------ */

const inputCls =
  'w-full px-3 py-2.5 border border-slate-300 rounded-md text-sm box-border focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500';
const cardCls = 'border border-slate-200 rounded-lg p-4 mb-4 bg-white';
const primaryBtnCls =
  'bg-emerald-600 text-white border-none px-4 py-2.5 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed';

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

  /* ---------------------------------------------------------------- */
  /*  Progress bar helper                                              */
  /* ---------------------------------------------------------------- */

  const progressPercent = (progress: string): number => {
    const parts = progress.split('/');
    const current = parseInt(parts[0] || '0');
    const total = parseInt(parts[1] || '1');
    return total > 0 ? (current / total) * 100 : 0;
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <div data-testid="walmart-loading" className="p-5 text-slate-500">
        Loading...
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="m-0 text-2xl font-bold text-slate-900">Walmart Price Manager</h1>
        <p className="mt-2 mb-0 text-slate-500 text-sm">Link products to Walmart and manage pricing</p>
      </div>

      {error && <p className="text-red-600 bg-red-50 px-3.5 py-2.5 rounded-md border border-red-200 mb-4">{error}</p>}

      {/* ============================================================ */}
      {/*  SEARCH & PICK — MISSING WALMART LINKS                       */}
      {/* ============================================================ */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 mb-6">
        <div data-testid="missing-links-section">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
            <h2 className="m-0 text-lg font-bold">Missing Walmart Links ({missingLinksCount})</h2>
            <button
              className={`${primaryBtnCls} whitespace-nowrap`}
              onClick={loadNext5Products}
              disabled={searchLoading || saving}
              data-testid="load-next-5-btn"
            >
              {searchLoading ? 'Searching Walmart...' : 'Load Next 5 Products'}
            </button>
          </div>

          {/* Loading indicator */}
          {searchLoading && (
            <div className="py-10 px-5 text-center bg-emerald-50 rounded-lg my-3">
              <div className="text-base font-semibold text-emerald-700">Searching Walmart...</div>
              <div className="text-sm text-slate-500 mt-2">
                Fetching search results for {products.filter((p) => p.loading).length} products
              </div>
            </div>
          )}

          {/* Empty state */}
          {products.length === 0 && !searchLoading && missingLinksCount === 0 && (
            <p data-testid="no-missing-links" className="text-slate-500 italic py-5 text-center">
              All products have Walmart links
            </p>
          )}

          {products.length === 0 && !searchLoading && missingLinksCount > 0 && (
            <p className="text-slate-500 text-center py-5">
              Click "Load Next 5 Products" to start linking products to Walmart
            </p>
          )}

          {/* Product cards with search results */}
          {products.map((product) => (
            <div key={product.product_id} data-testid={`link-item-${product.product_id}`} className={cardCls}>
              {/* Product header */}
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <span className="flex-1 font-semibold text-base">{product.name}</span>
                {product.barcode && <span className="text-[13px] text-slate-500">({product.barcode})</span>}
                <a
                  href={`https://www.walmart.com/search?q=${encodeURIComponent(product.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 no-underline text-sm hover:underline"
                >
                  Search Walmart
                </a>
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
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
              {product.loading && <div className="py-5 text-center text-slate-500">Loading options...</div>}

              {/* Error state */}
              {product.error && !product.loading && <div className="p-2.5 text-red-600 text-sm">{product.error}</div>}

              {/* Options grid */}
              {!product.loading && product.options.length > 0 && !product.notWalmart && (
                <div
                  className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 mb-3"
                  data-testid={`options-grid-${product.product_id}`}
                >
                  {product.options.map((option, index) => {
                    const isSelected = product.selectedOption?.url === option.url;
                    return (
                      <div
                        key={index}
                        onClick={() => selectOption(product.product_id, option)}
                        data-testid={`option-${product.product_id}-${index}`}
                        className={`rounded-lg p-3 cursor-pointer transition-all ${
                          isSelected
                            ? 'border-[3px] border-green-500 bg-green-50'
                            : 'border border-slate-200 bg-slate-50 hover:border-slate-300'
                        }`}
                      >
                        {/* Radio indicator */}
                        <div
                          className={`w-[18px] h-[18px] rounded-full border-2 border-green-500 mb-2 ${
                            isSelected ? 'bg-green-500' : 'bg-transparent'
                          }`}
                        />

                        {/* Product image */}
                        <div className="w-full h-[100px] bg-slate-100 rounded flex items-center justify-center mb-2 overflow-hidden">
                          {option.image_url ? (
                            <img
                              src={option.image_url}
                              alt={option.title || 'Product'}
                              className="max-w-full max-h-full object-contain"
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <span className="text-slate-400 text-xs">No image</span>
                          )}
                        </div>

                        {/* Product name */}
                        <div className="text-xs leading-tight mb-1.5 max-h-10 overflow-hidden">
                          {option.title || 'Unknown Product'}
                        </div>

                        {/* Price as link */}
                        <a
                          href={option.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-green-700 font-semibold text-sm no-underline hover:underline"
                        >
                          {option.price ? `$${option.price.toFixed(2)}` : 'Price N/A'}
                        </a>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Custom URL fallback */}
              {!product.notWalmart && !product.loading && (
                <div className={product.options.length > 0 ? 'border-t border-slate-100 pt-3' : ''}>
                  <label className="text-[13px] text-slate-500 block mb-1.5">Or paste a custom Walmart link:</label>
                  <input
                    type="text"
                    value={product.customUrl}
                    onChange={(e) => handleCustomUrlChange(product.product_id, e.target.value)}
                    placeholder="https://www.walmart.com/ip/..."
                    className={inputCls}
                    data-testid={`url-input-${product.product_id}`}
                  />
                </div>
              )}
            </div>
          ))}

          {/* Complete & Update Selected button */}
          {hasSelections && (
            <button
              className="w-full py-3.5 bg-green-500 text-white border-none rounded-md text-base font-semibold cursor-pointer mt-3 hover:bg-green-600 disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={completeUpdates}
              disabled={saving}
              data-testid="complete-updates-btn"
            >
              {saving ? 'Updating...' : 'Complete & Update Selected'}
            </button>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/*  MISSING PRICES                                               */}
      {/* ============================================================ */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 mb-6">
        <div data-testid="missing-prices-section">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
            <h2 className="m-0 text-lg font-bold">Missing Prices ({missingPricesCount})</h2>
            <button
              className={`${primaryBtnCls} whitespace-nowrap`}
              onClick={findMissingPrices}
              disabled={priceFinding || missingPricesCount === 0}
              data-testid="find-missing-prices-btn"
            >
              {priceFinding ? `Searching ${priceProgress}...` : 'Find Missing Prices'}
            </button>
          </div>

          {missingPricesCount === 0 && priceResults.length === 0 && (
            <p data-testid="no-missing-prices" className="text-slate-500 italic py-5 text-center">
              All linked products have prices
            </p>
          )}

          {/* Progress bar */}
          {priceFinding && priceProgress && (
            <div className="mb-4">
              <div className="h-2 bg-slate-200 rounded overflow-hidden">
                <div
                  className="h-full bg-green-500 transition-[width] duration-300"
                  style={{ width: `${progressPercent(priceProgress)}%` }}
                />
              </div>
              <div className="text-[13px] text-slate-500 mt-1.5">Progress: {priceProgress}</div>
            </div>
          )}

          {/* Results display */}
          {priceResults.length > 0 && (
            <div className="flex flex-col gap-2">
              {priceResults.map((r) => (
                <div
                  key={r.product_id}
                  data-testid={`price-result-${r.product_id}`}
                  className={`${cardCls} flex justify-between items-center gap-3 !mb-0 ${
                    r.saved ? 'border-l-4 border-l-green-500' : 'border-l-4 border-l-red-500'
                  }`}
                >
                  <div className="flex-1">
                    <div className="font-medium">{r.name}</div>
                    {r.source && <div className="text-xs text-slate-500 mt-0.5">Matched: {r.source}</div>}
                  </div>
                  <div className={`font-semibold text-base ${r.saved ? 'text-green-700' : 'text-red-600'}`}>
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
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
        <h2 className="m-0 mb-4 text-lg font-bold">Refresh All Prices</h2>
        <p className="text-slate-500 text-sm m-0 mb-4">Update prices for all products with Walmart links</p>

        {refreshing && refreshProgress && (
          <div className="mb-4">
            <div className="h-2 bg-slate-200 rounded overflow-hidden">
              <div
                className="h-full bg-green-500 transition-[width] duration-300"
                style={{ width: `${progressPercent(refreshProgress)}%` }}
              />
            </div>
            <div className="text-[13px] text-slate-500 mt-1.5">Progress: {refreshProgress}</div>
          </div>
        )}

        <button
          className={`${primaryBtnCls} py-3 px-5 text-[15px]`}
          data-testid="refresh-all-btn"
          onClick={refreshAllPrices}
          disabled={refreshing}
        >
          {refreshing ? `Refreshing ${refreshProgress}...` : 'Start Price Update'}
        </button>
      </div>
    </>
  );
}
