// Response-normalization helpers for walmart-scrape.
//
// Extracted from index.ts so they're unit-testable in Deno isolation
// (supabase/functions/walmart-scrape/test.ts). The runtime HTTP entry
// point still lives in index.ts.

/** Canonical shape the edge function returns per product result. */
export interface WalmartResult {
  url: string;
  title: string | null;
  price: number | null;
  price_per_unit: number | null;
  image_url: string | null;
}

/**
 * Build the SerpApi search URL parameters for the Walmart engine.
 * Pure function — returns a URLSearchParams object for the caller to
 * append to the base `https://serpapi.com/search.json?` URL.
 *
 * Extracted so the test can assert:
 *   - api_key is URL-encoded correctly even when it contains special chars
 *   - store_id only appears when supplied
 *   - query gets encoded (spaces → +/%20 depending on user-agent)
 */
export function buildSearchParams(opts: { apiKey: string; query: string; storeId?: string }): URLSearchParams {
  const params = new URLSearchParams({
    api_key: opts.apiKey,
    engine: 'walmart',
    query: opts.query,
    sort: 'best_match',
  });
  if (opts.storeId) params.set('store_id', opts.storeId);
  return params;
}

/**
 * Build the full SerpApi URL for a search. Thin wrapper around
 * buildSearchParams — exists so callers and tests see the same final URL
 * string.
 */
export function buildSerpApiUrl(opts: { apiKey: string; query: string; storeId?: string }): string {
  return `https://serpapi.com/search.json?${buildSearchParams(opts).toString()}`;
}

/**
 * Normalize a SerpApi `search.json` response body (already parsed JSON)
 * into the canonical result shape. Takes up to 6 items from
 * `organic_results`. Malformed / missing organic_results → [].
 *
 * Never throws — a malformed SerpApi body becomes an empty result list
 * rather than a 500. The HTTP handler still returns 503 on upstream 5xx
 * or unparseable body (those cases are detected upstream of this call).
 */
export function normalizeSerpApiResponse(json: unknown): WalmartResult[] {
  if (!json || typeof json !== 'object') return [];
  const body = json as Record<string, unknown>;
  const rawResults = Array.isArray(body.organic_results) ? body.organic_results : [];
  const results: WalmartResult[] = [];
  for (const item of rawResults.slice(0, 6)) {
    if (!item || typeof item !== 'object') continue;
    results.push(normalizeResultItem(item as Record<string, unknown>));
  }
  return results;
}

/**
 * Normalize a single SerpApi organic_results item. Exported for tests
 * that want to isolate the per-item logic without building a full
 * response envelope.
 *
 * Pricing precedence matches the old inline code:
 *   1. `primary_offer.offer_price` (parsed as float)
 *   2. top-level `price` field (parsed as float)
 *   3. null
 *
 * Title precedence: `title` → `name` → null.
 * price_per_unit: only the nested `{ amount }` shape — string form ignored.
 */
export function normalizeResultItem(item: Record<string, unknown>): WalmartResult {
  const offer = (item.primary_offer as Record<string, unknown> | undefined) ?? {};
  const pricePerUnit = item.price_per_unit;

  const price =
    offer.offer_price != null
      ? parseFloat(String(offer.offer_price))
      : item.price != null
        ? parseFloat(String(item.price))
        : null;

  const ppuObj = pricePerUnit && typeof pricePerUnit === 'object' ? (pricePerUnit as Record<string, unknown>) : null;
  const ppuAmount = ppuObj?.amount != null ? Number(ppuObj.amount) : null;

  const urlCandidate = (item.product_page_url ?? item.link ?? '') as unknown;
  const titleCandidate = (item.title ?? item.name ?? null) as unknown;
  const imageCandidate = (item.thumbnail ?? null) as unknown;

  return {
    url: typeof urlCandidate === 'string' ? urlCandidate : '',
    title: typeof titleCandidate === 'string' ? titleCandidate : null,
    price: Number.isFinite(price as number) ? (price as number) : null,
    price_per_unit: Number.isFinite(ppuAmount as number) ? (ppuAmount as number) : null,
    image_url: typeof imageCandidate === 'string' ? imageCandidate : null,
  };
}
