// Deno unit tests for the walmart-scrape helpers.
//
// Run with:
//   deno test supabase/functions/walmart-scrape/test.ts
//
// Isolates the SerpApi URL builder + response normalizer. Integration
// coverage for the full HTTP handler lives at:
//   apps/web/src/__tests__/integration/edge-functions/walmart.test.ts
// (CORS preflight) and the failure-path tests added in earlier audits.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildSearchParams,
  buildSerpApiUrl,
  normalizeResultItem,
  normalizeSerpApiResponse,
} from './_normalize.ts';

// ─────────────────────────────────────────────────────────────────────────
// SerpApi URL builder
// ─────────────────────────────────────────────────────────────────────────

Deno.test('buildSearchParams: required fields are always present', () => {
  const params = buildSearchParams({ apiKey: 'abc123', query: 'chicken' });
  assertEquals(params.get('api_key'), 'abc123');
  assertEquals(params.get('engine'), 'walmart');
  assertEquals(params.get('query'), 'chicken');
  assertEquals(params.get('sort'), 'best_match');
  assertEquals(params.has('store_id'), false, 'store_id absent when not supplied');
});

Deno.test('buildSearchParams: store_id included when supplied', () => {
  const params = buildSearchParams({ apiKey: 'abc', query: 'rice', storeId: '3081' });
  assertEquals(params.get('store_id'), '3081');
});

Deno.test('buildSearchParams: query with special characters URL-encodes correctly', () => {
  const params = buildSearchParams({ apiKey: 'abc', query: 'organic tomato & basil sauce' });
  const serialized = params.toString();
  // URLSearchParams encodes space as '+' and & as %26
  assert(
    serialized.includes('query=organic+tomato+%26+basil+sauce') ||
      serialized.includes('query=organic%20tomato%20%26%20basil%20sauce'),
    `expected query to be URL-encoded, got: ${serialized}`,
  );
});

Deno.test('buildSearchParams: api_key with special characters is URL-encoded', () => {
  const params = buildSearchParams({ apiKey: 'abc+123/def=xyz', query: 'q' });
  const serialized = params.toString();
  // `+`, `/`, `=` must all be encoded so the upstream parses the key correctly
  assert(
    serialized.includes('api_key=abc%2B123%2Fdef%3Dxyz'),
    `expected api_key encoded, got: ${serialized}`,
  );
});

Deno.test('buildSerpApiUrl: returns a full https URL on serpapi.com/search.json', () => {
  const url = buildSerpApiUrl({ apiKey: 'abc', query: 'milk', storeId: '1234' });
  assert(url.startsWith('https://serpapi.com/search.json?'), `bad prefix: ${url}`);
  assert(url.includes('api_key=abc'));
  assert(url.includes('query=milk'));
  assert(url.includes('store_id=1234'));
});

// ─────────────────────────────────────────────────────────────────────────
// Response normalizer — canonical shape
// ─────────────────────────────────────────────────────────────────────────

Deno.test('normalizeSerpApiResponse: maps a canonical SerpApi body', () => {
  const body = {
    organic_results: [
      {
        title: 'Great Value Milk',
        product_page_url: 'https://walmart.com/ip/gv-milk/123',
        primary_offer: { offer_price: '3.48' },
        price_per_unit: { amount: 0.87, unit: 'quart' },
        thumbnail: 'https://i5.walmartimages.com/gv-milk.jpg',
      },
    ],
  };
  const results = normalizeSerpApiResponse(body);
  assertEquals(results.length, 1);
  assertEquals(results[0], {
    url: 'https://walmart.com/ip/gv-milk/123',
    title: 'Great Value Milk',
    price: 3.48,
    price_per_unit: 0.87,
    image_url: 'https://i5.walmartimages.com/gv-milk.jpg',
  });
});

Deno.test('normalizeSerpApiResponse: caps results at 6 items', () => {
  const body = {
    organic_results: Array.from({ length: 12 }, (_, i) => ({
      title: `Item ${i}`,
      product_page_url: `https://walmart.com/ip/item-${i}/${i}`,
      primary_offer: { offer_price: String(i + 1) },
    })),
  };
  const results = normalizeSerpApiResponse(body);
  assertEquals(results.length, 6, 'only first 6 results are kept');
  assertEquals(results[0].title, 'Item 0');
  assertEquals(results[5].title, 'Item 5');
});

