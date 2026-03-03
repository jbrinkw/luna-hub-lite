import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function searchWalmart(query: string, storeId?: string) {
  const serpApiKey = Deno.env.get('SERPAPI_KEY')
  if (!serpApiKey) throw new Error('SERPAPI_KEY not configured')

  const params = new URLSearchParams({
    api_key: serpApiKey,
    engine: 'walmart',
    query,
    sort: 'best_match',
  })
  if (storeId) params.set('store_id', storeId)

  const resp = await fetch(`https://serpapi.com/search.json?${params}`)
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`SerpApi HTTP ${resp.status}: ${text}`)
  }

  const json = await resp.json()
  return (json.organic_results || []).slice(0, 6).map((item: any) => {
    const offer = item.primary_offer || {}
    const pricePerUnit = item.price_per_unit
    return {
      url: item.product_page_url || item.link || '',
      title: item.title || item.name || null,
      price: offer.offer_price
        ? parseFloat(offer.offer_price)
        : item.price
          ? parseFloat(item.price)
          : null,
      price_per_unit:
        typeof pricePerUnit === 'object' ? pricePerUnit.amount : null,
      image_url: item.thumbnail || null,
    }
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    // JWT auth
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Missing authorization header' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return jsonResponse({ error: 'Invalid token' }, 401)
    }

    // Parse body
    const { barcode, search_term, store_id } = await req.json()
    if (!barcode && !search_term) {
      return jsonResponse({ error: 'barcode or search_term required' }, 400)
    }

    const query = barcode ? String(barcode) : String(search_term)
    const results = await searchWalmart(query, store_id)

    return jsonResponse({
      success: true,
      query,
      store_id: store_id || null,
      results,
    })
  } catch (error: any) {
    console.error('walmart-scrape error:', error)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
})