Deno.test('normalizeResultItem: price precedence — offer_price beats top-level price', () => {
  const item = {
    title: 'X',
    product_page_url: 'https://walmart.com/ip/x/1',
    primary_offer: { offer_price: '9.99' },
    price: '12.99', // should be ignored when offer_price is present
  };
  assertEquals(normalizeResultItem(item).price, 9.99);
});

Deno.test('normalizeResultItem: falls back to top-level price when offer_price missing', () => {
  const item = {
    title: 'X',
    product_page_url: 'https://walmart.com/ip/x/1',
    price: '4.50',
  };
  assertEquals(normalizeResultItem(item).price, 4.5);
});

Deno.test('normalizeResultItem: price is null when no price field present', () => {
  const item = {
    title: 'X',
    product_page_url: 'https://walmart.com/ip/x/1',
  };
  assertEquals(normalizeResultItem(item).price, null);
});

Deno.test('normalizeResultItem: title falls back to name, then null', () => {
  assertEquals(
    normalizeResultItem({ name: 'Alt Name', product_page_url: 'https://walmart.com/ip/x/1' }).title,
    'Alt Name',
  );
  assertEquals(
    normalizeResultItem({ product_page_url: 'https://walmart.com/ip/x/1' }).title,
    null,
  );
});

Deno.test('normalizeResultItem: url falls back to link, then empty string', () => {
  assertEquals(
    normalizeResultItem({ title: 'X', link: 'https://walmart.com/other/1' }).url,
    'https://walmart.com/other/1',
  );
  assertEquals(normalizeResultItem({ title: 'X' }).url, '');
});

Deno.test('normalizeResultItem: price_per_unit extracts .amount from nested object', () => {
  assertEquals(
    normalizeResultItem({
      title: 'X',
      price_per_unit: { amount: 0.12, unit: 'oz' },
    }).price_per_unit,
    0.12,
  );
});

Deno.test('normalizeResultItem: price_per_unit is null for string form (unsupported)', () => {
  // SerpApi sometimes returns a string form ("$0.12 / oz"). The old
  // inline code used `typeof === 'object'` which meant strings fell
  // through to null. Pin that behavior.
  assertEquals(
    normalizeResultItem({
      title: 'X',
      price_per_unit: '$0.12 / oz',
    }).price_per_unit,
    null,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Malformed fallback — never crash, degrade to []
// ─────────────────────────────────────────────────────────────────────────

Deno.test('normalizeSerpApiResponse: missing organic_results → []', () => {
  assertEquals(normalizeSerpApiResponse({}), []);
  assertEquals(normalizeSerpApiResponse({ search_metadata: { status: 'Success' } }), []);
});

Deno.test('normalizeSerpApiResponse: non-array organic_results → []', () => {
  assertEquals(normalizeSerpApiResponse({ organic_results: 'not-an-array' }), []);
  assertEquals(normalizeSerpApiResponse({ organic_results: null }), []);
  assertEquals(normalizeSerpApiResponse({ organic_results: { 0: 'weird' } }), []);
});

Deno.test('normalizeSerpApiResponse: null / primitive body → []', () => {
  assertEquals(normalizeSerpApiResponse(null), []);
  assertEquals(normalizeSerpApiResponse(undefined), []);
  assertEquals(normalizeSerpApiResponse('not JSON'), []);
  assertEquals(normalizeSerpApiResponse(42), []);
});

Deno.test('normalizeSerpApiResponse: skips non-object items within the array', () => {
  const body = {
    organic_results: [
      null,
      'string-item',
      42,
      { title: 'Real', product_page_url: 'https://walmart.com/ip/r/1' },
    ],
  };
  const results = normalizeSerpApiResponse(body);
  assertEquals(results.length, 1, 'only real objects are kept');
  assertEquals(results[0].title, 'Real');
});

Deno.test('normalizeSerpApiResponse: item with every optional field missing is safe', () => {
  const results = normalizeSerpApiResponse({ organic_results: [{}] });
  assertEquals(results.length, 1);
  assertEquals(results[0], {
    url: '',
    title: null,
    price: null,
    price_per_unit: null,
    image_url: null,
  });
});
